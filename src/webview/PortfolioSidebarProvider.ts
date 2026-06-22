/**
 * Portfolio Sidebar Provider
 * Shows portfolio overview in the sidebar - click stocks to open detailed view
 */

import * as vscode from "vscode";
import { ProviderManager } from "../providers/ProviderManager";
import {
  AnalysisService,
  PortfolioAnalysis,
  StockAnalysis,
} from "../services/AnalysisService";
import { WatchlistService } from "../services/WatchlistService";
import { StockSearchService } from "../services/StockSearchService";
import { StockDetailPanel } from "./StockDetailPanel";
import { PortfolioReviewPanel } from "./PortfolioReviewPanel";

export class PortfolioSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly nseviewType = "portfolioAnalyzer.dashboard";

  private _view?: vscode.WebviewView;
  private _portfolioData?: PortfolioAnalysis;

  public getPortfolioStocks(): StockAnalysis[] {
    return this._portfolioData?.stocks || [];
  }

  private readonly _stockSearch: StockSearchService;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _providerManager: ProviderManager,
    private readonly _analysisService: AnalysisService,
    private readonly _watchlistService: WatchlistService,
    private readonly _context: vscode.ExtensionContext,
  ) {
    this._stockSearch = new StockSearchService(_extensionUri.fsPath);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "refresh":
          await this.refresh();
          break;
        case "openStock":
          const stock = this._portfolioData?.stocks.find(
            (s) => s.symbol === data.symbol,
          );
          if (stock) {
            vscode.commands.executeCommand(
              "portfolioAnalyzer.openStockDetail",
              stock,
            );
          }
          break;
        case "configure":
          vscode.commands.executeCommand("portfolioAnalyzer.configureProvider");
          break;
        case "searchStock":
          vscode.commands.executeCommand("portfolioAnalyzer.searchStock");
          break;
        case "addToWatchlist": {
          const s = this._portfolioData?.stocks.find(
            (x) => x.symbol === data.symbol,
          );
          if (s) {
            await vscode.commands.executeCommand(
              "portfolioAnalyzer.addToWatchlist",
              s.symbol,
              s.name,
              s.sector,
            );
          }
          break;
        }
        case "aiPortfolioReview": {
          if (!this._portfolioData) break;
          PortfolioReviewPanel.createOrShow(
            this._extensionUri,
            this._portfolioData.stocks,
            this._portfolioData.summary,
            data.zones || {},
          );
          break;
        }
        case "switchProvider": {
          await vscode.workspace
            .getConfiguration("portfolioAnalyzer")
            .update("activeProvider", data.providerId, vscode.ConfigurationTarget.Global);
          await this.refresh();
          break;
        }
        case "manualAdd":
        case "manualUpdate": {
          const mp = this._providerManager.getManualProvider();
          await mp.addOrUpdateHolding(data.holding);
          await this.refresh();
          break;
        }
        case "manualBulkAdd": {
          const mp = this._providerManager.getManualProvider();
          await mp.addOrUpdateMultipleHoldings(data.holdings);
          await this.refresh();
          break;
        }
        case "manualDelete": {
          const mp = this._providerManager.getManualProvider();
          await mp.deleteHolding(data.symbol);
          await this.refresh();
          break;
        }
        case "searchStocksManual": {
          const results = this._stockSearch.searchStocks(data.query, 8);
          webviewView.webview.postMessage({ type: "manualSearchResults", results, context: data.context || "single", rowIdx: data.rowIdx });
          break;
        }
      }
    });

    // Initial load
    this.refresh();
  }

  public async refresh() {
    if (!this._view) return;

    try {
      this._view.webview.postMessage({ type: "loading" });

      const provider = this._providerManager.getActiveProvider();

      if (!provider?.isConfigured()) {
        const notConfiguredProviderId = vscode.workspace
          .getConfiguration("portfolioAnalyzer")
          .get<string>("activeProvider", "indmoney");
        this._view.webview.postMessage({
          type: "notConfigured",
          providerName: provider?.name || "No provider",
          activeProvider: notConfiguredProviderId,
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
        const fundamentals = await this._providerManager.getFundamentals(
          holding.symbol,
        );

        const analysis = this._analysisService.analyzeStock(
          holding,
          quote,
          fundamentals,
        );
        stockAnalyses.push(analysis);
      }

      // Get portfolio analysis
      this._portfolioData =
        this._analysisService.analyzePortfolio(stockAnalyses);

      // For each holding: auto-generate AI targets if none exist for today,
      // then compute the zone label from the latest cached targets.
      const today = new Date().toDateString();
      const zones: Record<string, string> = {};

      await Promise.all(
        this._portfolioData.stocks.map(async (s) => {
          const key = `priceTargetHistory_${s.symbol}`;
          let history = this._context.globalState.get<any[]>(key) || [];
          const hasToday = history.some(
            (h) => new Date(h.date).toDateString() === today,
          );

          if (!hasToday) {
            // Trigger AI generation silently in the background
            await StockDetailPanel.generateAndSaveTargets(this._context, s);
            history = this._context.globalState.get<any[]>(key) || [];
          }

          const latest = history.length
            ? history[history.length - 1].targets
            : null;
          if (latest && s.currentPrice > 0) {
            zones[s.symbol] = this._getZoneLabel(s.currentPrice, latest);
          }
        }),
      );

      const activeProviderId = vscode.workspace
        .getConfiguration("portfolioAnalyzer")
        .get<string>("activeProvider", "indmoney");
      const manualHoldings = this._providerManager.getManualProvider().getStoredHoldings();

      // Send to webview
      this._view.webview.postMessage({
        type: "data",
        portfolio: this._portfolioData,
        zones,
        activeProvider: activeProviderId,
        manualHoldings,
      });
    } catch (error: any) {
      this._view.webview.postMessage({
        type: "error",
        message: error.message || "Failed to load portfolio data",
      });
    }
  }

  private _getZoneLabel(price: number, t: any): string {
    const levels = [
      { value: t.strongBuy, exact: "🟢 At Strong Buy",   below: "🟢 Below Strong Buy" },
      { value: t.buy,       exact: "🔵 At Buy",          below: "🔵 Between Strong Buy & Buy" },
      { value: t.consider,  exact: "🟡 At Consider",     below: "🟡 Between Buy & Consider" },
      { value: t.fair,      exact: "⚪ At Fair Value",   below: "⚪ Between Consider & Fair Value" },
      { value: t.reduce,    exact: "🔴 At Reduce",       below: "🟠 Between Fair Value & Reduce" },
    ];
    for (const lvl of levels) {
      if (!lvl.value) { continue; }
      if (Math.abs(price - lvl.value) / lvl.value <= 0.005) { return lvl.exact; }
      if (price < lvl.value) { return lvl.below; }
    }
    return "🔴 Above Reduce";
  }

  public static async generatePortfolioReview(
    stocks: StockAnalysis[],
    summary: any,
    zones: Record<string, string>,
    onChunk: (html: string) => void,
    onDone: () => void,
    onError: (msg: string) => void,
  ): Promise<void> {
    try {
      const models = await vscode.lm.selectChatModels({ family: "claude" });
      const model = models[0] ?? (await vscode.lm.selectChatModels())[0];
      if (!model) { onError("AI unavailable — no Copilot model found."); return; }

      const stockLines = stocks.map(s => {
        const zone = zones[s.symbol] || "Unknown zone";
        const pnl = s.profitLossPct >= 0 ? `+${s.profitLossPct.toFixed(1)}%` : `${s.profitLossPct.toFixed(1)}%`;
        const invested = s.investedValue > 0 ? ` | Invested ₹${s.investedValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}` : "";
        return `- ${s.symbol} (${s.name}): Score ${s.totalScore}/10, Verdict ${s.verdict}, Zone: ${zone}, P&L ${pnl}${invested}, Sector: ${s.sector}`;
      }).join("\n");

      const prompt = `You are a professional equity analyst reviewing an Indian stock portfolio. Analyze the following holdings and provide actionable, honest advice.

Portfolio Summary:
- Total Invested: ₹${summary.totalInvested?.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
- Current Value: ₹${summary.currentValue?.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
- Total P&L: ${summary.totalPnLPct?.toFixed(1)}%
- Avg Portfolio Score: ${summary.avgScore?.toFixed(1)}/10

Holdings (Score/10, Verdict, Price Zone vs AI targets, P&L):
${stockLines}

Output ONLY valid HTML with NO markdown, NO code fences, NO backticks. Use exactly these 5 section wrappers in order:

<section class="rs rs-health">
<h3>📊 Overall Portfolio Health</h3>
<p>2-3 sentences covering overall quality, diversification, and score distribution.</p>
</section>

<section class="rs rs-stocks">
<h3>🔍 Stock-by-Stock Outlook</h3>
For each holding output one block like:
<div class="stock-card">
  <div class="stock-card-header"><span class="sym">SYMBOL</span><span class="badge badge-VERDICTCLASS">VERDICT</span><span class="zone-tag">ZONE</span></div>
  <p>1-2 sentence outlook based on score, zone, sector.</p>
</div>
Where VERDICTCLASS is one of: strong-buy, buy, hold, weak-hold, sell (lowercase, hyphenated to match verdict).
</section>

<section class="rs rs-rebalance">
<h3>🔄 Rebalancing Suggestions</h3>
<ul><li>specific actionable bullets referencing stock name, zone, score</li></ul>
</section>

<section class="rs rs-risks">
<h3>⚠️ Risk Flags</h3>
<ul><li>concentration risk, weak scores, Reduce/Above Reduce zone stocks</li></ul>
</section>

<section class="rs rs-opps">
<h3>🚀 Opportunities</h3>
<ul><li>stocks in strong buy/buy zones worth adding, sectors to consider</li></ul>
</section>

Rules: output nothing outside the 5 section tags. No markdown. No prose outside the structure. Be direct, name actual stocks.`;

      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)], {},
      );

      let buffer = "";
      for await (const fragment of response.text) {
        buffer += fragment;
        // Stream each fragment so the client can accumulate; no single large postMessage
        const cleaned = fragment.replace(/```html?\n?|```/g, "");
        if (cleaned) onChunk(cleaned);
      }
      // Signal done — client will flush its buffer to DOM
      onDone();
    } catch (err: any) {
      onError(err?.message || "AI review failed");
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
            --bg-hover: var(--vscode-list-hoverBackground);
            --text-primary: var(--vscode-editor-foreground);
            --text-secondary: var(--vscode-descriptionForeground);
            --border-color: var(--vscode-panel-border);
            --accent-color: var(--vscode-button-background);
            --success-color: #4caf50;
            --danger-color: #f44336;
            --warning-color: #ff9800;
        }
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--text-primary);
            background: var(--bg-primary);
            padding: 12px;
            line-height: 1.5;
        }
        
        button {
            background: var(--accent-color);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 4px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
        }
        
        button:hover { opacity: 0.9; }
        
        /* Loading & States */
        .loading, .error, .not-configured {
            text-align: center;
            padding: 40px 16px;
        }
        
        .spinner {
            width: 32px;
            height: 32px;
            border: 3px solid var(--border-color);
            border-top-color: var(--accent-color);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 12px;
        }
        
        @keyframes spin { to { transform: rotate(360deg); } }
        
        .error { color: var(--danger-color); }
        
        /* Summary Cards */
        .summary {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            margin-bottom: 16px;
        }
        
        .summary-card {
            background: var(--bg-secondary);
            padding: 10px;
            border-radius: 6px;
            border: 1px solid var(--border-color);
        }
        .summary-card.positive-card {
            background: rgba(78,204,163,0.1);
            border-color: rgba(78,204,163,0.35);
        }
        .summary-card.negative-card {
            background: rgba(255,107,107,0.1);
            border-color: rgba(255,107,107,0.35);
        }
        .summary-card.warning-card {
            background: rgba(255,217,61,0.08);
            border-color: rgba(255,217,61,0.3);
        }
        .summary-card.invested-card {
            background: rgba(100,120,200,0.08);
            border-color: rgba(100,120,200,0.25);
        }
        .summary-card.current-card {
            background: rgba(91,192,235,0.08);
            border-color: rgba(91,192,235,0.25);
        }
        .warning { color: #ffd93d; }
        
        .summary-card.full { grid-column: span 2; }
        
        .summary-card .label {
            font-size: 10px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .summary-card .value {
            font-size: 16px;
            font-weight: 600;
            margin-top: 2px;
        }
        
        .positive { color: var(--success-color); }
        .negative { color: var(--danger-color); }
        
        /* Stock List */
        .section-header {
            font-size: 11px;
            font-weight: 600;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 6px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .sort-chips {
            display: flex;
            gap: 4px;
            margin-bottom: 10px;
            flex-wrap: wrap;
        }
        .sort-chip {
            font-size: 9px;
            padding: 2px 7px;
            border-radius: 8px;
            border: 1px solid var(--border-color);
            background: transparent;
            color: var(--text-secondary);
            cursor: pointer;
            font-family: var(--vscode-font-family);
            transition: all 0.15s;
        }
        .sort-chip:hover { border-color: var(--accent-color); color: var(--text-primary); }
        .sort-chip.active { background: var(--accent-color); color: var(--vscode-button-foreground); border-color: var(--accent-color); font-weight: 600; }
        
        .stock-list {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        
        .stock-item {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 10px 12px;
            cursor: pointer;
            transition: all 0.15s;
        }
        
        .stock-item:hover {
            border-color: var(--accent-color);
            background: var(--bg-hover);
        }
        
        .stock-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .stock-left {
            display: flex;
            flex-direction: column;
        }
        
        .stock-symbol-row {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .stock-symbol {
            font-weight: 600;
            font-size: 13px;
            color: var(--accent-color);
        }

        .add-watchlist-btn {
            width: 16px;
            height: 16px;
            border-radius: 50%;
            border: 1.5px solid var(--border-color);
            background: transparent;
            color: var(--text-secondary);
            font-size: 11px;
            line-height: 1;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 0;
            flex-shrink: 0;
            transition: all 0.15s;
        }
        .add-watchlist-btn:hover {
            border-color: var(--accent-color);
            color: var(--accent-color);
            background: rgba(var(--accent-color), 0.1);
        }
        .stock-name {
            font-size: 10px;
            color: var(--text-secondary);
            max-width: 120px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .stock-right {
            text-align: right;
        }
        .stock-price {
            font-size: 12px;
            font-weight: 500;
        }
        .stock-pnl {
            font-size: 11px;
            font-weight: 500;
        }

        /* Option B: two metric rows */
        .stock-metrics {
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid var(--border-color);
        }
        .metric-row {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .metric-label {
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            color: var(--text-secondary);
            opacity: 0.7;
            min-width: 70px;
        }
        .score-bar-wrap {
            display: flex;
            align-items: center;
            gap: 5px;
            flex: 1;
        }
        .score-bar {
            height: 4px;
            border-radius: 2px;
            flex: 1;
            background: var(--border-color);
            overflow: hidden;
        }
        .score-bar-fill {
            height: 100%;
            border-radius: 2px;
            transition: width 0.3s;
        }
        .score-bar-fill.high  { background: #4caf50; }
        .score-bar-fill.medium { background: #ff9800; }
        .score-bar-fill.low   { background: #f44336; }
        .score-num {
            font-size: 10px;
            font-weight: 600;
            min-width: 26px;
        }
        .verdict-badge {
            font-size: 9px;
            padding: 1px 7px;
            border-radius: 8px;
            font-weight: 500;
        }
        .zone-pill {
            font-size: 9px;
            padding: 1px 7px;
            border-radius: 8px;
            font-weight: 500;
        }
        .zone-sb  { background: rgba(78,204,163,0.15); color: #4ecca3; }
        .zone-b   { background: rgba(91,192,235,0.15); color: #5bc0eb; }
        .zone-c   { background: rgba(255,217,61,0.15);  color: #ffd93d; }
        .zone-fv  { background: rgba(160,160,176,0.15); color: #a0a0b0; }
        .zone-btw { background: rgba(255,159,67,0.15);  color: #ff9f43; }
        .zone-r   { background: rgba(255,107,107,0.15); color: #ff6b6b; }
        
.verdict-badge.strong-buy { background: rgba(76, 175, 80, 0.2); color: var(--success-color); }
        .verdict-badge.buy { background: rgba(76, 175, 80, 0.15); color: #6dd5a0; }
        .verdict-badge.hold { background: rgba(255, 152, 0, 0.15); color: var(--warning-color); }
        .verdict-badge.weak-hold { background: rgba(255, 159, 67, 0.15); color: #ff9f43; }
        .verdict-badge.sell { background: rgba(244, 67, 54, 0.15); color: var(--danger-color); }
        
        .score-badge {
            font-size: 11px;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.1);
        }
        
        .score-badge.high { color: var(--success-color); }
        .score-badge.medium { color: var(--warning-color); }
        .score-badge.low { color: var(--danger-color); }
        
        .click-hint {
            font-size: 9px;
            color: var(--text-secondary);
            display: flex;
            align-items: center;
            gap: 4px;
        }
        
        .timestamp {
            text-align: center;
            font-size: 10px;
            color: var(--text-secondary);
            margin-top: 16px;
            padding-top: 12px;
            border-top: 1px solid var(--border-color);
        }

        /* AI Portfolio Review */
        .ai-review-card {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 16px;
        }
        .ai-review-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 0;
        }
        .ai-review-title {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-secondary);
        }
        .ai-review-btn {
            font-size: 10px;
            padding: 3px 10px;
            border-radius: 6px;
            background: rgba(var(--vscode-button-background), 0.15);
            border: 1px solid var(--accent-color);
            color: var(--accent-color);
            cursor: pointer;
            transition: all 0.15s;
        }
        .ai-review-btn:hover { opacity: 0.8; }
        .ai-review-btn:disabled { opacity: 0.4; cursor: default; }

        /* Provider selector */
        .provider-bar {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 12px;
            padding: 6px 8px;
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 6px;
        }
        .provider-label {
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-secondary);
            flex-shrink: 0;
        }
        .provider-select {
            flex: 1;
            background: transparent;
            border: none;
            color: var(--text-primary);
            font-family: var(--vscode-font-family);
            font-size: 11px;
            cursor: pointer;
            outline: none;
        }
        .provider-select option { background: var(--vscode-dropdown-background, #1e1e1e); }

        /* Manual holdings form */
        .manual-form {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            margin-bottom: 12px;
            overflow: hidden;
        }
        .manual-form-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            border-bottom: 1px solid var(--border-color);
        }
        .manual-form-title {
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-secondary);
        }
        .manual-add-btn {
            font-size: 10px;
            padding: 2px 9px;
            border-radius: 5px;
            background: transparent;
            border: 1px solid var(--accent-color);
            color: var(--accent-color);
            cursor: pointer;
        }
        .manual-holdings-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 11px;
        }
        .manual-holdings-table th {
            padding: 5px 8px;
            text-align: left;
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            color: var(--text-secondary);
            border-bottom: 1px solid var(--border-color);
            font-weight: 600;
        }
        .manual-holdings-table td {
            padding: 6px 8px;
            border-bottom: 1px solid rgba(255,255,255,0.04);
            vertical-align: middle;
        }
        .manual-holdings-table tr:last-child td { border-bottom: none; }
        .manual-holdings-table .sym-cell { font-weight: 600; color: var(--accent-color); }
        .manual-row-actions { display: flex; gap: 4px; }
        .manual-row-btn {
            background: none;
            border: none;
            cursor: pointer;
            font-size: 11px;
            padding: 1px 4px;
            border-radius: 3px;
            color: var(--text-secondary);
            opacity: 0.6;
        }
        .manual-row-btn:hover { opacity: 1; background: rgba(255,255,255,0.08); }
        .manual-row-btn.delete:hover { color: var(--danger-color); }

        /* Inline add/edit row */
        .manual-input-row td { padding: 4px 6px; }
        .manual-input {
            width: 100%;
            background: var(--vscode-input-background);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            color: var(--text-primary);
            font-family: var(--vscode-font-family);
            font-size: 11px;
            padding: 3px 6px;
            outline: none;
        }
        .manual-input:focus { border-color: var(--accent-color); }
        .manual-search-wrap { position: relative; }
        .manual-suggestions {
            position: fixed;
            background: var(--vscode-dropdown-background, #252526);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            z-index: 9999;
            max-height: 140px;
            overflow-y: auto;
            box-shadow: 0 -4px 12px rgba(0,0,0,0.4);
        }
        .manual-suggestion {
            padding: 5px 8px;
            cursor: pointer;
            font-size: 11px;
            display: flex;
            gap: 6px;
            align-items: center;
        }
        .manual-suggestion:hover { background: var(--bg-hover); }
        .manual-suggestion .sug-sym { font-weight: 600; color: var(--accent-color); min-width: 60px; }
        .manual-suggestion .sug-name { color: var(--text-secondary); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .manual-save-btn {
            font-size: 10px; padding: 3px 8px;
            border-radius: 4px; cursor: pointer;
            background: var(--accent-color);
            color: var(--vscode-button-foreground);
            border: none; white-space: nowrap;
        }
        .manual-cancel-btn {
            font-size: 10px; padding: 3px 8px;
            border-radius: 4px; cursor: pointer;
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
        }
        .manual-empty {
            padding: 16px;
            text-align: center;
            font-size: 11px;
            color: var(--text-secondary);
            opacity: 0.6;
        }
        .bulk-add-area {
            padding: 10px 12px;
            border-top: 1px solid var(--border-color);
        }
        .bulk-add-hint {
            font-size: 10px;
            color: var(--text-secondary);
            margin-bottom: 6px;
            opacity: 0.8;
        }
        .bulk-header-row {
            display: grid;
            grid-template-columns: 2fr 1fr 1fr 20px;
            gap: 4px;
            padding: 0 2px 4px;
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            color: var(--text-secondary);
            font-weight: 600;
        }
        .bulk-row {
            display: grid;
            grid-template-columns: 2fr 1fr 1fr 20px;
            gap: 4px;
            margin-bottom: 4px;
            align-items: center;
        }
        .bulk-error {
            font-size: 10px;
            color: var(--danger-color);
            margin-top: 4px;
            display: none;
        }
        .bulk-actions {
            display: flex;
            gap: 6px;
            margin-top: 6px;
        }
        .bulk-import-btn {
            font-size: 10px; padding: 3px 10px;
            border-radius: 4px; cursor: pointer;
            background: var(--accent-color);
            color: var(--vscode-button-foreground);
            border: none; white-space: nowrap;
        }
        .bulk-cancel-btn {
            font-size: 10px; padding: 3px 8px;
            border-radius: 4px; cursor: pointer;
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
        }
    </style>
</head>
<body>
    <div id="loading" class="loading" style="display: none;">
        <div class="spinner"></div>
        <p>Loading portfolio...</p>
    </div>
    
    <div id="error" class="error" style="display: none;"></div>
    
    <div id="not-configured" class="not-configured" style="display: none;">
        <div class="provider-bar" style="margin-bottom:16px">
            <span class="provider-label">Source</span>
            <select class="provider-select" id="providerSelectNC" onchange="switchProvider(this.value)">
                <option value="manual">📋 Manual Holdings</option>
                <option value="indmoney">IndMoney</option>
                <option value="zerodha">Zerodha</option>
                <option value="groww">Groww</option>
                <option value="upstox">Upstox</option>
            </select>
        </div>
        <p>🔐 Configure your broker</p>
        <button onclick="configure()" style="margin-top: 12px;">Setup</button>
        <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-color);">
            <p style="font-size: 12px; margin-bottom: 8px;">Or analyze any stock:</p>
            <button onclick="searchStock()" style="width: 100%;">🔍 Search Stocks</button>
        </div>
    </div>
    
    <div id="content" style="display: none;">
        <!-- Provider selector -->
        <div class="provider-bar">
            <span class="provider-label">Source</span>
            <select class="provider-select" id="providerSelect" onchange="switchProvider(this.value)">
                <option value="manual">📋 Manual Holdings</option>
                <option value="indmoney">IndMoney</option>
                <option value="zerodha">Zerodha</option>
                <option value="groww">Groww</option>
                <option value="upstox">Upstox</option>
            </select>
        </div>

        <!-- Search Button -->
        <button onclick="searchStock()" class="search-btn" style="width: 100%; margin-bottom: 12px; padding: 8px; display: flex; align-items: center; justify-content: center; gap: 6px; background: var(--vscode-input-background); border: 1px solid var(--border-color);">
            <span style="font-size: 14px;">🔍</span>
            <span>Search & Analyze Any Stock</span>
        </button>

        <div class="summary" id="summary"></div>

        <div class="ai-review-card">
            <div class="ai-review-header">
                <span class="ai-review-title">🤖 AI Portfolio Review</span>
                <button class="ai-review-btn" id="aiReviewBtn" onclick="requestAIReview()">Generate Review</button>
            </div>
        </div>

        <!-- Manual holdings manager (only shown when manual provider is active) -->
        <div id="manualForm" class="manual-form" style="display:none">
            <div class="manual-form-header">
                <span class="manual-form-title">📋 My Holdings</span>
                <button class="manual-add-btn" onclick="showAddRow()">+ Add</button>
            </div>
            <table class="manual-holdings-table" id="manualTable">
                <thead>
                    <tr>
                        <th>Symbol</th>
                        <th>Qty</th>
                        <th>Avg ₹</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody id="manualTableBody"></tbody>
            </table>
            <div id="bulkAddArea" class="bulk-add-area" style="display:none">
                <div class="bulk-add-hint">Add one or more holdings — click "+ Add Row" to add more</div>
                <div class="bulk-header-row">
                    <span>Symbol</span><span>Qty</span><span>Avg ₹</span><span></span>
                </div>
                <div id="bulkRows"></div>
                <button class="manual-add-btn" onclick="addBulkRow()" style="margin-top:5px;width:100%;text-align:center">+ Add Row</button>
                <div id="bulkError" class="bulk-error"></div>
                <div class="bulk-actions">
                    <button class="bulk-import-btn" onclick="saveBulk()">✓ Import All</button>
                    <button class="bulk-cancel-btn" onclick="cancelBulk()">✕ Cancel</button>
                </div>
                <div class="manual-suggestions" id="bulkSuggestions" style="display:none"></div>
            </div>
        </div>

        <div class="section-header">
            <span>Holdings</span>
        </div>
        <div class="sort-chips">
            <button class="sort-chip active" id="sort-zone"   onclick="setSort('zone')">📈 Zone</button>
            <button class="sort-chip"        id="sort-score"  onclick="setSort('score')">⚙ Score</button>
            <button class="sort-chip"        id="sort-pnl"    onclick="setSort('pnl')">P&amp;L %</button>
            <button class="sort-chip"        id="sort-day"    onclick="setSort('day')">Day %</button>
            <button class="sort-chip"        id="sort-az"     onclick="setSort('az')">A–Z</button>
        </div>
        <div class="stock-list" id="stock-list"></div>
        
        <div class="timestamp" id="timestamp"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let _zones = {};
        let _allStocks = [];
        let _activeSort = 'zone';
        let _activeProvider = 'indmoney';
        let _manualHoldings = [];
        let _searchDebounce = null;
        let _editingSymbol = null; // symbol currently being edited (null = adding new)

        // Lower rank = higher priority (best zone first)
        const ZONE_RANK = [
            'Below Strong Buy', 'At Strong Buy',
            'Between Strong Buy & Buy', 'At Buy',
            'Between Buy & Consider', 'At Consider',
            'Between Consider & Fair Value', 'At Fair Value',
            'Between Fair Value & Reduce',
            'At Reduce', 'Above Reduce',
        ];
        function zoneRank(symbol) {
            const z = _zones[symbol] || '';
            const i = ZONE_RANK.findIndex(r => z.includes(r));
            return i === -1 ? 99 : i;
        }

        function sortStocks(stocks) {
            const s = [...stocks];
            if (_activeSort === 'zone')  return s.sort((a, b) => zoneRank(a.symbol) - zoneRank(b.symbol));
            if (_activeSort === 'score') return s.sort((a, b) => b.totalScore - a.totalScore);
            if (_activeSort === 'pnl')   return s.sort((a, b) => b.profitLossPct - a.profitLossPct);
            if (_activeSort === 'day')   return s.sort((a, b) => b.dayChangePct - a.dayChangePct);
            if (_activeSort === 'az')    return s.sort((a, b) => a.symbol.localeCompare(b.symbol));
            return s;
        }

        function setSort(key) {
            _activeSort = key;
            document.querySelectorAll('.sort-chip').forEach(c => c.classList.remove('active'));
            document.getElementById('sort-' + key)?.classList.add('active');
            renderStocks(_allStocks);
        }

        function refresh() { vscode.postMessage({ type: 'refresh' }); }
        function configure() { vscode.postMessage({ type: 'configure' }); }
        function openStock(symbol) { vscode.postMessage({ type: 'openStock', symbol }); }
        function searchStock() { vscode.postMessage({ type: 'searchStock' }); }

        function requestAIReview() {
            const btn = document.getElementById('aiReviewBtn');
            btn.disabled = true;
            btn.textContent = 'Opening…';
            vscode.postMessage({ type: 'aiPortfolioReview', zones: _zones });
            setTimeout(() => { btn.disabled = false; btn.textContent = '↻ Re-generate'; }, 2000);
        }

        function switchProvider(id) {
            vscode.postMessage({ type: 'switchProvider', providerId: id });
        }

        function renderManualTable(holdings) {
            _manualHoldings = holdings || [];
            const tbody = document.getElementById('manualTableBody');
            if (!tbody) return;
            if (_manualHoldings.length === 0) {
                tbody.innerHTML = \`<tr><td colspan="4"><div class="manual-empty">No holdings yet — click + Add to get started</div></td></tr>\`;
                return;
            }
            tbody.innerHTML = _manualHoldings.map(h => \`
                <tr data-sym="\${h.symbol}">
                    <td class="sym-cell">\${h.symbol}<div style="font-size:9px;opacity:0.5;font-weight:400">\${h.name}</div></td>
                    <td>\${h.quantity}</td>
                    <td>₹\${h.avgPrice.toLocaleString('en-IN', {maximumFractionDigits:0})}</td>
                    <td>
                        <div class="manual-row-actions">
                            <button class="manual-row-btn" onclick="editRow('\${h.symbol}')" title="Edit">✎</button>
                            <button class="manual-row-btn delete" onclick="deleteRow('\${h.symbol}')" title="Delete">✕</button>
                        </div>
                    </td>
                </tr>
            \`).join('');
        }

        function showAddRow() {
            _editingSymbol = null;
            document.getElementById('manualInputRow')?.remove();
            _bulkRowData = [{sym:'',name:'',qty:'',price:''}];
            _bulkActiveRow = -1;
            renderBulkRows();
            const area = document.getElementById('bulkAddArea');
            if (area) area.style.display = 'block';
            document.getElementById('bulkError').style.display = 'none';
            setTimeout(() => document.getElementById('bSym-0')?.focus(), 0);
        }

        function editRow(symbol) {
            const h = _manualHoldings.find(x => x.symbol === symbol);
            if (!h) return;
            _editingSymbol = symbol;
            // Remove existing input row if any
            document.getElementById('manualInputRow')?.remove();
            appendInputRow(h.symbol, h.name, h.quantity, h.avgPrice);
        }

        function appendInputRow(sym, name, qty, price) {
            document.getElementById('manualInputRow')?.remove();
            const tbody = document.getElementById('manualTableBody');
            const tr = document.createElement('tr');
            tr.id = 'manualInputRow';
            tr.className = 'manual-input-row';
            tr.innerHTML = \`
                <td colspan="2">
                    <div class="manual-search-wrap">
                        <input class="manual-input" id="inSym" placeholder="Search symbol…"
                            value="\${sym}" autocomplete="off" oninput="onSymInput(this.value)">
                        <input type="hidden" id="inName" value="\${name}">
                        <div class="manual-suggestions" id="manualSuggestions" style="display:none"></div>
                    </div>
                </td>
                <td><input class="manual-input" id="inQty" type="number" min="0.001" step="any" placeholder="Qty" value="\${qty}"></td>
                <td>
                    <input class="manual-input" id="inPrice" type="number" min="0" step="0.01" placeholder="Avg ₹" value="\${price}" style="margin-bottom:4px">
                    <div style="display:flex;gap:4px;margin-top:3px">
                        <button class="manual-save-btn" onclick="saveRow()">✓</button>
                        <button class="manual-cancel-btn" onclick="cancelRow()">✕</button>
                    </div>
                </td>
            \`;
            tbody.appendChild(tr);
            document.getElementById('inSym')?.focus();
        }

        // Store last results by index so onclick never embeds data in HTML
        let _sugResults = [];

        function onSymInput(val) {
            clearTimeout(_searchDebounce);
            const sugBox = document.getElementById('manualSuggestions');
            if (!val || val.length < 1) {
                if (sugBox) sugBox.style.display = 'none';
                _sugResults = [];
                return;
            }
            _searchDebounce = setTimeout(() => {
                vscode.postMessage({ type: 'searchStocksManual', query: val });
            }, 150);
        }

        function renderSuggestions(results) {
            const sugBox = document.getElementById('manualSuggestions');
            if (!sugBox) return;
            _sugResults = results || [];
            if (_sugResults.length === 0) { sugBox.style.display = 'none'; return; }
            sugBox.innerHTML = _sugResults.slice(0, 8).map((r, i) => \`
                <div class="manual-suggestion" data-idx="\${i}">
                    <span class="sug-sym">\${r.symbol}</span>
                    <span class="sug-name">\${r.name}</span>
                </div>
            \`).join('');
            sugBox.style.visibility='hidden';
            sugBox.style.display = 'block';
            requestAnimationFrame(() => { const inp = document.getElementById('inSym');
            if(!inp || !sugBox) return;
            const rect = inp.getBoundingClientRect();
            const boxH = sugBox.offsetHeight;
            sugBox.style.left = rect. left + 'px';
            sugBox.style.width = rect.width + 'px';
            sugBox.style.top = (rect.top - boxH - 4)+ 'px';
            sugBox.style.visibility = 'visible';
            });

            // Single delegated listener — replace any old one
            sugBox.onclick = (e) => {
                const row = e.target.closest('.manual-suggestion');
                if (!row) return;
                const idx = parseInt(row.dataset.idx, 10);
                const picked = _sugResults[idx];
                if (picked) selectSuggestion(picked.symbol, picked.name);
            };
        }

        function selectSuggestion(symbol, name) {
            const inSym = document.getElementById('inSym');
            const inName = document.getElementById('inName');
            const sugBox = document.getElementById('manualSuggestions');
            if (inSym) inSym.value = symbol;
            if (inName) inName.value = name;
            _sugResults = [];
            if (sugBox) sugBox.style.display = 'none';
            document.getElementById('inQty')?.focus();
        }

        // Hide suggestions when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.manual-search-wrap')) {
                const sugBox = document.getElementById('manualSuggestions');
                if (sugBox) sugBox.style.display = 'none';
            }
        });

        function saveRow() {
            const sym = document.getElementById('inSym')?.value?.trim().toUpperCase();
            const name = document.getElementById('inName')?.value?.trim() || sym;
            const qty = parseFloat(document.getElementById('inQty')?.value || '0');
            const price = parseFloat(document.getElementById('inPrice')?.value || '0');
            if (!sym || qty <= 0 || price <= 0) {
                document.getElementById('inSym')?.focus();
                return;
            }
            const type = _editingSymbol ? 'manualUpdate' : 'manualAdd';
            vscode.postMessage({ type, holding: { symbol: sym, name, quantity: qty, avgPrice: price, exchange: 'NSE' } });
            document.getElementById('manualInputRow')?.remove();
            _editingSymbol = null;
        }

        function cancelRow() {
            document.getElementById('manualInputRow')?.remove();
            _editingSymbol = null;
        }

        // Bulk add state
        let _bulkRowData = []; // [{sym, name, qty, price}, ...]
        let _bulkActiveRow = -1;
        let _bulkSugResults = [];
        let _bulkSugDebounce = null;

function cancelBulk() {
            const area = document.getElementById('bulkAddArea');
            if (area) area.style.display = 'none';
            const sugBox = document.getElementById('bulkSuggestions');
            if (sugBox) sugBox.style.display = 'none';
            _bulkRowData = [];
            _bulkActiveRow = -1;
        }

        function addBulkRow() {
            // Sync current DOM values before adding
            _bulkRowData.forEach((_, i) => syncBulkRow(i));
            _bulkRowData.push({sym:'',name:'',qty:'',price:''});
            renderBulkRows();
            const i = _bulkRowData.length - 1;
            setTimeout(() => document.getElementById(\`bSym-\${i}\`)?.focus(), 0);
        }

        function removeBulkRow(i) {
            if (_bulkRowData.length <= 1) return;
            _bulkRowData.splice(i, 1);
            renderBulkRows();
        }

        function syncBulkRow(i) {
            const sym = document.getElementById(\`bSym-\${i}\`)?.value?.trim().toUpperCase() || '';
            const name = document.getElementById(\`bName-\${i}\`)?.value?.trim() || sym;
            const qty = document.getElementById(\`bQty-\${i}\`)?.value || '';
            const price = document.getElementById(\`bPrice-\${i}\`)?.value || '';
            if (_bulkRowData[i]) _bulkRowData[i] = {sym, name, qty, price};
        }

        function renderBulkRows() {
            const container = document.getElementById('bulkRows');
            if (!container) return;
            container.innerHTML = _bulkRowData.map((r, i) => \`
                <div class="bulk-row" id="bulkRow-\${i}">
                    <div style="position:relative">
                        <input class="manual-input" id="bSym-\${i}" placeholder="Search symbol…"
                            value="\${r.sym}" autocomplete="off" oninput="onBulkSymInput(\${i}, this.value)">
                        <input type="hidden" id="bName-\${i}" value="\${r.name}">
                    </div>
                    <input class="manual-input" id="bQty-\${i}" type="number" min="0.001" step="any" placeholder="Qty" value="\${r.qty}">
                    <input class="manual-input" id="bPrice-\${i}" type="number" min="0" step="0.01" placeholder="Avg ₹" value="\${r.price}">
                    <button class="manual-row-btn delete" onclick="removeBulkRow(\${i})" title="Remove">✕</button>
                </div>
            \`).join('');
        }

        function onBulkSymInput(i, val) {
            _bulkActiveRow = i;
            if (_bulkRowData[i]) { _bulkRowData[i].sym = val; _bulkRowData[i].name = ''; }
            const hiddenName = document.getElementById(\`bName-\${i}\`);
            if (hiddenName) hiddenName.value = '';
            clearTimeout(_bulkSugDebounce);
            const sugBox = document.getElementById('bulkSuggestions');
            if (!val || val.length < 1) { if (sugBox) sugBox.style.display = 'none'; _bulkSugResults = []; return; }
            _bulkSugDebounce = setTimeout(() => {
                vscode.postMessage({ type: 'searchStocksManual', query: val, context: 'bulk', rowIdx: i });
            }, 150);
        }

        function renderBulkSuggestions(results, rowIdx) {
            const sugBox = document.getElementById('bulkSuggestions');
            if (!sugBox) return;
            _bulkSugResults = results || [];
            if (_bulkSugResults.length === 0 || _bulkActiveRow !== rowIdx) { sugBox.style.display = 'none'; return; }
            sugBox.innerHTML = _bulkSugResults.slice(0, 8).map((r, idx) => \`
                <div class="manual-suggestion" data-idx="\${idx}">
                    <span class="sug-sym">\${r.symbol}</span>
                    <span class="sug-name">\${r.name}</span>
                </div>
            \`).join('');
            sugBox.style.visibility = 'hidden';
            sugBox.style.display = 'block';
            requestAnimationFrame(() => {
                const inp = document.getElementById(\`bSym-\${rowIdx}\`);
                if (!inp || !sugBox) return;
                const rect = inp.getBoundingClientRect();
                const boxH = sugBox.offsetHeight;
                sugBox.style.left = rect.left + 'px';
                sugBox.style.width = rect.width + 'px';
                sugBox.style.top = (rect.top - boxH - 4) + 'px';
                sugBox.style.visibility = 'visible';
            });
            sugBox.onclick = (e) => {
                const row = e.target.closest('.manual-suggestion');
                if (!row) return;
                const idx = parseInt(row.dataset.idx, 10);
                const picked = _bulkSugResults[idx];
                if (picked) selectBulkSuggestion(rowIdx, picked.symbol, picked.name);
            };
        }

        function selectBulkSuggestion(i, symbol, name) {
            const inSym = document.getElementById(\`bSym-\${i}\`);
            const inName = document.getElementById(\`bName-\${i}\`);
            if (inSym) inSym.value = symbol;
            if (inName) inName.value = name;
            if (_bulkRowData[i]) { _bulkRowData[i].sym = symbol; _bulkRowData[i].name = name; }
            _bulkSugResults = [];
            const sugBox = document.getElementById('bulkSuggestions');
            if (sugBox) sugBox.style.display = 'none';
            document.getElementById(\`bQty-\${i}\`)?.focus();
        }

        // Hide bulk suggestions when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#bulkRows') && !e.target.closest('#bulkSuggestions')) {
                const sugBox = document.getElementById('bulkSuggestions');
                if (sugBox) sugBox.style.display = 'none';
            }
        });

        function saveBulk() {
            _bulkRowData.forEach((_, i) => syncBulkRow(i));
            const errEl = document.getElementById('bulkError');
            const filled = _bulkRowData.filter(r => r.sym || r.qty || r.price);
            if (!filled.length) { errEl.textContent = 'Please fill in at least one stock.'; errEl.style.display = 'block'; return; }

            const holdings = [];
            const errors = [];
            filled.forEach((r, i) => {
                const sym = r.sym.toUpperCase();
                const qty = parseFloat(r.qty);
                const price = parseFloat(r.price);
                if (!sym) { errors.push(\`Row \${i+1}: missing symbol\`); return; }
                if (!isFinite(qty) || qty <= 0) { errors.push(\`\${sym}: invalid qty\`); return; }
                if (!isFinite(price) || price <= 0) { errors.push(\`\${sym}: invalid price\`); return; }
                holdings.push({ symbol: sym, name: r.name || sym, quantity: qty, avgPrice: price, exchange: 'NSE' });
            });

            if (errors.length) { errEl.textContent = errors.join(' | '); errEl.style.display = 'block'; return; }

            vscode.postMessage({ type: 'manualBulkAdd', holdings });
            cancelBulk();
        }

        function deleteRow(symbol) {
            vscode.postMessage({ type: 'manualDelete', symbol });
        }

        const ZONE_CLASS = {
            'Below Strong Buy':              'zone-sb',
            'At Strong Buy':                 'zone-sb',
            'Between Strong Buy & Buy':      'zone-b',
            'At Buy':                        'zone-b',
            'Between Buy & Consider':        'zone-c',
            'At Consider':                   'zone-c',
            'Between Consider & Fair Value': 'zone-fv',
            'At Fair Value':                 'zone-fv',
            'Between Fair Value & Reduce':   'zone-btw',
            'At Reduce':                     'zone-r',
            'Above Reduce':                  'zone-r',
        };
        function getZoneClass(label) {
            if (!label) return '';
            for (const [key, cls] of Object.entries(ZONE_CLASS)) {
                if (label.includes(key)) return cls;
            }
            return 'zone-btw';
        }
        
        function formatCurrency(value, currency) {
            if (currency === 'USD') {
                if (Math.abs(value) >= 1000000000) return '$' + (value / 1000000000).toFixed(2) + 'B';
                if (Math.abs(value) >= 1000000) return '$' + (value / 1000000).toFixed(2) + 'M';
                if (Math.abs(value) >= 1000) return '$' + (value / 1000).toFixed(1) + 'K';
                return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 2 });
            }
            if (Math.abs(value) >= 10000000) return '₹' + (value / 10000000).toFixed(2) + ' Cr';
            if (Math.abs(value) >= 100000) return '₹' + (value / 100000).toFixed(2) + ' L';
            return '₹' + value.toLocaleString('en-IN', { maximumFractionDigits: 0 });
        }
        function fmtPrice(value, currency) {
            if (currency === 'USD') return '$' + value.toFixed(2);
            return '₹' + value.toFixed(2);
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
        
        function renderSummary(summary, stocks) {
            const pnlPos = summary.totalPnL >= 0;
            const dayPos = (summary.dayPnL || 0) >= 0;
            const score = summary.avgScore || 0;
            const scoreCardClass = score >= 7 ? 'positive-card' : score >= 5 ? 'warning-card' : 'negative-card';
            const scoreValClass  = score >= 7 ? 'positive'      : score >= 5 ? 'warning'      : 'negative';
            const investedLabel = formatCurrency(summary.totalInvested, 'INR');
            const currentLabel  = formatCurrency(summary.currentValue, 'INR');
            const pnlLabel      = formatCurrency(summary.totalPnL, 'INR');
            const dayPnlLabel   = formatCurrency(summary.dayPnL || 0, 'INR');
            document.getElementById('summary').innerHTML = \`
                <div class="summary-card invested-card">
                    <div class="label">Invested</div>
                    <div class="value">\${investedLabel}</div>
                </div>
                <div class="summary-card current-card">
                    <div class="label">Current</div>
                    <div class="value">\${currentLabel}</div>
                </div>
                <div class="summary-card \${pnlPos ? 'positive-card' : 'negative-card'}">
                    <div class="label">Total P&L</div>
                    <div class="value \${pnlPos ? 'positive' : 'negative'}">\${pnlPos ? '+' : ''}\${pnlLabel}</div>
                    <div style="font-size:10px;margin-top:2px;opacity:0.7" class="\${pnlPos ? 'positive' : 'negative'}">\${pnlPos ? '+' : ''}\${summary.totalPnLPct.toFixed(1)}%</div>
                </div>
                <div class="summary-card \${dayPos ? 'positive-card' : 'negative-card'}">
                    <div class="label">Today's P&L</div>
                    <div class="value \${dayPos ? 'positive' : 'negative'}">\${dayPos ? '+' : ''}\${dayPnlLabel}</div>
                    <div style="font-size:10px;margin-top:2px;opacity:0.7" class="\${dayPos ? 'positive' : 'negative'}">\${dayPos ? '+' : ''}\${(summary.dayPnLPct || 0).toFixed(2)}%</div>
                </div>
                <div class="summary-card full \${scoreCardClass}">
                    <div class="label">Avg Portfolio Score</div>
                    <div class="value \${scoreValClass}">\${score.toFixed(1)}<span style="font-size:11px;opacity:0.6">/10</span></div>
                </div>
            \`;
        }
        
        function addToWatchlist(symbol, event) {
            event.stopPropagation();
            vscode.postMessage({ type: 'addToWatchlist', symbol });
        }

        function renderStocks(stocks) {
            _allStocks = stocks;
            const sorted = sortStocks(stocks);
            document.getElementById('stock-list').innerHTML = sorted.map(stock => {
                const zone = _zones[stock.symbol];
                const sc = getScoreClass(stock.totalScore);
                const barWidth = (stock.totalScore / 10 * 100).toFixed(0);
                const cur = stock.currency || 'INR';
                return \`
                <div class="stock-item" onclick="openStock('\${stock.symbol}')">
                    <div class="stock-row">
                        <div class="stock-left">
                            <div class="stock-symbol-row">
                                <span class="stock-symbol">\${stock.symbol}</span>

                                <button class="add-watchlist-btn" onclick="addToWatchlist('\${stock.symbol}', event)" title="Add to watchlist">+</button>
                            </div>
                            <span class="stock-name">\${stock.name}</span>
                        </div>
                        <div class="stock-right">
                            <div class="stock-price">\${fmtPrice(stock.currentPrice, cur)}</div>
                            <div class="stock-pnl \${stock.profitLossPct >= 0 ? 'positive' : 'negative'}">
                                \${stock.profitLossPct >= 0 ? '▲' : '▼'} \${Math.abs(stock.profitLossPct).toFixed(1)}%
                            </div>
                        </div>
                    </div>
                    <div class="stock-metrics">
                        <div class="metric-row">
                            <span class="metric-label">⚙ Fundamentals</span>
                            <div class="score-bar-wrap">
                                <div class="score-bar">
                                    <div class="score-bar-fill \${sc}" style="width:\${barWidth}%"></div>
                                </div>
                                <span class="score-num \${sc}">\${stock.totalScore}</span>
                            </div>
                            <span class="verdict-badge \${getVerdictClass(stock.verdict)}">\${stock.verdictEmoji} \${stock.verdict}</span>
                        </div>
                        \${zone ? \`
                        <div class="metric-row">
                            <span class="metric-label">📈 Zone</span>
                            <span class="zone-pill \${getZoneClass(zone)}">\${zone}</span>
                        </div>\` : ''}
                    </div>
                </div>\`;
            }).join('');

            document.getElementById('timestamp').textContent = 'Updated: ' + new Date().toLocaleTimeString();
        }
        
        const STATE_MESSAGES = new Set(['loading', 'error', 'notConfigured', 'data']);

        function setView(show) {
            document.getElementById('loading').style.display = show === 'loading' ? 'block' : 'none';
            document.getElementById('error').style.display = show === 'error' ? 'block' : 'none';
            document.getElementById('not-configured').style.display = show === 'notConfigured' ? 'block' : 'none';
            document.getElementById('content').style.display = show === 'data' ? 'block' : 'none';
        }

        window.addEventListener('message', event => {
            const message = event.data;

            // Only switch visible panel for state-changing messages
            if (STATE_MESSAGES.has(message.type)) { setView(message.type); }

            switch (message.type) {
                case 'loading':
                    break;
                case 'error':
                    document.getElementById('error').innerHTML = '❌ ' + message.message;
                    break;
                case 'notConfigured':
                    _activeProvider = message.activeProvider || 'indmoney';
                    ['providerSelect','providerSelectNC'].forEach(id => {
                        const el = document.getElementById(id);
                        if (el) el.value = _activeProvider;
                    });
                    break;
                case 'data': {
                    _zones = message.zones || {};
                    _activeProvider = message.activeProvider || 'indmoney';
                    // Sync provider selector
                    const sel = document.getElementById('providerSelect');
                    if (sel) sel.value = _activeProvider;
                    // Show/hide manual form
                    const mf = document.getElementById('manualForm');
                    if (mf) mf.style.display = _activeProvider === 'manual' ? 'block' : 'none';
                    renderManualTable(message.manualHoldings || []);
                    renderSummary(message.portfolio.summary, message.portfolio.stocks);
                    renderStocks(message.portfolio.stocks);
                    break;
                }
                case 'manualSearchResults':
                    if (message.context === 'bulk') {
                        renderBulkSuggestions(message.results, message.rowIdx);
                    } else {
                        renderSuggestions(message.results);
                    }
                    break;
            }
        });
        
        document.getElementById('loading').style.display = 'block';
    </script>
</body>
</html>`;
  }
}