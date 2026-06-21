/**
 * Scoring Info Panel
 * Shows how the scoring methodology works
 */

import * as vscode from 'vscode';

export class ScoringInfoPanel {
    public static readonly viewType = 'portfolioAnalyzer.scoringInfo';
    private static currentPanel: ScoringInfoPanel | undefined;
    
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ScoringInfoPanel.currentPanel) {
            ScoringInfoPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ScoringInfoPanel.viewType,
            'ℹ️ Scoring Methodology',
            column || vscode.ViewColumn.One,
            { enableScripts: true }
        );

        ScoringInfoPanel.currentPanel = new ScoringInfoPanel(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._panel.webview.html = this._getHtmlContent();
        
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose() {
        ScoringInfoPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    private _getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Scoring Methodology</title>
    <style>
        :root {
            --bg-dark: #1a1a2e;
            --bg-card: #16213e;
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
            padding: 32px;
            max-width: 900px;
            margin: 0 auto;
        }
        
        h1 {
            font-size: 28px;
            margin-bottom: 8px;
            color: var(--accent);
        }
        
        .subtitle {
            color: var(--text-secondary);
            margin-bottom: 32px;
            font-size: 16px;
        }
        
        h2 {
            font-size: 18px;
            margin: 32px 0 16px;
            color: var(--accent-secondary);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 24px;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 14px;
        }
        
        th {
            text-align: left;
            padding: 12px 16px;
            background: rgba(78, 204, 163, 0.1);
            color: var(--accent);
            font-weight: 600;
            border-bottom: 2px solid var(--border);
        }
        
        td {
            padding: 12px 16px;
            border-bottom: 1px solid var(--border);
        }
        
        tr:last-child td {
            border-bottom: none;
        }
        
        tr:hover {
            background: rgba(255, 255, 255, 0.03);
        }
        
        .weight {
            color: var(--warning);
            font-weight: 600;
        }
        
        .verdict-row {
            display: flex;
            align-items: center;
            gap: 16px;
            padding: 12px 16px;
            border-bottom: 1px solid var(--border);
        }
        
        .verdict-row:last-child {
            border-bottom: none;
        }
        
        .verdict-score {
            min-width: 80px;
            font-weight: 600;
            font-size: 15px;
        }
        
        .verdict-badge {
            padding: 4px 12px;
            border-radius: 16px;
            font-weight: 600;
            font-size: 13px;
            min-width: 120px;
            text-align: center;
        }
        
.verdict-badge.strong-buy { background: rgba(78, 204, 163, 0.2); color: var(--positive); }
        .verdict-badge.buy { background: rgba(78, 204, 163, 0.15); color: #6dd5a0; }
        .verdict-badge.hold { background: rgba(255, 217, 61, 0.15); color: var(--warning); }
        .verdict-badge.weak-hold { background: rgba(255, 159, 67, 0.15); color: #ff9f43; }
        .verdict-badge.sell { background: rgba(255, 107, 107, 0.15); color: var(--negative); }
        
        .verdict-desc {
            color: var(--text-secondary);
            font-size: 13px;
        }
        
        .score-scale {
            display: flex;
            gap: 8px;
            margin-top: 12px;
            font-size: 12px;
        }
        
        .score-scale span {
            padding: 4px 10px;
            border-radius: 4px;
            background: var(--bg-dark);
        }
        
        .formula {
            background: var(--bg-dark);
            padding: 16px;
            border-radius: 8px;
            font-family: monospace;
            font-size: 13px;
            margin: 12px 0;
            border-left: 3px solid var(--accent);
        }
        
        .note {
            background: rgba(124, 77, 255, 0.1);
            border-left: 3px solid var(--accent-secondary);
            padding: 12px 16px;
            border-radius: 0 8px 8px 0;
            font-size: 13px;
            color: var(--text-secondary);
            margin-top: 16px;
        }
        
        .data-sources {
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
            margin-top: 12px;
        }
        
        .source-badge {
            padding: 6px 14px;
            background: rgba(78, 204, 163, 0.1);
            border: 1px solid var(--accent);
            border-radius: 20px;
            font-size: 12px;
            color: var(--accent);
        }
    </style>
</head>
<body>
    <h1>📊 Scoring Methodology</h1>
    <p class="subtitle">How we calculate the fundamental analysis score for each stock</p>
    
    <h2>🎯 Weighted 10-Point Scoring System</h2>
    <div class="card">
        <table>
            <thead>
                <tr>
                    <th>Category</th>
                    <th>Weight</th>
                    <th>What It Measures</th>
                    <th>Scoring Logic</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>📈 Revenue Growth</td>
                    <td class="weight">15%</td>
                    <td>3Y & 5Y Sales CAGR</td>
                    <td>≥25%=10, ≥15%=8, ≥5%=6, <5%=4</td>
                </tr>
                <tr>
                    <td>💹 Profit Growth</td>
                    <td class="weight">15%</td>
                    <td>3Y & 5Y Profit CAGR</td>
                    <td>≥25%=10, ≥15%=8, ≥5%=6, <5%=4</td>
                </tr>
                <tr>
                    <td>⚖️ Balance Sheet</td>
                    <td class="weight">10%</td>
                    <td>Debt to Equity ratio</td>
                    <td>≤0.3=+3, ≤0.5=+2, ≤1.0=0, >2.0=-2</td>
                </tr>
                <tr>
                    <td>💰 Cash Flow</td>
                    <td class="weight">10%</td>
                    <td>TTM vs 3Y profit consistency</td>
                    <td>Positive & growing=10, Declining=-2</td>
                </tr>
                <tr>
                    <td>👔 Management Quality</td>
                    <td class="weight">10%</td>
                    <td>Promoter Holding %</td>
                    <td>≥70%=10, ≥50%=8, ≥30%=6, <30%=5</td>
                </tr>
                <tr>
                    <td>🏭 Industry Tailwind</td>
                    <td class="weight">10%</td>
                    <td>Sector growth potential</td>
                    <td>IT/Finance/Pharma=8, Others=6-7</td>
                </tr>
                <tr>
                    <td>🏰 Competitive Moat</td>
                    <td class="weight">10%</td>
                    <td>ROCE + ROE average</td>
                    <td>≥25%=10, ≥15%=8, ≥10%=6, <10%=4</td>
                </tr>
                <tr>
                    <td>💎 Valuation</td>
                    <td class="weight">10%</td>
                    <td>PE vs Industry PE + P/B</td>
                    <td>Below industry=+2, Above=-1</td>
                </tr>
                <tr>
                    <td>🎪 Capital Allocation</td>
                    <td class="weight">5%</td>
                    <td>ROE + Dividend Yield</td>
                    <td>High ROE + Div=10, Low=5</td>
                </tr>
                <tr>
                    <td>⚠️ Risk Level</td>
                    <td class="weight">5%</td>
                    <td>Beta (volatility)</td>
                    <td>≤0.7=9, ≤1.0=8, ≤1.5=6, >1.5=4</td>
                </tr>
            </tbody>
        </table>
        
        <div class="formula">
            Total Score = Σ (Category Score × Weight) → Rounded to 1 decimal
        </div>
    </div>
    
    <h2>🏷️ Verdict Thresholds</h2>
    <div class="card">
        <div class="verdict-row">
            <span class="verdict-score">≥ 8.0</span>
            <span class="verdict-badge strong-buy">🚀 STRONG BUY</span>
            <span class="verdict-desc">Exceptional fundamentals - consider accumulating</span>
        </div>
        <div class="verdict-row">
            <span class="verdict-score">≥ 7.0</span>
            <span class="verdict-badge buy">📈 BUY</span>
            <span class="verdict-desc">Good quality with favorable outlook</span>
        </div>
        <div class="verdict-row">
            <span class="verdict-score">≥ 6.0</span>
            <span class="verdict-badge hold">📊 HOLD</span>
            <span class="verdict-desc">Average fundamentals - monitor closely</span>
        </div>
        <div class="verdict-row">
            <span class="verdict-score">≥ 5.0</span>
            <span class="verdict-badge weak-hold">⚠️ WEAK HOLD</span>
            <span class="verdict-desc">Concerns exist - consider reducing position</span>
        </div>
        <div class="verdict-row">
            <span class="verdict-score">< 5.0</span>
            <span class="verdict-badge sell">📉 SELL</span>
            <span class="verdict-desc">Poor fundamentals - exit recommended</span>
        </div>
    </div>
    
    <h2>📊 Individual Score Scale</h2>
    <div class="card">
        <p>Each category is scored on a 0-10 scale:</p>
        <div class="score-scale">
            <span style="color: var(--positive);">9-10: Excellent</span>
            <span style="color: #6dd5a0;">7-8: Good</span>
            <span style="color: var(--warning);">5-6: Average</span>
            <span style="color: #ff9f43;">3-4: Below Average</span>
            <span style="color: var(--negative);">0-2: Poor</span>
        </div>
        
        <div class="note">
            <strong>Note:</strong> Scores are relative benchmarks for Indian equity markets. 
            A "good" P/E ratio varies by sector - IT companies typically have higher P/E than banks.
            Always consider sector-specific dynamics when interpreting scores.
        </div>
    </div>
    
    <h2>🔗 Data Sources</h2>
    <div class="card">
        <p>We aggregate data from multiple reliable sources:</p>
        <div class="data-sources">
            <span class="source-badge">📱 IndMoney API</span>
            <span class="source-badge">📈 Tickertape API</span>
            <span class="source-badge">📊 Screener.in</span>
            <span class="source-badge">💹 NSE/BSE Data</span>
        </div>
        
        <div class="note">
            <strong>Disclaimer:</strong> This tool provides fundamental analysis for educational purposes only. 
            It is not financial advice. Always do your own research before making investment decisions.
        </div>
    </div>
</body>
</html>`;
    }
}
