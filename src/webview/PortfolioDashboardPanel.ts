/**
 * Portfolio Dashboard Panel
 * Full-featured webview panel with charts and comprehensive analysis
 */

import * as vscode from 'vscode';
import { ProviderManager } from '../providers/ProviderManager';
import { AnalysisService, PortfolioAnalysis, StockAnalysis } from '../services/AnalysisService';

export class PortfolioDashboardPanel {
    public static readonly viewType = 'portfolioAnalyzer.dashboard';
    
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _portfolioData?: PortfolioAnalysis;
    private _onDidDisposeEmitter = new vscode.EventEmitter<void>();
    public readonly onDidDispose = this._onDidDisposeEmitter.event;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _providerManager: ProviderManager,
        private readonly _analysisService: AnalysisService
    ) {
        this._panel = vscode.window.createWebviewPanel(
            PortfolioDashboardPanel.viewType,
            '📊 Portfolio Analyzer',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this._extensionUri]
            }
        );

        this._panel.webview.html = this._getLoadingHtml();

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'refresh':
                        await this.refresh();
                        break;
                    case 'configure':
                        vscode.commands.executeCommand('portfolioAnalyzer.configureProvider');
                        break;
                    case 'exportReport':
                        this._exportReport();
                        break;
                    case 'generatePortfolioAdvice': {
                        const advice = await this._generatePortfolioAdviceWithAI(message.portfolioData);
                        this._panel.webview.postMessage({ type: 'portfolioAdviceResult', html: advice });
                        break;
                    }
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Initial load
        this.refresh();
    }

    public reveal() {
        this._panel.reveal(vscode.ViewColumn.One);
    }

    public dispose() {
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
        this._onDidDisposeEmitter.fire();
    }

    public async refresh() {
        try {
            this._panel.webview.html = this._getLoadingHtml();

            const provider = this._providerManager.getActiveProvider();
            if (!provider?.isConfigured()) {
                this._panel.webview.html = this._getNotConfiguredHtml();
                return;
            }

            // Fetch data
            const holdings = await this._providerManager.getHoldings();
            const quotes = await this._providerManager.getQuotes(holdings);

            // Analyze each stock
            const stockAnalyses: StockAnalysis[] = [];
            for (const holding of holdings) {
                const quote = quotes.get(holding.symbol);
                const fundamentals = await this._providerManager.getFundamentals(holding.symbol);
                const analysis = this._analysisService.analyzeStock(holding, quote, fundamentals);
                stockAnalyses.push(analysis);
            }

            // Get portfolio analysis
            this._portfolioData = this._analysisService.analyzePortfolio(stockAnalyses);

            // Render the full dashboard
            this._panel.webview.html = this._getHtmlForWebview(this._portfolioData);

        } catch (error: any) {
            this._panel.webview.html = this._getErrorHtml(error.message || 'Failed to load portfolio data');
        }
    }

    private async _generatePortfolioAdviceWithAI(portfolioData: any): Promise<string> {
        try {
            const models = await vscode.lm.selectChatModels({ family: 'claude' });
            const model = models[0] ?? (await vscode.lm.selectChatModels())[0];
            if (!model) {
                return '<p style="opacity:0.5">AI unavailable — no Copilot model found.</p>';
            }

            const stocks: any[] = portfolioData.stocks || [];
            const summary = portfolioData.summary;

            const holdingsSummary = stocks.map((s: any) => {
                const f = s.fundamentals || {};
                return [
                    `${s.symbol} (${s.name})`,
                    `  Current: ₹${s.currentPrice?.toFixed(2)}`,
                    `  Score: ${s.totalScore}/10  Verdict: ${s.verdict}`,
                    s.quantity > 0 ? `  Holding: ${s.quantity} shares @ avg ₹${s.avgPrice?.toFixed(2)}  P&L: ${s.profitLossPct?.toFixed(1)}%` : `  Not held — searched stock`,
                    f.pe     ? `  P/E: ${f.pe.toFixed(1)} vs Industry ${f.indPE?.toFixed(1) ?? 'N/A'}` : '',
                    f.roe    ? `  ROE: ${f.roe.toFixed(1)}%` : '',
                    f.salesGrowth3Y  !== null && f.salesGrowth3Y  !== undefined ? `  Revenue CAGR 3Y: ${f.salesGrowth3Y.toFixed(1)}%`  : '',
                    f.profitGrowth3Y !== null && f.profitGrowth3Y !== undefined ? `  Profit CAGR 3Y: ${f.profitGrowth3Y.toFixed(1)}%`  : '',
                    f.debtToEquity   !== null && f.debtToEquity   !== undefined ? `  D/E: ${f.debtToEquity.toFixed(2)}`                 : '',
                    s.high52w ? `  52W range: ₹${s.low52w?.toFixed(0)} – ₹${s.high52w?.toFixed(0)}` : '',
                ].filter(Boolean).join('\n');
            }).join('\n\n');

            const portfolioContext = summary ? [
                `Total invested: ₹${(summary.totalInvested / 100000).toFixed(1)}L`,
                `Current value: ₹${(summary.currentValue / 100000).toFixed(1)}L`,
                `Total P&L: ${summary.totalPnLPct?.toFixed(1)}%`,
                `Day P&L: ₹${(summary.dayPnL || 0).toFixed(0)}`,
            ].join('  |  ') : '';

            const prompt = `You are a friendly but sharp Indian equity advisor reviewing someone's stock portfolio. Write in a warm, direct, conversational tone — like a knowledgeable friend giving honest advice, not a formal report.

Portfolio Overview: ${portfolioContext}

Holdings:
${holdingsSummary}

Write your advice in this exact structure:

1. A 2–3 sentence "If I were managing your portfolio" opening that summarises the overall picture honestly.

2. For EACH stock, provide a dedicated block with:
   - The stock name and current price as a heading
   - One sentence on the situation (is it running hot, beaten down, fairly valued?)
   - Specific rupee price zones:
     * Aggressive buy zone (deeply undervalued, high conviction)
     * Regular add zone (good value)
     * Consider zone (reasonable entry, not great not bad)
   - One sentence of honest opinion — what you would actually do

3. A 2–3 sentence closing with any portfolio-level suggestion (concentration, cash, diversification).

Rules:
- Give EXACT rupee ranges like ₹1,550–1,650, not vague "buy on dips"
- Derive prices from the actual P/E, growth, 52W range and score data provided
- If a stock has already had a big run (P/E much above industry, near 52W high), say so clearly
- Be honest — if something looks expensive, say it

Respond in HTML using these classes for structure:
- Wrap the opening paragraph in: <div class="advice-intro">...</div>
- Each stock block: <div class="stock-block"><div class="stock-name">SYMBOL — ₹price</div>...price chips use: <span class="price-chip chip-strong">Aggressive: ₹X–Y</span> <span class="price-chip chip-add">Add: ₹X–Y</span> <span class="price-chip chip-consider">Consider: ₹X–Y</span>...</div>
- Closing paragraph as plain <p>
- Use <h3> for section breaks if needed
- Do NOT use markdown — only HTML`;

            const response = await model.sendRequest(
                [vscode.LanguageModelChatMessage.User(prompt)], {}
            );

            let html = '';
            for await (const chunk of response.stream) {
                if (chunk instanceof vscode.LanguageModelTextPart) { html += chunk.value; }
            }

            // Strip any accidental markdown code fences
            html = html.replace(/```html\n?/gi, '').replace(/```\n?/gi, '').trim();
            return html;

        } catch (e: unknown) {
            console.error('Portfolio advice AI failed:', e);
            return '<p style="opacity:0.5">Could not generate advice. Make sure GitHub Copilot is active.</p>';
        }
    }

    private _exportReport() {
        if (!this._portfolioData) return;
        
        // Create markdown report
        const report = this._generateMarkdownReport(this._portfolioData);
        
        vscode.workspace.openTextDocument({ content: report, language: 'markdown' })
            .then(doc => vscode.window.showTextDocument(doc));
    }

    private _generateMarkdownReport(data: PortfolioAnalysis): string {
        const lines = [
            '# Portfolio Analysis Report',
            `Generated: ${new Date().toLocaleString()}`,
            '',
            '## Portfolio Summary',
            `- **Total Invested:** ₹${this._formatLakhs(data.summary.totalInvested)}`,
            `- **Current Value:** ₹${this._formatLakhs(data.summary.currentValue)}`,
            `- **Total P&L:** ₹${this._formatLakhs(data.summary.totalPnL)} (${data.summary.totalPnLPct.toFixed(1)}%)`,
            `- **Average Score:** ${data.summary.avgScore.toFixed(1)}/10`,
            '',
            '## Holdings Analysis',
            ''
        ];

        for (const stock of data.stocks) {
            lines.push(`### ${stock.symbol} - ${stock.name}`);
            lines.push(`**Verdict:** ${stock.verdictEmoji} ${stock.verdict} (Score: ${stock.totalScore}/10)`);
            lines.push('');
            lines.push('| Metric | Value |');
            lines.push('|--------|-------|');
            lines.push(`| Current Price | ₹${stock.currentPrice.toFixed(2)} |`);
            lines.push(`| P&L | ${stock.profitLossPct >= 0 ? '+' : ''}${stock.profitLossPct.toFixed(1)}% |`);
            if (stock.fundamentals) {
                const f = stock.fundamentals;
                lines.push(`| P/E | ${f.pe?.toFixed(1) || 'N/A'} |`);
                lines.push(`| ROE | ${f.roe?.toFixed(1) || 'N/A'}% |`);
                lines.push(`| ROCE | ${f.roce?.toFixed(1) || 'N/A'}% |`);
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    private _formatLakhs(value: number): string {
        if (Math.abs(value) >= 10000000) {
            return (value / 10000000).toFixed(2) + ' Cr';
        } else if (Math.abs(value) >= 100000) {
            return (value / 100000).toFixed(2) + ' L';
        }
        return value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    private _getLoadingHtml(): string {
        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body { 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            height: 100vh; 
            background: #1e1e1e;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        }
        .loader {
            text-align: center;
        }
        .spinner {
            width: 50px;
            height: 50px;
            border: 4px solid #333;
            border-top-color: #007acc;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="loader">
        <div class="spinner"></div>
        <h2>📊 Loading Portfolio Data...</h2>
        <p>Fetching holdings and market data</p>
    </div>
</body>
</html>`;
    }

    private _getNotConfiguredHtml(): string {
        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body { 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            height: 100vh; 
            background: #1e1e1e;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            text-align: center;
        }
        button {
            background: #007acc;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 16px;
            margin-top: 20px;
        }
        button:hover { background: #005a9e; }
    </style>
</head>
<body>
    <div>
        <h1>🔐 Configure Your Broker</h1>
        <p>Please set up your broker credentials to view your portfolio</p>
        <button onclick="configure()">Configure Broker</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        function configure() { vscode.postMessage({ type: 'configure' }); }
    </script>
</body>
</html>`;
    }

    private _getErrorHtml(message: string): string {
        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body { 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            height: 100vh; 
            background: #1e1e1e;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            text-align: center;
        }
        .error { color: #f44336; }
        button {
            background: #007acc;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 16px;
            margin-top: 20px;
        }
    </style>
</head>
<body>
    <div>
        <h1 class="error">❌ Error</h1>
        <p>${message}</p>
        <button onclick="refresh()">Retry</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        function refresh() { vscode.postMessage({ type: 'refresh' }); }
    </script>
</body>
</html>`;
    }

    private _getHtmlForWebview(data: PortfolioAnalysis): string {
        const stocksJson = JSON.stringify(data.stocks);
        const summaryJson = JSON.stringify(data.summary);
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Portfolio Analyzer</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root {
            --bg-dark: #1a1a2e;
            --bg-card: #16213e;
            --bg-card-hover: #1f3056;
            --accent: #4ecca3;
            --accent-secondary: #7c4dff;
            --text-primary: #eef0f4;
            --text-secondary: #a0a0b0;
            --positive: #4ecca3;
            --negative: #ff6b6b;
            --warning: #ffd93d;
            --border: #2d3a5a;
        }
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
            background: var(--bg-dark);
            color: var(--text-primary);
            line-height: 1.6;
            padding: 0;
            min-height: 100vh;
        }

        /* Header */
        .header {
            background: linear-gradient(135deg, #1f3056 0%, #16213e 100%);
            padding: 24px 32px;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            position: sticky;
            top: 0;
            z-index: 100;
        }
        
        .header h1 {
            font-size: 24px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .header-actions {
            display: flex;
            gap: 12px;
        }
        
        .btn {
            background: var(--accent);
            color: #000;
            border: none;
            padding: 10px 20px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s;
        }
        
        .btn:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(78, 204, 163, 0.3); }
        .btn-secondary { background: transparent; border: 1px solid var(--border); color: var(--text-primary); }
        .btn-secondary:hover { background: var(--bg-card-hover); box-shadow: none; }
        
        /* Main Content */
        .main-content {
            max-width: 1600px;
            margin: 0 auto;
            padding: 24px 32px;
        }

        /* Summary Cards */
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 20px;
            margin-bottom: 32px;
        }
        
        .summary-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 24px;
            position: relative;
            overflow: hidden;
        }
        
        .summary-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 4px;
            background: var(--accent);
        }
        
        .summary-card.pnl-positive::before { background: var(--positive); }
        .summary-card.pnl-negative::before { background: var(--negative); }
        .summary-card.score::before { background: var(--accent-secondary); }
        
        .summary-card .label {
            font-size: 13px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 8px;
        }
        
        .summary-card .value {
            font-size: 28px;
            font-weight: 700;
        }
        
        .summary-card .sub-value {
            font-size: 14px;
            margin-top: 4px;
        }
        
        .positive { color: var(--positive); }
        .negative { color: var(--negative); }

        /* Charts Section */
        .charts-section {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 24px;
            margin-bottom: 32px;
        }
        
        .chart-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 24px;
        }
        
        .chart-card h3 {
            font-size: 16px;
            margin-bottom: 20px;
            color: var(--text-secondary);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .chart-container {
            height: 280px;
            position: relative;
        }

        /* Holdings Section */
        .holdings-section {
            margin-bottom: 32px;
        }
        
        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }
        
        .section-header h2 {
            font-size: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        /* Stock Cards */
        .stocks-grid {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
        
        .stock-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 16px;
            overflow: hidden;
            transition: all 0.3s;
        }
        
        .stock-card:hover {
            border-color: var(--accent);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }
        
        .stock-header {
            padding: 20px 24px;
            cursor: pointer;
            display: grid;
            grid-template-columns: 2fr 1fr 1fr 1fr 1.5fr;
            align-items: center;
            gap: 20px;
        }
        
        .stock-identity {
            display: flex;
            flex-direction: column;
        }
        
        .stock-symbol {
            font-size: 18px;
            font-weight: 700;
            color: var(--accent);
        }
        
        .stock-name {
            font-size: 13px;
            color: var(--text-secondary);
            margin-top: 4px;
        }
        
        .stock-sector {
            font-size: 11px;
            color: var(--accent-secondary);
            background: rgba(124, 77, 255, 0.1);
            padding: 2px 8px;
            border-radius: 4px;
            margin-top: 6px;
            display: inline-block;
        }
        
        .stock-metric {
            text-align: center;
        }
        
        .stock-metric .label {
            font-size: 11px;
            color: var(--text-secondary);
            text-transform: uppercase;
            margin-bottom: 4px;
        }
        
        .stock-metric .value {
            font-size: 16px;
            font-weight: 600;
        }
        
        .verdict-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 8px 16px;
            border-radius: 20px;
            font-weight: 600;
            font-size: 14px;
        }
        
.verdict-badge.strong-buy { background: rgba(78, 204, 163, 0.2); color: var(--positive); }
        .verdict-badge.buy { background: rgba(78, 204, 163, 0.15); color: #6dd5a0; }
        .verdict-badge.hold { background: rgba(255, 217, 61, 0.15); color: var(--warning); }
        .verdict-badge.weak-hold { background: rgba(255, 159, 67, 0.15); color: #ff9f43; }
        .verdict-badge.sell { background: rgba(255, 107, 107, 0.15); color: var(--negative); }
        
        .score-circle {
            width: 50px;
            height: 50px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 700;
            font-size: 16px;
            margin: 0 auto;
        }
        
        .score-high { background: rgba(78, 204, 163, 0.2); color: var(--positive); border: 2px solid var(--positive); }
        .score-medium { background: rgba(255, 217, 61, 0.2); color: var(--warning); border: 2px solid var(--warning); }
        .score-low { background: rgba(255, 107, 107, 0.2); color: var(--negative); border: 2px solid var(--negative); }
        
        /* Stock Details (Expanded) */
        .stock-details {
            display: none;
            border-top: 1px solid var(--border);
            padding: 24px;
            background: rgba(0, 0, 0, 0.2);
        }
        
        .stock-card.expanded .stock-details {
            display: block;
        }
        
        .details-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 24px;
        }
        
        .details-section {
            background: var(--bg-card);
            border-radius: 12px;
            padding: 20px;
        }
        
        .details-section h4 {
            font-size: 14px;
            color: var(--text-secondary);
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .details-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid var(--border);
        }
        
        .details-row:last-child { border-bottom: none; }
        .details-row .label { color: var(--text-secondary); font-size: 13px; }
        .details-row .value { font-weight: 500; font-size: 13px; }
        
        /* Score Breakdown */
        .score-breakdown {
            grid-column: span 2;
        }
        
        .score-item {
            display: grid;
            grid-template-columns: 150px 1fr 50px;
            gap: 12px;
            align-items: center;
            margin-bottom: 10px;
        }
        
        .score-item .name { font-size: 12px; color: var(--text-secondary); }
        
        .score-bar-container {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 4px;
            height: 8px;
            overflow: hidden;
        }
        
        .score-bar {
            height: 100%;
            border-radius: 4px;
            transition: width 0.5s ease;
        }
        
        .score-bar.high { background: var(--positive); }
        .score-bar.medium { background: var(--warning); }
        .score-bar.low { background: var(--negative); }
        
        .score-item .score { font-weight: 600; text-align: right; font-size: 13px; }
        
        /* Pros/Cons */
        .pros-cons-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
        }
        
        .pros h5 { color: var(--positive); margin-bottom: 12px; }
        .cons h5 { color: var(--negative); margin-bottom: 12px; }
        
        .pros-cons-list {
            list-style: none;
            font-size: 12px;
        }
        
        .pros-cons-list li {
            padding: 6px 0 6px 20px;
            position: relative;
        }
        
        .pros-cons-list li::before {
            position: absolute;
            left: 0;
            font-size: 14px;
        }
        
        .pros .pros-cons-list li::before { content: "✓"; color: var(--positive); }
        .cons .pros-cons-list li::before { content: "✗"; color: var(--negative); }

        /* AI Advisor Section */
        .advisor-section {
            background: var(--bg-card);
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 24px;
            border: 1px solid rgba(124,77,255,0.25);
        }
        .advisor-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 16px;
            margin-bottom: 16px;
        }
        .advisor-header h2 { margin: 0 0 4px; font-size: 18px; }
        .advisor-subtitle { font-size: 12px; opacity: 0.6; margin: 0; }
        .advisor-btn {
            flex-shrink: 0;
            padding: 8px 20px;
            background: rgba(124,77,255,0.2);
            color: #b39dff;
            border: 1px solid rgba(124,77,255,0.45);
            border-radius: 8px;
            cursor: pointer;
            font-size: 13px;
            white-space: nowrap;
        }
        .advisor-btn:hover { background: rgba(124,77,255,0.35); }
        .advisor-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .advisor-loading {
            display: flex; align-items: center; gap: 10px;
            font-size: 13px; opacity: 0.6; padding: 12px 0;
        }
        .advisor-spinner {
            width: 16px; height: 16px; border-radius: 50%;
            border: 2px solid rgba(255,255,255,0.15);
            border-top-color: #b39dff;
            animation: spin 0.8s linear infinite; flex-shrink: 0;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .advisor-result { font-size: 13px; line-height: 1.7; }
        .advisor-result h3 { color: #b39dff; margin: 20px 0 8px; font-size: 15px; }
        .advisor-result h4 { margin: 14px 0 6px; font-size: 13px; opacity: 0.85; }
        .advisor-result ul { margin: 6px 0 6px 18px; padding: 0; }
        .advisor-result li { margin-bottom: 4px; }
        .advisor-result .advice-intro {
            background: rgba(124,77,255,0.1);
            border-left: 3px solid #7c4dff;
            padding: 12px 16px;
            border-radius: 0 8px 8px 0;
            margin-bottom: 16px;
            font-style: italic;
        }
        .advisor-result .stock-block {
            background: rgba(255,255,255,0.03);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 14px 16px;
            margin-bottom: 12px;
        }
        .advisor-result .stock-block .stock-name {
            font-weight: 700; font-size: 14px; margin-bottom: 6px;
        }
        .advisor-result .price-row {
            display: flex; gap: 10px; flex-wrap: wrap; margin: 8px 0;
        }
        .advisor-result .price-chip {
            padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600;
        }
        .chip-strong  { background: rgba(78,204,163,0.2); color: #4ecca3; }
        .chip-add     { background: rgba(91,192,235,0.2); color: #5bc0eb; }
        .chip-consider{ background: rgba(255,217,61,0.2);  color: #ffd93d; }

        /* Methodology Section */
        .methodology-section {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 32px;
            margin-top: 32px;
        }
        
        .methodology-section h2 {
            margin-bottom: 24px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .methodology-grid {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 32px;
        }
        
        .weights-table {
            width: 100%;
            border-collapse: collapse;
        }
        
        .weights-table th, .weights-table td {
            padding: 12px 16px;
            text-align: left;
            border-bottom: 1px solid var(--border);
        }
        
        .weights-table th {
            color: var(--text-secondary);
            font-weight: 500;
            font-size: 12px;
            text-transform: uppercase;
        }
        
        .weights-table td { font-size: 14px; }
        .weights-table td:nth-child(2) { color: var(--accent); font-weight: 600; }
        
        .verdicts-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        
        .verdict-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 16px;
            background: rgba(255, 255, 255, 0.03);
            border-radius: 8px;
        }
        
        .verdict-item .emoji { font-size: 20px; }
        .verdict-item .name { font-weight: 600; flex: 1; }
        .verdict-item .threshold { color: var(--text-secondary); font-size: 13px; }

        /* Footer */
        .footer {
            text-align: center;
            padding: 24px;
            color: var(--text-secondary);
            font-size: 12px;
            border-top: 1px solid var(--border);
            margin-top: 40px;
        }
        
        /* Responsive */
        @media (max-width: 1200px) {
            .summary-grid { grid-template-columns: repeat(2, 1fr); }
            .charts-section { grid-template-columns: 1fr; }
            .details-grid { grid-template-columns: repeat(2, 1fr); }
            .score-breakdown { grid-column: span 2; }
        }
        
        @media (max-width: 800px) {
            .summary-grid { grid-template-columns: 1fr; }
            .stock-header { grid-template-columns: 1fr 1fr; }
            .methodology-grid { grid-template-columns: 1fr; }
        }
        
        /* Expand/Collapse Icon */
        .expand-icon {
            transition: transform 0.3s;
            font-size: 12px;
            color: var(--text-secondary);
        }
        
        .stock-card.expanded .expand-icon {
            transform: rotate(180deg);
        }
    </style>
</head>
<body>
    <header class="header">
        <h1>📊 Portfolio Analyzer</h1>
        <div class="header-actions">
            <button class="btn btn-secondary" onclick="exportReport()">📄 Export Report</button>
            <button class="btn btn-secondary" onclick="configure()">⚙️ Configure</button>
            <button class="btn" onclick="refresh()">🔄 Refresh</button>
        </div>
    </header>
    
    <main class="main-content">
        <!-- Summary Cards -->
        <div class="summary-grid" id="summary-grid"></div>
        
        <!-- Charts -->
        <div class="charts-section">
            <div class="chart-card">
                <h3>📊 Portfolio Allocation</h3>
                <div class="chart-container">
                    <canvas id="allocationChart"></canvas>
                </div>
            </div>
            <div class="chart-card">
                <h3>📈 P&L by Stock</h3>
                <div class="chart-container">
                    <canvas id="pnlChart"></canvas>
                </div>
            </div>
        </div>
        
        <!-- Holdings -->
        <section class="holdings-section">
            <div class="section-header">
                <h2>📋 Holdings Analysis</h2>
                <span style="color: var(--text-secondary);">Click any stock for detailed breakdown</span>
            </div>
            <div class="stocks-grid" id="stocks-grid"></div>
        </section>
        
        <!-- AI Portfolio Advisor -->
        <section class="advisor-section">
            <div class="advisor-header">
                <div>
                    <h2>🤖 AI Portfolio Advisor</h2>
                    <p class="advisor-subtitle">Personalised buy zone recommendations for each holding based on current valuations, scores and your portfolio composition.</p>
                </div>
                <button class="advisor-btn" id="advisorBtn" onclick="requestPortfolioAdvice()">✨ Get Advice</button>
            </div>
            <div id="advisorResult" class="advisor-result" style="display:none"></div>
            <div id="advisorLoading" class="advisor-loading" style="display:none">
                <span class="advisor-spinner"></span> Analysing your portfolio…
            </div>
        </section>

        <!-- Methodology -->
        <section class="methodology-section">
            <h2>📖 Scoring Methodology</h2>
            <div class="methodology-grid">
                <div>
                    <table class="weights-table">
                        <thead>
                            <tr>
                                <th>Category</th>
                                <th>Weight</th>
                                <th>What It Measures</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr><td>Revenue Growth</td><td>15%</td><td>3Y & 5Y Sales CAGR</td></tr>
                            <tr><td>Profit Growth</td><td>15%</td><td>3Y & 5Y Profit CAGR</td></tr>
                            <tr><td>Balance Sheet</td><td>10%</td><td>Debt/Equity ratio</td></tr>
                            <tr><td>Cash Flow</td><td>10%</td><td>Profit consistency</td></tr>
                            <tr><td>Management</td><td>10%</td><td>Promoter holding %</td></tr>
                            <tr><td>Industry</td><td>10%</td><td>Sector growth potential</td></tr>
                            <tr><td>Moat</td><td>10%</td><td>ROCE + ROE average</td></tr>
                            <tr><td>Valuation</td><td>10%</td><td>PE vs Industry, P/B</td></tr>
                            <tr><td>Capital Allocation</td><td>5%</td><td>ROE + Dividend yield</td></tr>
                            <tr><td>Risk Level</td><td>5%</td><td>Beta (volatility)</td></tr>
                        </tbody>
                    </table>
                </div>
                <div>
                    <h3 style="margin-bottom: 16px; color: var(--text-secondary);">Verdict Thresholds</h3>
                    <div class="verdicts-list">
<div class="verdict-item"><span class="emoji">🚀</span><span class="name">STRONG BUY</span><span class="threshold">Score ≥ 8.0</span></div>
                        <div class="verdict-item"><span class="emoji">📈</span><span class="name">BUY</span><span class="threshold">Score ≥ 7.0</span></div>
                        <div class="verdict-item"><span class="emoji">📊</span><span class="name">HOLD</span><span class="threshold">Score ≥ 6.0</span></div>
                        <div class="verdict-item"><span class="emoji">⚠️</span><span class="name">WEAK HOLD</span><span class="threshold">Score ≥ 5.0</span></div>
                        <div class="verdict-item"><span class="emoji">📉</span><span class="name">SELL</span><span class="threshold">Score &lt; 5.0</span></div>
                    </div>
                </div>
            </div>
        </section>
    </main>
    
    <footer class="footer">
        Report generated on ${new Date().toLocaleString()} | Data sources: IndMoney, Tickertape, Screener.in
    </footer>

    <script>
        const vscode = acquireVsCodeApi();
        const stocks = ${stocksJson};
        const summary = ${summaryJson};
        
        function refresh() { vscode.postMessage({ type: 'refresh' }); }
        function configure() { vscode.postMessage({ type: 'configure' }); }
        function exportReport() { vscode.postMessage({ type: 'exportReport' }); }

        function requestPortfolioAdvice() {
            document.getElementById('advisorBtn').disabled = true;
            document.getElementById('advisorLoading').style.display = 'flex';
            document.getElementById('advisorResult').style.display = 'none';
            vscode.postMessage({ type: 'generatePortfolioAdvice', portfolioData: { stocks, summary } });
        }

        window.addEventListener('message', function(event) {
            const msg = event.data;
            if (msg.type === 'portfolioAdviceResult') {
                document.getElementById('advisorLoading').style.display = 'none';
                document.getElementById('advisorBtn').disabled = false;
                const result = document.getElementById('advisorResult');
                result.style.display = 'block';
                result.innerHTML = msg.html;
            }
        });
        
        function formatCurrency(value) {
            if (Math.abs(value) >= 10000000) return '₹' + (value / 10000000).toFixed(2) + ' Cr';
            if (Math.abs(value) >= 100000) return '₹' + (value / 100000).toFixed(2) + ' L';
            return '₹' + value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
        }
        
        function formatPercent(val) {
            if (val == null) return 'N/A';
            return val.toFixed(1) + '%';
        }
        
        function getScoreClass(score) {
            if (score >= 7) return 'high';
            if (score >= 5) return 'medium';
            return 'low';
        }
        
        function getVerdictClass(verdict) {
            const v = verdict.toLowerCase();
if (v.includes('strong')) return 'strong-buy';
            if (v.includes('buy')) return 'buy';
            if (v.includes('weak')) return 'weak-hold';
            if (v.includes('hold')) return 'hold';
            return 'sell';
        }
        
        function toggleStock(symbol) {
            const card = document.querySelector(\`[data-symbol="\${symbol}"]\`);
            card.classList.toggle('expanded');
        }
        
        // Render Summary
        function renderSummary() {
            const pnlClass = summary.totalPnLPct >= 0 ? 'pnl-positive' : 'pnl-negative';
            document.getElementById('summary-grid').innerHTML = \`
                <div class="summary-card">
                    <div class="label">Total Invested</div>
                    <div class="value">\${formatCurrency(summary.totalInvested)}</div>
                </div>
                <div class="summary-card">
                    <div class="label">Current Value</div>
                    <div class="value">\${formatCurrency(summary.currentValue)}</div>
                </div>
                <div class="summary-card \${pnlClass}">
                    <div class="label">Total P&L</div>
                    <div class="value \${summary.totalPnLPct >= 0 ? 'positive' : 'negative'}">\${formatCurrency(summary.totalPnL)}</div>
                    <div class="sub-value \${summary.totalPnLPct >= 0 ? 'positive' : 'negative'}">\${summary.totalPnLPct >= 0 ? '+' : ''}\${summary.totalPnLPct.toFixed(1)}%</div>
                </div>
                <div class="summary-card score">
                    <div class="label">Portfolio Score</div>
                    <div class="value">\${summary.avgScore.toFixed(1)}<span style="font-size: 16px; color: var(--text-secondary);">/10</span></div>
                    <div class="sub-value">\${stocks.length} stocks analyzed</div>
                </div>
            \`;
        }
        
        // Render Stocks
        function renderStocks() {
            document.getElementById('stocks-grid').innerHTML = stocks.map(stock => {
                const f = stock.fundamentals || {};
                const scoreClass = getScoreClass(stock.totalScore);
                const verdictClass = getVerdictClass(stock.verdict);
                
                const scoreItems = [
                    { name: 'Revenue Growth', score: stock.scores.revenueGrowth, weight: '15%' },
                    { name: 'Profit Growth', score: stock.scores.profitGrowth, weight: '15%' },
                    { name: 'Balance Sheet', score: stock.scores.balanceSheet, weight: '10%' },
                    { name: 'Cash Flow', score: stock.scores.cashFlow, weight: '10%' },
                    { name: 'Management', score: stock.scores.management, weight: '10%' },
                    { name: 'Industry Tailwind', score: stock.scores.industry, weight: '10%' },
                    { name: 'Competitive Moat', score: stock.scores.moat, weight: '10%' },
                    { name: 'Valuation', score: stock.scores.valuation, weight: '10%' },
                    { name: 'Capital Allocation', score: stock.scores.capitalAllocation, weight: '5%' },
                    { name: 'Risk Level', score: stock.scores.risk, weight: '5%' }
                ];
                
                return \`
                    <div class="stock-card" data-symbol="\${stock.symbol}">
                        <div class="stock-header" onclick="toggleStock('\${stock.symbol}')">
                            <div class="stock-identity">
                                <span class="stock-symbol">\${stock.symbol}</span>
                                <span class="stock-name">\${stock.name}</span>
                                <span class="stock-sector">\${f.sector || 'Equity'}</span>
                            </div>
                            <div class="stock-metric">
                                <div class="label">Current Price</div>
                                <div class="value">₹\${stock.currentPrice.toFixed(2)}</div>
                            </div>
                            <div class="stock-metric">
                                <div class="label">Today</div>
                                <div class="value \${stock.dayChangePct >= 0 ? 'positive' : 'negative'}">
                                    \${stock.dayChangePct >= 0 ? '+' : ''}\${formatCurrency(stock.dayChange * stock.quantity)} (\${stock.dayChangePct >= 0 ? '+' : ''}\${stock.dayChangePct.toFixed(1)}%)
                                </div>
                            </div>
                            <div class="stock-metric">
                                <div class="label">Total P&L</div>
                                <div class="value \${stock.profitLossPct >= 0 ? 'positive' : 'negative'}">
                                    \${formatCurrency(stock.profitLoss)} (\${stock.profitLossPct >= 0 ? '+' : ''}\${stock.profitLossPct.toFixed(1)}%)
                                </div>
                            </div>
                            <div class="stock-metric">
                                <div class="label">Score</div>
                                <div class="score-circle score-\${scoreClass}">\${stock.totalScore}</div>
                            </div>
                            <div style="display: flex; align-items: center; gap: 12px;">
                                <span class="verdict-badge \${verdictClass}">\${stock.verdictEmoji} \${stock.verdict}</span>
                                <span class="expand-icon">▼</span>
                            </div>
                        </div>
                        
                        <div class="stock-details">
                            <div class="details-grid">
                                <!-- Position Details -->
                                <div class="details-section">
                                    <h4>💰 Your Position</h4>
                                    <div class="details-row"><span class="label">Quantity</span><span class="value">\${stock.quantity} shares</span></div>
                                    <div class="details-row"><span class="label">Avg Buy Price</span><span class="value">₹\${stock.avgPrice.toFixed(2)}</span></div>
                                    <div class="details-row"><span class="label">Current Price</span><span class="value">₹\${stock.currentPrice.toFixed(2)}</span></div>
                                    <div class="details-row"><span class="label">Invested</span><span class="value">\${formatCurrency(stock.investedValue)}</span></div>
                                    <div class="details-row"><span class="label">Current Value</span><span class="value">\${formatCurrency(stock.currentValue)}</span></div>
                                    <div class="details-row"><span class="label">Today's P&L</span><span class="value \${stock.dayChange >= 0 ? 'positive' : 'negative'}">\${formatCurrency(stock.dayChange * stock.quantity)} (\${stock.dayChangePct >= 0 ? '+' : ''}\${stock.dayChangePct.toFixed(1)}%)</span></div>
                                    <div class="details-row"><span class="label">Total P&L</span><span class="value \${stock.profitLoss >= 0 ? 'positive' : 'negative'}">\${formatCurrency(stock.profitLoss)} (\${stock.profitLossPct >= 0 ? '+' : ''}\${stock.profitLossPct.toFixed(1)}%)</span></div>
                                </div>
                                
                                <!-- Valuation -->
                                <div class="details-section">
                                    <h4>📊 Valuation</h4>
                                    <div class="details-row"><span class="label">P/E Ratio</span><span class="value">\${f.pe?.toFixed(1) || 'N/A'}</span></div>
                                    <div class="details-row"><span class="label">Industry P/E</span><span class="value">\${f.indPE?.toFixed(1) || 'N/A'}</span></div>
                                    <div class="details-row"><span class="label">P/B Ratio</span><span class="value">\${f.pb?.toFixed(2) || 'N/A'}</span></div>
                                    <div class="details-row"><span class="label">EPS</span><span class="value">₹\${f.eps?.toFixed(2) || 'N/A'}</span></div>
                                    <div class="details-row"><span class="label">Book Value</span><span class="value">₹\${f.bookValue?.toFixed(2) || 'N/A'}</span></div>
                                    <div class="details-row"><span class="label">Market Cap</span><span class="value">\${f.marketCap ? formatCurrency(f.marketCap >= 1000 ? f.marketCap * 10000000 : f.marketCap) : 'N/A'}</span></div>
                                </div>
                                
                                <!-- Growth -->
                                <div class="details-section">
                                    <h4>📈 Growth Metrics</h4>
                                    <div class="details-row"><span class="label">Revenue (3Y)</span><span class="value \${f.salesGrowth3Y != null ? (f.salesGrowth3Y >= 0 ? 'positive' : 'negative') : ''}">\${formatPercent(f.salesGrowth3Y)}</span></div>
                                    <div class="details-row"><span class="label">Revenue (5Y)</span><span class="value \${f.salesGrowth5Y != null ? (f.salesGrowth5Y >= 0 ? 'positive' : 'negative') : ''}">\${formatPercent(f.salesGrowth5Y)}</span></div>
                                    <div class="details-row"><span class="label">Profit (3Y)</span><span class="value \${f.profitGrowth3Y != null ? (f.profitGrowth3Y >= 0 ? 'positive' : 'negative') : ''}">\${formatPercent(f.profitGrowth3Y)}</span></div>
                                    <div class="details-row"><span class="label">Profit (5Y)</span><span class="value \${f.profitGrowth5Y != null ? (f.profitGrowth5Y >= 0 ? 'positive' : 'negative') : ''}">\${formatPercent(f.profitGrowth5Y)}</span></div>
                                    <div class="details-row"><span class="label">TTM Revenue</span><span class="value \${f.salesGrowthTTM != null ? (f.salesGrowthTTM >= 0 ? 'positive' : 'negative') : ''}">\${formatPercent(f.salesGrowthTTM)}</span></div>
                                    <div class="details-row"><span class="label">TTM Profit</span><span class="value \${f.profitGrowthTTM != null ? (f.profitGrowthTTM >= 0 ? 'positive' : 'negative') : ''}">\${formatPercent(f.profitGrowthTTM)}</span></div>
                                </div>
                                
                                <!-- Returns -->
                                <div class="details-section">
                                    <h4>📉 Returns & Risk</h4>
                                    <div class="details-row"><span class="label">ROE</span><span class="value">\${formatPercent(f.roe)}</span></div>
                                    <div class="details-row"><span class="label">ROCE</span><span class="value">\${formatPercent(f.roce)}</span></div>
                                    <div class="details-row"><span class="label">Div Yield</span><span class="value">\${formatPercent(f.divYield)}</span></div>
                                    <div class="details-row"><span class="label">Beta</span><span class="value">\${f.beta?.toFixed(2) || 'N/A'}</span></div>
                                    <div class="details-row"><span class="label">52W High</span><span class="value">\${(stock.high52w || f.high52w) ? '₹' + (stock.high52w || f.high52w).toFixed(2) : 'N/A'}</span></div>
                                    <div class="details-row"><span class="label">52W Low</span><span class="value">\${(stock.low52w || f.low52w) ? '₹' + (stock.low52w || f.low52w).toFixed(2) : 'N/A'}</span></div>
                                </div>
                                
                                <!-- Score Breakdown -->
                                <div class="details-section score-breakdown">
                                    <h4>🎯 Score Breakdown</h4>
                                    \${scoreItems.map(item => \`
                                        <div class="score-item">
                                            <span class="name">\${item.name} (\${item.weight})</span>
                                            <div class="score-bar-container">
                                                <div class="score-bar \${getScoreClass(item.score)}" style="width: \${item.score * 10}%"></div>
                                            </div>
                                            <span class="score">\${item.score}/10</span>
                                        </div>
                                    \`).join('')}
                                </div>
                                
                                <!-- Shareholding -->
                                <div class="details-section">
                                    <h4>👥 Shareholding</h4>
                                    <div class="details-row"><span class="label">Promoters</span><span class="value">\${formatPercent(f.promoterHolding)}</span></div>
                                    <div class="details-row"><span class="label">FII</span><span class="value">\${formatPercent(f.fiiHolding)}</span></div>
                                    <div class="details-row"><span class="label">DII</span><span class="value">\${formatPercent(f.diiHolding)}</span></div>
                                    <div class="details-row"><span class="label">Public</span><span class="value">\${formatPercent(f.publicHolding)}</span></div>
                                </div>
                                
                                <!-- Pros/Cons -->
                                \${(f.pros?.length || f.cons?.length) ? \`
                                <div class="details-section" style="grid-column: span 2;">
                                    <h4>⚖️ Strengths & Concerns</h4>
                                    <div class="pros-cons-grid">
                                        <div class="pros">
                                            <h5>✅ Strengths</h5>
                                            <ul class="pros-cons-list">
                                                \${(f.pros || []).slice(0, 5).map(p => '<li>' + p + '</li>').join('')}
                                            </ul>
                                        </div>
                                        <div class="cons">
                                            <h5>❌ Concerns</h5>
                                            <ul class="pros-cons-list">
                                                \${(f.cons || []).slice(0, 5).map(c => '<li>' + c + '</li>').join('')}
                                            </ul>
                                        </div>
                                    </div>
                                </div>
                                \` : ''}
                            </div>
                        </div>
                    </div>
                \`;
            }).join('');
        }
        
        // Charts
        function renderCharts() {
            // Allocation Pie Chart
            const allocationCtx = document.getElementById('allocationChart').getContext('2d');
            new Chart(allocationCtx, {
                type: 'doughnut',
                data: {
                    labels: stocks.map(s => s.symbol),
                    datasets: [{
                        data: stocks.map(s => s.currentValue),
                        backgroundColor: [
                            '#4ecca3', '#7c4dff', '#ff6b6b', '#ffd93d', '#4dabf7',
                            '#f06595', '#69db7c', '#ffa94d', '#845ef7', '#20c997'
                        ],
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'right',
                            labels: {
                                color: '#a0a0b0',
                                font: { size: 12 },
                                padding: 16
                            }
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                    const pct = ((context.raw / total) * 100).toFixed(1);
                                    return context.label + ': ' + formatCurrency(context.raw) + ' (' + pct + '%)';
                                }
                            }
                        }
                    }
                }
            });
            
            // P&L Bar Chart
            const pnlCtx = document.getElementById('pnlChart').getContext('2d');
            new Chart(pnlCtx, {
                type: 'bar',
                data: {
                    labels: stocks.map(s => s.symbol),
                    datasets: [{
                        label: 'P&L %',
                        data: stocks.map(s => s.profitLossPct),
                        backgroundColor: stocks.map(s => s.profitLossPct >= 0 ? '#4ecca3' : '#ff6b6b'),
                        borderRadius: 6
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    return 'P&L: ' + (context.raw >= 0 ? '+' : '') + context.raw.toFixed(1) + '%';
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            ticks: { color: '#a0a0b0' },
                            grid: { display: false }
                        },
                        y: {
                            ticks: {
                                color: '#a0a0b0',
                                callback: function(value) { return value + '%'; }
                            },
                            grid: { color: 'rgba(255,255,255,0.05)' }
                        }
                    }
                }
            });
        }
        
        // Initialize
        renderSummary();
        renderStocks();
        renderCharts();
    </script>
</body>
</html>`;
    }
}
