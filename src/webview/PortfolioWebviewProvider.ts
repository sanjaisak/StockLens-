/**
 * Portfolio Webview Provider
 * Provides the UI for the StockLens dashboard
 */

import * as vscode from 'vscode';
import { ProviderManager } from '../providers/ProviderManager';
import { AnalysisService, PortfolioAnalysis, StockAnalysis, SCORING_WEIGHTS, VERDICT_THRESHOLDS } from '../services/AnalysisService';

export class PortfolioWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'portfolioAnalyzer.dashboard';
    
    private _view?: vscode.WebviewView;
    private _portfolioData?: PortfolioAnalysis;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _providerManager: ProviderManager,
        private readonly _analysisService: AnalysisService
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'refresh':
                    await this.refresh();
                    break;
                case 'selectStock':
                    this._showStockDetails(data.symbol);
                    break;
                case 'configure':
                    vscode.commands.executeCommand('portfolioAnalyzer.configureProvider');
                    break;
            }
        });

        // Initial load
        this.refresh();
    }

    public async refresh() {
        if (!this._view) return;

        try {
            this._view.webview.postMessage({ type: 'loading' });

            const provider = this._providerManager.getActiveProvider();
            if (!provider?.isConfigured()) {
                this._view.webview.postMessage({ 
                    type: 'notConfigured',
                    providerName: provider?.name || 'No provider'
                });
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

            // Send to webview
            this._view.webview.postMessage({
                type: 'data',
                portfolio: this._portfolioData
            });

        } catch (error: any) {
            this._view.webview.postMessage({
                type: 'error',
                message: error.message || 'Failed to load portfolio data'
            });
        }
    }

    private _showStockDetails(symbol: string) {
        if (!this._portfolioData) return;
        
        const stock = this._portfolioData.stocks.find(s => s.symbol === symbol);
        if (stock) {
            this._view?.webview.postMessage({
                type: 'stockDetails',
                stock
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>StockLens</title>
    <style>
        :root {
            --bg-primary: var(--vscode-editor-background);
            --bg-secondary: var(--vscode-sideBar-background);
            --text-primary: var(--vscode-editor-foreground);
            --text-secondary: var(--vscode-descriptionForeground);
            --border-color: var(--vscode-panel-border);
            --accent-color: var(--vscode-button-background);
            --success-color: #4caf50;
            --danger-color: #f44336;
            --warning-color: #ff9800;
        }
        
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--text-primary);
            background: var(--bg-primary);
            padding: 16px;
            line-height: 1.5;
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--border-color);
        }
        
        .header h1 {
            font-size: 16px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .header-actions {
            display: flex;
            gap: 8px;
        }
        
        button {
            background: var(--accent-color);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        button.secondary {
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--text-primary);
        }
        
        /* Loading & Error States */
        .loading, .error, .not-configured {
            text-align: center;
            padding: 40px 20px;
        }
        
        .loading .spinner {
            width: 40px;
            height: 40px;
            border: 3px solid var(--border-color);
            border-top-color: var(--accent-color);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 16px;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        .error { color: var(--danger-color); }
        
        /* Summary Cards */
        .summary {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 12px;
            margin-bottom: 20px;
        }
        
        .summary-card {
            background: var(--bg-secondary);
            padding: 12px;
            border-radius: 8px;
            border: 1px solid var(--border-color);
        }
        
        .summary-card.full-width {
            grid-column: span 2;
        }
        
        .summary-card .label {
            font-size: 11px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 4px;
        }
        
        .summary-card .value {
            font-size: 18px;
            font-weight: 600;
        }
        
        .summary-card .sub-value {
            font-size: 12px;
            margin-top: 2px;
        }
        
        .positive { color: var(--success-color); }
        .negative { color: var(--danger-color); }
        
        /* Stock List */
        .section-header {
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 12px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .stock-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        
        .stock-card {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 12px;
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .stock-card:hover {
            border-color: var(--accent-color);
        }
        
        .stock-card.expanded {
            border-color: var(--accent-color);
        }
        
        .stock-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 8px;
        }
        
        .stock-symbol {
            font-weight: 600;
            font-size: 14px;
        }
        
        .stock-name {
            font-size: 11px;
            color: var(--text-secondary);
        }
        
        .stock-verdict {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 12px;
            font-weight: 500;
        }
        
        .stock-metrics {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 8px;
            font-size: 11px;
        }
        
        .metric {
            text-align: center;
        }
        
        .metric .label {
            color: var(--text-secondary);
            margin-bottom: 2px;
        }
        
        .metric .value {
            font-weight: 500;
        }
        
        /* Stock Details Modal */
        .stock-details {
            display: none;
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--border-color);
        }
        
        .stock-card.expanded .stock-details {
            display: block;
        }
        
        .details-section {
            margin-bottom: 16px;
        }
        
        .details-section h4 {
            font-size: 12px;
            font-weight: 600;
            margin-bottom: 8px;
            color: var(--text-secondary);
        }
        
        .details-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 8px;
            font-size: 11px;
        }
        
        .detail-item {
            display: flex;
            justify-content: space-between;
            padding: 4px 0;
        }
        
        .detail-item .label {
            color: var(--text-secondary);
        }
        
        /* Score Bars */
        .score-item {
            margin-bottom: 8px;
        }
        
        .score-header {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            margin-bottom: 4px;
        }
        
        .score-bar {
            height: 6px;
            background: var(--border-color);
            border-radius: 3px;
            overflow: hidden;
        }
        
        .score-fill {
            height: 100%;
            border-radius: 3px;
            transition: width 0.3s;
        }
        
        .score-fill.high { background: var(--success-color); }
        .score-fill.medium { background: var(--warning-color); }
        .score-fill.low { background: var(--danger-color); }
        
        /* Pros/Cons */
        .pros-cons {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
        }
        
        .pros h5 { color: var(--success-color); }
        .cons h5 { color: var(--danger-color); }
        
        .pros-cons ul {
            list-style: none;
            font-size: 10px;
            margin-top: 4px;
        }
        
        .pros-cons li {
            padding: 2px 0;
            padding-left: 12px;
            position: relative;
        }
        
        .pros li::before {
            content: "✓";
            position: absolute;
            left: 0;
            color: var(--success-color);
        }
        
        .cons li::before {
            content: "✗";
            position: absolute;
            left: 0;
            color: var(--danger-color);
        }
        
        /* Tabs */
        .tabs {
            display: flex;
            gap: 4px;
            margin-bottom: 16px;
            border-bottom: 1px solid var(--border-color);
        }
        
        .tab {
            padding: 8px 16px;
            font-size: 12px;
            background: none;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            position: relative;
        }
        
        .tab.active {
            color: var(--accent-color);
        }
        
        .tab.active::after {
            content: "";
            position: absolute;
            bottom: -1px;
            left: 0;
            right: 0;
            height: 2px;
            background: var(--accent-color);
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
        
        /* Methodology */
        .methodology {
            font-size: 11px;
        }
        
        .methodology table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 16px;
        }
        
        .methodology th, .methodology td {
            text-align: left;
            padding: 6px 8px;
            border-bottom: 1px solid var(--border-color);
        }
        
        .methodology th {
            color: var(--text-secondary);
            font-weight: 500;
        }
        
        .verdict-list {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        
        .verdict-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 8px;
            background: var(--bg-secondary);
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📊 StockLens</h1>
        <div class="header-actions">
            <button onclick="refresh()" title="Refresh">🔄</button>
            <button onclick="configure()" class="secondary" title="Configure">⚙️</button>
        </div>
    </div>
    
    <div class="tabs">
        <button class="tab active" onclick="switchTab('portfolio')">Portfolio</button>
        <button class="tab" onclick="switchTab('methodology')">Methodology</button>
    </div>
    
    <div id="portfolio-tab" class="tab-content active">
        <div id="loading" class="loading" style="display: none;">
            <div class="spinner"></div>
            <p>Loading portfolio data...</p>
        </div>
        
        <div id="error" class="error" style="display: none;"></div>
        
        <div id="not-configured" class="not-configured" style="display: none;">
            <p>🔐 Please configure your broker credentials</p>
            <button onclick="configure()" style="margin-top: 12px;">Configure Broker</button>
        </div>
        
        <div id="content" style="display: none;">
            <div class="summary" id="summary"></div>
            
            <div class="section-header">Holdings (Ranked by Score)</div>
            <div class="stock-list" id="stock-list"></div>
        </div>
    </div>
    
    <div id="methodology-tab" class="tab-content">
        <div class="methodology">
            <h3 style="margin-bottom: 12px;">Scoring Categories</h3>
            <table>
                <tr>
                    <th>Category</th>
                    <th>Weight</th>
                    <th>Measures</th>
                </tr>
                <tr><td>Revenue Growth</td><td>15%</td><td>3Y & 5Y Sales CAGR</td></tr>
                <tr><td>Profit Growth</td><td>15%</td><td>3Y & 5Y Profit CAGR</td></tr>
                <tr><td>Balance Sheet</td><td>10%</td><td>Debt/Equity ratio</td></tr>
                <tr><td>Cash Flow</td><td>10%</td><td>Profit consistency</td></tr>
                <tr><td>Management</td><td>10%</td><td>Promoter holding %</td></tr>
                <tr><td>Industry</td><td>10%</td><td>Sector growth potential</td></tr>
                <tr><td>Moat</td><td>10%</td><td>ROCE + ROE average</td></tr>
                <tr><td>Valuation</td><td>10%</td><td>PE vs Industry, P/B</td></tr>
                <tr><td>Capital Allocation</td><td>5%</td><td>ROE + Div yield</td></tr>
                <tr><td>Risk Level</td><td>5%</td><td>Beta (volatility)</td></tr>
            </table>
            
            <h3 style="margin-bottom: 12px;">Verdict Thresholds</h3>
            <div class="verdict-list">
<div class="verdict-item">🚀 <strong>STRONG BUY</strong> - Score ≥ 8.0</div>
                <div class="verdict-item">📈 <strong>BUY</strong> - Score ≥ 7.0</div>
                <div class="verdict-item">📊 <strong>HOLD</strong> - Score ≥ 6.0</div>
                <div class="verdict-item">⚠️ <strong>WEAK HOLD</strong> - Score ≥ 5.0</div>
                <div class="verdict-item">📉 <strong>SELL</strong> - Score &lt; 5.0</div>
            </div>
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        let portfolioData = null;
        let expandedStock = null;
        
        function refresh() {
            vscode.postMessage({ type: 'refresh' });
        }
        
        function configure() {
            vscode.postMessage({ type: 'configure' });
        }
        
        function switchTab(tab) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            document.querySelector(\`.tab:nth-child(\${tab === 'portfolio' ? 1 : 2})\`).classList.add('active');
            document.getElementById(tab + '-tab').classList.add('active');
        }
        
        function formatCurrency(value) {
            if (Math.abs(value) >= 10000000) {
                return '₹' + (value / 10000000).toFixed(2) + ' Cr';
            } else if (Math.abs(value) >= 100000) {
                return '₹' + (value / 100000).toFixed(2) + ' L';
            }
            return '₹' + value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
        
        function formatPercent(value) {
            if (value === null || value === undefined) return 'N/A';
            return value.toFixed(1) + '%';
        }
        
        function getScoreClass(score) {
            if (score >= 7) return 'high';
            if (score >= 5) return 'medium';
            return 'low';
        }
        
        function toggleStock(symbol) {
            expandedStock = expandedStock === symbol ? null : symbol;
            renderStocks();
        }
        
        function renderSummary(summary) {
            const pnlClass = summary.totalPnLPct >= 0 ? 'positive' : 'negative';
            const dayClass = summary.dayPnLPct >= 0 ? 'positive' : 'negative';
            
            document.getElementById('summary').innerHTML = \`
                <div class="summary-card">
                    <div class="label">Total Invested</div>
                    <div class="value">\${formatCurrency(summary.totalInvested)}</div>
                </div>
                <div class="summary-card">
                    <div class="label">Current Value</div>
                    <div class="value">\${formatCurrency(summary.currentValue)}</div>
                </div>
                <div class="summary-card">
                    <div class="label">Total P&L</div>
                    <div class="value \${pnlClass}">\${formatCurrency(summary.totalPnL)}</div>
                    <div class="sub-value \${pnlClass}">\${summary.totalPnLPct >= 0 ? '+' : ''}\${summary.totalPnLPct.toFixed(1)}%</div>
                </div>
                <div class="summary-card">
                    <div class="label">Portfolio Score</div>
                    <div class="value">\${summary.avgScore.toFixed(1)}/10</div>
                </div>
            \`;
        }
        
        function renderStocks() {
            if (!portfolioData) return;
            
            const html = portfolioData.stocks.map(stock => {
                const pnlClass = stock.profitLossPct >= 0 ? 'positive' : 'negative';
                const isExpanded = expandedStock === stock.symbol;
                
                return \`
                    <div class="stock-card \${isExpanded ? 'expanded' : ''}" onclick="toggleStock('\${stock.symbol}')">
                        <div class="stock-header">
                            <div>
                                <div class="stock-symbol">\${stock.symbol}</div>
                                <div class="stock-name">\${stock.name}</div>
                            </div>
                            <div class="stock-verdict">
                                \${stock.verdictEmoji} \${stock.verdict}
                                <span style="font-size: 10px; color: var(--text-secondary);">(\${stock.totalScore}/10)</span>
                            </div>
                        </div>
                        <div class="stock-metrics">
                            <div class="metric">
                                <div class="label">Price</div>
                                <div class="value">₹\${stock.currentPrice.toFixed(2)}</div>
                            </div>
                            <div class="metric">
                                <div class="label">P&L</div>
                                <div class="value \${pnlClass}">\${stock.profitLossPct >= 0 ? '+' : ''}\${stock.profitLossPct.toFixed(1)}%</div>
                            </div>
                            <div class="metric">
                                <div class="label">Value</div>
                                <div class="value">\${formatCurrency(stock.currentValue)}</div>
                            </div>
                        </div>
                        
                        <div class="stock-details">
                            \${renderStockDetails(stock)}
                        </div>
                    </div>
                \`;
            }).join('');
            
            document.getElementById('stock-list').innerHTML = html;
        }
        
        function renderStockDetails(stock) {
            const f = stock.fundamentals || {};
            
            const scoreItems = [
                { name: 'Revenue Growth', score: stock.scores.revenueGrowth, weight: '15%' },
                { name: 'Profit Growth', score: stock.scores.profitGrowth, weight: '15%' },
                { name: 'Balance Sheet', score: stock.scores.balanceSheet, weight: '10%' },
                { name: 'Cash Flow', score: stock.scores.cashFlow, weight: '10%' },
                { name: 'Management', score: stock.scores.management, weight: '10%' },
                { name: 'Industry', score: stock.scores.industry, weight: '10%' },
                { name: 'Moat', score: stock.scores.moat, weight: '10%' },
                { name: 'Valuation', score: stock.scores.valuation, weight: '10%' },
                { name: 'Capital', score: stock.scores.capitalAllocation, weight: '5%' },
                { name: 'Risk', score: stock.scores.risk, weight: '5%' }
            ];
            
            return \`
                <div class="details-section">
                    <h4>📊 Score Breakdown</h4>
                    \${scoreItems.map(item => \`
                        <div class="score-item">
                            <div class="score-header">
                                <span>\${item.name} (\${item.weight})</span>
                                <span>\${item.score}/10</span>
                            </div>
                            <div class="score-bar">
                                <div class="score-fill \${getScoreClass(item.score)}" style="width: \${item.score * 10}%"></div>
                            </div>
                        </div>
                    \`).join('')}
                </div>
                
                <div class="details-section">
                    <h4>💰 Position Details</h4>
                    <div class="details-grid">
                        <div class="detail-item"><span class="label">Quantity</span><span>\${stock.quantity}</span></div>
                        <div class="detail-item"><span class="label">Avg Price</span><span>₹\${stock.avgPrice.toFixed(2)}</span></div>
                        <div class="detail-item"><span class="label">Invested</span><span>\${formatCurrency(stock.investedValue)}</span></div>
                        <div class="detail-item"><span class="label">Current</span><span>\${formatCurrency(stock.currentValue)}</span></div>
                    </div>
                </div>
                
                <div class="details-section">
                    <h4>📈 Valuation</h4>
                    <div class="details-grid">
                        <div class="detail-item"><span class="label">P/E</span><span>\${f.pe?.toFixed(1) || 'N/A'}</span></div>
                        <div class="detail-item"><span class="label">Industry P/E</span><span>\${f.indPE?.toFixed(1) || 'N/A'}</span></div>
                        <div class="detail-item"><span class="label">P/B</span><span>\${f.pb?.toFixed(2) || 'N/A'}</span></div>
                        <div class="detail-item"><span class="label">EPS</span><span>₹\${f.eps?.toFixed(2) || 'N/A'}</span></div>
                    </div>
                </div>
                
                <div class="details-section">
                    <h4>📊 Growth</h4>
                    <div class="details-grid">
                        <div class="detail-item"><span class="label">Revenue (3Y)</span><span>\${formatPercent(f.salesGrowth3Y)}</span></div>
                        <div class="detail-item"><span class="label">Revenue (5Y)</span><span>\${formatPercent(f.salesGrowth5Y)}</span></div>
                        <div class="detail-item"><span class="label">Profit (3Y)</span><span>\${formatPercent(f.profitGrowth3Y)}</span></div>
                        <div class="detail-item"><span class="label">Profit (5Y)</span><span>\${formatPercent(f.profitGrowth5Y)}</span></div>
                    </div>
                </div>
                
                <div class="details-section">
                    <h4>📈 Returns</h4>
                    <div class="details-grid">
                        <div class="detail-item"><span class="label">ROE</span><span>\${formatPercent(f.roe)}</span></div>
                        <div class="detail-item"><span class="label">ROCE</span><span>\${formatPercent(f.roce)}</span></div>
                        <div class="detail-item"><span class="label">Div Yield</span><span>\${formatPercent(f.divYield)}</span></div>
                        <div class="detail-item"><span class="label">Beta</span><span>\${f.beta?.toFixed(2) || 'N/A'}</span></div>
                    </div>
                </div>
                
                <div class="details-section">
                    <h4>👥 Shareholding</h4>
                    <div class="details-grid">
                        <div class="detail-item"><span class="label">Promoters</span><span>\${formatPercent(f.promoterHolding)}</span></div>
                        <div class="detail-item"><span class="label">FII</span><span>\${formatPercent(f.fiiHolding)}</span></div>
                        <div class="detail-item"><span class="label">DII</span><span>\${formatPercent(f.diiHolding)}</span></div>
                        <div class="detail-item"><span class="label">Public</span><span>\${formatPercent(f.publicHolding)}</span></div>
                    </div>
                </div>
                
                \${(f.pros?.length || f.cons?.length) ? \`
                <div class="details-section">
                    <h4>⚖️ Analysis</h4>
                    <div class="pros-cons">
                        <div class="pros">
                            <h5>Strengths</h5>
                            <ul>\${(f.pros || []).map(p => '<li>' + p + '</li>').join('')}</ul>
                        </div>
                        <div class="cons">
                            <h5>Concerns</h5>
                            <ul>\${(f.cons || []).map(c => '<li>' + c + '</li>').join('')}</ul>
                        </div>
                    </div>
                </div>
                \` : ''}
            \`;
        }
        
        window.addEventListener('message', event => {
            const message = event.data;
            
            document.getElementById('loading').style.display = 'none';
            document.getElementById('error').style.display = 'none';
            document.getElementById('not-configured').style.display = 'none';
            document.getElementById('content').style.display = 'none';
            
            switch (message.type) {
                case 'loading':
                    document.getElementById('loading').style.display = 'block';
                    break;
                    
                case 'error':
                    document.getElementById('error').style.display = 'block';
                    document.getElementById('error').innerHTML = '❌ ' + message.message;
                    break;
                    
                case 'notConfigured':
                    document.getElementById('not-configured').style.display = 'block';
                    break;
                    
                case 'data':
                    portfolioData = message.portfolio;
                    document.getElementById('content').style.display = 'block';
                    renderSummary(portfolioData.summary);
                    renderStocks();
                    break;
            }
        });
        
        // Initial state
        document.getElementById('loading').style.display = 'block';
    </script>
</body>
</html>`;
    }
}
