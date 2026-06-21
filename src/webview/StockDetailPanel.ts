/**
 * Stock Detail Panel
 * Opens in a separate editor tab with full detailed analysis and charts
 */

import * as vscode from "vscode";
import { StockAnalysis } from "../services/AnalysisService";
import { FundamentalData } from "../providers/IPortfolioProvider";

export class StockDetailPanel {
  public static readonly viewType = "portfolioAnalyzer.stockDetail";

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _onDidDisposeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidDispose = this._onDidDisposeEmitter.event;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
    private _stock: StockAnalysis,
  ) {
    this._panel = vscode.window.createWebviewPanel(
      StockDetailPanel.viewType,
      `📈 ${_stock.symbol} Analysis`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._extensionUri],
      },
    );

    this._panel.webview.html = this._getHtmlForWebview(this._stock);
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.type === "showScoringInfo") {
          vscode.commands.executeCommand("portfolioAnalyzer.showScoringInfo");
        } else if (message.type === "openUrl" && message.url) {
          vscode.env.openExternal(vscode.Uri.parse(message.url));
        } else if (message.type === "generateProsConsAI") {
          const html = await this._generateProsConsWithAI(
            message.symbol,
            message.fundamentals,
            message.priceTargets,
          );
          this._panel.webview.postMessage({ type: "prosConsResult", html });
        } else if (message.type === "suggestPricesAI") {
          const key = `priceTargetHistory_${message.symbol}`;
          const history: any[] = this._context.globalState.get(key) || [];
          const targets = await this._suggestPricesWithAI(
            message.symbol,
            message.stock,
            message.fundamentals,
            history,
          );
          if (targets) {
            const { reasoning, summary, ...prices } = targets;
            const entry = {
              date: new Date().toISOString(),
              priceAtSuggestion: message.stock.currentPrice,
              targets: prices,
              reasoning,
              summary,
            };
            const today = new Date().toDateString();
            const idx = history.findIndex(
              (h) => new Date(h.date).toDateString() === today,
            );
            if (idx >= 0) {
              history[idx] = entry; // replace today's entry
            } else {
              history.push(entry);
            }
            await this._context.globalState.update(key, history);
          }
          this._panel.webview.postMessage({
            type: "priceSuggestionsResult",
            targets,
            history: this._context.globalState.get(key) || [],
          });
        } else if (message.type === "loadPriceTargets") {
          const key = `priceTargetHistory_${message.symbol}`;
          const history: any[] = this._context.globalState.get(key) || [];
          const latest =
            history.length > 0 ? history[history.length - 1].targets : null;
          this._panel.webview.postMessage({
            type: "priceTargetsLoaded",
            targets: latest,
            history,
          });
        } else if (message.type === "fetchPriceHistory") {
          try {
            const yhSym = encodeURIComponent(
              message.symbol.replace("-EQ", "") + ".NS",
            );
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yhSym}?interval=${message.interval}&range=${message.range}`;
            const res = await fetch(url);
            const json = (await res.json()) as any;
            const result = json?.chart?.result?.[0];
            if (!result) {
              throw new Error("No data returned");
            }
            this._panel.webview.postMessage({
              type: "priceHistoryData",
              timestamps: result.timestamp,
              closes: result.indicators?.quote?.[0]?.close,
            });
          } catch (e: any) {
            this._panel.webview.postMessage({
              type: "priceHistoryError",
              message: e.message || "Fetch failed",
            });
          }
        } else if (message.type === "deleteTargetEntry") {
          const key = `priceTargetHistory_${message.symbol}`;
          const history: any[] = this._context.globalState.get(key) || [];
          history.splice(message.index, 1);
          await this._context.globalState.update(key, history);
          this._panel.webview.postMessage({
            type: "targetEntryDeleted",
            history,
          });
        }
      },
      null,
      this._disposables,
    );
  }

  public reveal() {
    this._panel.reveal(vscode.ViewColumn.One);
  }

  public update(stock: StockAnalysis) {
    this._stock = stock;
    this._panel.title = `📈 ${stock.symbol} Analysis`;
    this._panel.webview.html = this._getHtmlForWebview(stock);
  }

  private async _generateProsConsWithAI(
    symbol: string,
    f: any,
    priceTargets?: any,
  ): Promise<string> {
    try {
      const models = await vscode.lm.selectChatModels({ family: "claude" });
      const model = models[0] ?? (await vscode.lm.selectChatModels())[0];
      if (!model) {
        return '<p style="opacity:0.5;font-size:12px">AI analysis unavailable — no Copilot model found.</p>';
      }

      const addMetric = (
        val: number | null | undefined,
        label: string,
        fmt: (v: number) => string,
      ): string | null =>
        val !== null && val !== undefined ? `${label}: ${fmt(val)}` : null;
      const pct = (v: number) => `${v.toFixed(1)}%`;
      const sign = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
      const metrics = [
        addMetric(f.pe, "P/E", (v) => v.toFixed(1)),
        addMetric(f.indPE, "Industry P/E", (v) => v.toFixed(1)),
        addMetric(f.roe, "ROE", pct),
        addMetric(f.roce, "ROCE", pct),
        addMetric(f.debtToEquity, "D/E", (v) => v.toFixed(2)),
        addMetric(f.salesGrowth3Y, "Revenue CAGR 3Y", pct),
        addMetric(f.salesGrowth5Y, "Revenue CAGR 5Y", pct),
        addMetric(f.profitGrowth3Y, "Profit CAGR 3Y", pct),
        addMetric(f.profitGrowth5Y, "Profit CAGR 5Y", pct),
        addMetric(f.salesGrowthTTM, "Revenue TTM growth", pct),
        addMetric(f.profitGrowthTTM, "Profit TTM growth", pct),
        addMetric(f.promoterHolding, "Promoter holding", pct),
        addMetric(f.promoterHoldingChange, "Promoter change QoQ", sign),
        addMetric(f.divYield, "Dividend yield", (v) => `${v.toFixed(2)}%`),
        addMetric(f.beta, "Beta", (v) => v.toFixed(2)),
      ]
        .filter(Boolean)
        .join("\n");

      const targetsContext = priceTargets
        ? `\nPrice Targets set by analyst:\n${Object.entries(priceTargets)
            .map(([k, v]) => `  ${k}: ₹${v}`)
            .join("\n")}`
        : "";

      const prompt = `You are a concise Indian equity analyst. Based ONLY on the metrics below for ${symbol}, generate exactly 3 strengths and 3 concerns. Be specific to these numbers — no generic statements. Consider the price targets if provided — if current price is near or above Strong Buy, mention it as a strength; if near or above Reduce, mention it as a concern.

Metrics:
${metrics}${targetsContext}

Respond in this exact JSON format (no markdown):
{"pros":["...","...","..."],"cons":["...","...","..."]}`;

      const messages = [vscode.LanguageModelChatMessage.User(prompt)];
      const response = await model.sendRequest(messages, {});

      let text = "";
      for await (const chunk of response.stream) {
        if (chunk instanceof vscode.LanguageModelTextPart) {
          text += chunk.value;
        }
      }

      const parsed = JSON.parse(text.trim());
      const pros: string[] = parsed.pros || [];
      const cons: string[] = parsed.cons || [];

      return `<div class="pros-cons-grid">
                <div class="pros">
                    <h4>✅ Strengths</h4>
                    <ul class="pros-cons-list">${pros.map((p) => `<li>${p}</li>`).join("")}</ul>
                </div>
                <div class="cons">
                    <h4>❌ Concerns</h4>
                    <ul class="pros-cons-list">${cons.map((c) => `<li>${c}</li>`).join("")}</ul>
                </div>
            </div>`;
    } catch (e: unknown) {
      console.error("AI pros/cons generation failed:", e);
      return '<p style="opacity:0.5;font-size:12px">AI analysis could not be generated.</p>';
    }
  }

  private async _suggestPricesWithAI(
    symbol: string,
    stock: any,
    f: any,
    history: any[] = [],
  ): Promise<any> {
    try {
      const models = await vscode.lm.selectChatModels({ family: "claude" });
      const model = models[0] ?? (await vscode.lm.selectChatModels())[0];
      if (!model) {
        return null;
      }

      const addMetric = (
        val: number | null | undefined,
        label: string,
        fmt: (v: number) => string,
      ): string | null =>
        val !== null && val !== undefined ? `${label}: ${fmt(val)}` : null;
      const pct = (v: number) => `${v.toFixed(1)}%`;

      const metrics = [
        `Current Price: ₹${stock.currentPrice?.toFixed(2)}`,
        `Total Score: ${stock.totalScore}/10`,
        `Verdict: ${stock.verdict}`,
        addMetric(f.pe, "P/E", (v) => v.toFixed(1)),
        addMetric(f.indPE, "Industry P/E", (v) => v.toFixed(1)),
        addMetric(f.eps, "EPS", (v) => `₹${v.toFixed(2)}`),
        addMetric(f.bookValue, "Book Value", (v) => `₹${v.toFixed(2)}`),
        addMetric(f.roe, "ROE", pct),
        addMetric(f.roce, "ROCE", pct),
        addMetric(f.debtToEquity, "D/E", (v) => v.toFixed(2)),
        addMetric(f.salesGrowth3Y, "Revenue CAGR 3Y", pct),
        addMetric(f.profitGrowth3Y, "Profit CAGR 3Y", pct),
        addMetric(f.profitGrowth5Y, "Profit CAGR 5Y", pct),
        addMetric(f.promoterHolding, "Promoter holding", pct),
        stock.scores?.valuation != null
          ? `Valuation score: ${stock.scores.valuation}/10`
          : null,
        stock.scores?.revenueGrowth != null
          ? `Growth score: ${stock.scores.revenueGrowth}/10`
          : null,
        stock.scores?.risk != null
          ? `Risk score: ${stock.scores.risk}/10`
          : null,
        addMetric(stock.high52w, "52W High", (v) => `₹${v.toFixed(2)}`),
        addMetric(stock.low52w, "52W Low", (v) => `₹${v.toFixed(2)}`),
      ]
        .filter(Boolean)
        .join("\n");

      const prompt = `You are a precise Indian equity analyst. Based on the metrics below for ${symbol}, suggest exact rupee price targets for 5 levels.

Rules:
- Strong Buy: price at which the stock is deeply undervalued — a high-conviction entry. Must be BELOW current price.
- Buy: good value entry. Below or near current price.
- Consider: fair entry zone. Close to current price.
- Fair Value: intrinsic value estimate based on earnings/book value/growth. Can be above or below current price.
- Reduce: price at which the stock looks expensive and one should trim. ABOVE current price.

Derive each price from the actual metrics (use P/E, EPS, book value, growth rates, score). Show your work is grounded in numbers — do NOT just apply arbitrary % discounts.

Metrics:
${metrics}
${
  history.length > 0
    ? `
Previous AI suggestions for ${symbol} (use these for context — understand how the stock has moved since last suggestion and adjust accordingly):
${history
  .slice(-5)
  .map((h: any) => {
    const d = new Date(h.date).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const t = h.targets;
    return `  [${d} @ ₹${h.priceAtSuggestion?.toFixed(0)}] Strong Buy: ₹${t.strongBuy}  Buy: ₹${t.buy}  Consider: ₹${t.consider}  Fair: ₹${t.fair}  Reduce: ₹${t.reduce}`;
  })
  .join("\n")}
Current price is ₹${stock.currentPrice?.toFixed(2)} — adjust targets if the stock has moved significantly since last suggestion.`
    : ""
}

Respond ONLY in this exact JSON (no markdown, no extra text):
{"strongBuy":0,"buy":0,"consider":0,"fair":0,"reduce":0,"summary":"2-3 plain sentences a beginner can understand — explain whether the stock is cheap or expensive right now, what price range makes sense to buy, and one honest opinion on the stock. No jargon. Example: 'TCS is a strong company but currently trading at a premium. At current prices the upside is limited — a better buying opportunity would be around ₹3,200–3,400. Wait for a dip rather than buying now.'","reasoning":{"strongBuy":"one sentence why","buy":"one sentence why","consider":"one sentence why","fair":"one sentence why","reduce":"one sentence why"}}`;

      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
      );
      let text = "";
      for await (const chunk of response.stream) {
        if (chunk instanceof vscode.LanguageModelTextPart) {
          text += chunk.value;
        }
      }

      // Extract the outermost JSON object (handles nested reasoning object)
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end === -1) {
        return null;
      }
      const parsed = JSON.parse(text.slice(start, end + 1));

      // Validate — all price levels must be positive numbers
      const keys = ["strongBuy", "buy", "consider", "fair", "reduce"];
      for (const k of keys) {
        if (typeof parsed[k] !== "number" || parsed[k] <= 0) {
          return null;
        }
        parsed[k] = Math.round(parsed[k] * 100) / 100;
      }
      return parsed;
    } catch (e: unknown) {
      console.error("AI price suggestion failed:", e);
      return null;
    }
  }

  /**
   * Generate AI price targets for a stock and save to globalState.
   * Used by sidebar refresh to auto-generate for stocks with no entry today.
   */
  public static async generateAndSaveTargets(
    context: vscode.ExtensionContext,
    stock: StockAnalysis,
  ): Promise<any | null> {
    const key = `priceTargetHistory_${stock.symbol}`;
    const history: any[] = context.globalState.get(key) || [];

    // Skip if already generated today
    const today = new Date().toDateString();
    if (history.some((h) => new Date(h.date).toDateString() === today)) {
      return history[history.length - 1].targets;
    }

    try {
      const models = await vscode.lm.selectChatModels({ family: "claude" });
      const model = models[0] ?? (await vscode.lm.selectChatModels())[0];
      if (!model) return null;

      const f = stock.fundamentals;
      const pct = (v: number) => `${v.toFixed(1)}%`;
      const addMetric = (val: number | null | undefined, label: string, fmt: (v: number) => string): string | null =>
        val !== null && val !== undefined ? `${label}: ${fmt(val)}` : null;

      const metrics = [
        `Current Price: ₹${stock.currentPrice?.toFixed(2)}`,
        `Total Score: ${stock.totalScore}/10`,
        `Verdict: ${stock.verdict}`,
        addMetric(f?.pe, "P/E", (v) => v.toFixed(1)),
        addMetric(f?.indPE, "Industry P/E", (v) => v.toFixed(1)),
        addMetric(f?.eps, "EPS", (v) => `₹${v.toFixed(2)}`),
        addMetric(f?.bookValue, "Book Value", (v) => `₹${v.toFixed(2)}`),
        addMetric(f?.roe, "ROE", pct),
        addMetric(f?.roce, "ROCE", pct),
        addMetric(f?.debtToEquity, "D/E", (v) => v.toFixed(2)),
        addMetric(f?.salesGrowth3Y, "Revenue CAGR 3Y", pct),
        addMetric(f?.profitGrowth3Y, "Profit CAGR 3Y", pct),
        addMetric(f?.promoterHolding, "Promoter holding", pct),
        addMetric(stock.high52w, "52W High", (v) => `₹${v.toFixed(2)}`),
        addMetric(stock.low52w, "52W Low", (v) => `₹${v.toFixed(2)}`),
      ].filter(Boolean).join("\n");

      const histCtx = history.length > 0
        ? `\nPrevious suggestions:\n${history.slice(-3).map((h: any) => {
            const d = new Date(h.date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
            const t = h.targets;
            return `  [${d} @ ₹${h.priceAtSuggestion?.toFixed(0)}] Strong Buy: ₹${t.strongBuy}  Buy: ₹${t.buy}  Consider: ₹${t.consider}  Fair: ₹${t.fair}  Reduce: ₹${t.reduce}`;
          }).join("\n")}\nCurrent price is ₹${stock.currentPrice?.toFixed(2)} — adjust if stock moved significantly.`
        : "";

      const prompt = `You are a precise Indian equity analyst. Based on the metrics below for ${stock.symbol}, suggest exact rupee price targets for 5 levels.\n\nRules:\n- Strong Buy: deeply undervalued, high-conviction entry. Must be BELOW current price.\n- Buy: good value entry. Below or near current price.\n- Consider: fair entry zone. Close to current price.\n- Fair Value: intrinsic value estimate. Can be above or below current price.\n- Reduce: expensive, trim here. ABOVE current price.\n\nDerive each price from the actual metrics.\n\nMetrics:\n${metrics}${histCtx}\n\nRespond ONLY in this exact JSON (no markdown):\n{"strongBuy":0,"buy":0,"consider":0,"fair":0,"reduce":0,"summary":"2-3 plain sentences","reasoning":{"strongBuy":"one sentence","buy":"one sentence","consider":"one sentence","fair":"one sentence","reduce":"one sentence"}}`;

      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)], {},
      );
      let text = "";
      for await (const chunk of response.stream) {
        if (chunk instanceof vscode.LanguageModelTextPart) text += chunk.value;
      }

      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end === -1) return null;
      const parsed = JSON.parse(text.slice(start, end + 1));

      const priceKeys = ["strongBuy", "buy", "consider", "fair", "reduce"];
      for (const k of priceKeys) {
        if (typeof parsed[k] !== "number" || parsed[k] <= 0) return null;
        parsed[k] = Math.round(parsed[k] * 100) / 100;
      }

      const { reasoning, summary, ...prices } = parsed;
      const entry = {
        date: new Date().toISOString(),
        priceAtSuggestion: stock.currentPrice,
        targets: prices,
        reasoning,
        summary,
      };

      const idx = history.findIndex((h) => new Date(h.date).toDateString() === today);
      if (idx >= 0) { history[idx] = entry; } else { history.push(entry); }
      await context.globalState.update(key, history);

      return prices;
    } catch (e) {
      console.error(`AI target generation failed for ${stock.symbol}:`, e);
      return null;
    }
  }

  public dispose() {
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
    this._onDidDisposeEmitter.fire();
  }

  private _getHtmlForWebview(stock: StockAnalysis): string {
    const f: Partial<FundamentalData> = stock.fundamentals || {};
    const stockJson = JSON.stringify(stock);

    // Helper function to render trend badge
    const renderTrendBadge = (change: number | null | undefined): string => {
      if (change === null || change === undefined) {
        return '<span class="holding-trend neutral">--</span>';
      }
      if (change > 0) {
        return `<span class="holding-trend up">▲ +${change.toFixed(1)}%</span>`;
      } else if (change < 0) {
        return `<span class="holding-trend down">▼ ${change.toFixed(1)}%</span>`;
      }
      return '<span class="holding-trend neutral">→ 0%</span>';
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src * data:; connect-src *;">
    <title>${stock.symbol} Analysis</title>
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
        }

        /* Header */
        .header {
            background: linear-gradient(135deg, #1f3056 0%, #16213e 100%);
            padding: 24px 32px;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
        }
        
        .stock-info h1 {
            font-size: 28px;
            font-weight: 700;
            color: var(--accent);
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .stock-info .name {
            font-size: 16px;
            color: var(--text-secondary);
            margin-top: 4px;
        }
        
        .stock-info .sector {
            display: inline-block;
            margin-top: 8px;
            padding: 4px 12px;
            background: rgba(124, 77, 255, 0.15);
            color: var(--accent-secondary);
            border-radius: 16px;
            font-size: 12px;
        }
        
        .header-right {
            text-align: right;
        }
        
        .price-display {
            font-size: 32px;
            font-weight: 700;
        }
        
        .price-change {
            font-size: 16px;
            margin-top: 4px;
        }
        
        .header-description {
            margin-top: 12px;
            font-size: 12px;
            line-height: 1.6;
            opacity: 0.65;
            max-width: 480px;
            display: -webkit-box;
            -webkit-line-clamp: 3;
            -webkit-box-orient: vertical;
            overflow: hidden;
            transition: all 0.2s ease;
        }
        .header-description.expanded {
            display: block;
            -webkit-line-clamp: unset;
            overflow: visible;
        }
        .desc-toggle {
            margin-top: 4px;
            font-size: 11px;
            color: var(--accent);
            cursor: pointer;
            opacity: 0.85;
            user-select: none;
        }
        .desc-toggle:hover { opacity: 1; text-decoration: underline; }
        .header-pnl-row {
            display: flex;
            gap: 24px;
            margin-top: 10px;
            justify-content: flex-end;
        }
        .header-pnl-item {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
        }
        .header-pnl-label {
            font-size: 11px;
            opacity: 0.6;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .header-pnl-value {
            font-size: 15px;
            font-weight: 600;
            margin-top: 2px;
        }
        /* Option B metric band */
        .metric-band {
            display: flex;
            margin-top: 14px;
            border-radius: 10px;
            overflow: hidden;
            border: 1px solid var(--border);
        }
        .metric-panel {
            flex: 1;
            padding: 10px 14px;
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
        .metric-panel:first-child {
            border-right: 1px solid var(--border);
        }
        .metric-panel-label {
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            opacity: 0.55;
            font-weight: 600;
        }
        .metric-panel-main {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .verdict-large {
            padding: 4px 12px;
            border-radius: 12px;
            font-weight: 600;
            font-size: 13px;
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        .verdict-large.strong-buy { background: rgba(78, 204, 163, 0.2); color: var(--positive); }
        .verdict-large.buy { background: rgba(78, 204, 163, 0.15); color: #6dd5a0; }
        .verdict-large.hold { background: rgba(255, 217, 61, 0.15); color: var(--warning); }
        .verdict-large.weak-hold { background: rgba(255, 159, 67, 0.15); color: #ff9f43; }
        .verdict-large.sell { background: rgba(255, 107, 107, 0.15); color: var(--negative); }
        .score-band-bar {
            height: 4px;
            border-radius: 2px;
            background: var(--border);
            overflow: hidden;
            flex: 1;
            max-width: 80px;
        }
        .score-band-fill { height: 100%; border-radius: 2px; }
        .score-band-fill.high   { background: #4caf50; }
        .score-band-fill.medium { background: #ff9800; }
        .score-band-fill.low    { background: #f44336; }
        .score-band-num { font-size: 12px; font-weight: 700; }
        .zone-band-pill {
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }
        .zone-band-pill.zone-sb  { background: rgba(78,204,163,0.15);  color: #4ecca3; }
        .zone-band-pill.zone-b   { background: rgba(91,192,235,0.15);  color: #5bc0eb; }
        .zone-band-pill.zone-c   { background: rgba(255,217,61,0.15);  color: #ffd93d; }
        .zone-band-pill.zone-fv  { background: rgba(160,160,176,0.15); color: #a0a0b0; }
        .zone-band-pill.zone-btw { background: rgba(255,159,67,0.15);  color: #ff9f43; }
        .zone-band-pill.zone-r   { background: rgba(255,107,107,0.15); color: #ff6b6b; }
        .zone-band-sub { font-size: 10px; opacity: 0.6; margin-top: 2px; }
        
        .positive { color: var(--positive); }
        .negative { color: var(--negative); }

        /* Tooltips */
        .tooltip {
            position: relative;
            cursor: help;
        }
        
        .tooltip::after {
            content: attr(data-tip);
            position: absolute;
            bottom: 100%;
            left: 50%;
            transform: translateX(-50%);
            background: #2d3a5a;
            color: var(--text-primary);
            padding: 8px 12px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 400;
            white-space: normal;
            width: max-content;
            max-width: 280px;
            line-height: 1.4;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.2s, visibility 0.2s;
            z-index: 100;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            pointer-events: none;
            margin-bottom: 8px;
        }
        
        .tooltip:hover::after {
            opacity: 1;
            visibility: visible;
        }
        
        .tooltip-icon {
            font-size: 10px;
            color: var(--text-secondary);
            margin-left: 4px;
        }

        /* Main Content */
        .main-content {
            max-width: 1400px;
            margin: 0 auto;
            padding: 24px 32px;
        }

        /* Grid Layouts */
        .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; margin-bottom: 24px; }
        .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-bottom: 24px; }
        .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; margin-bottom: 24px; }
        /* Standalone cards (not inside a grid) need their own bottom margin */
        .main-content > .card { margin-bottom: 24px; }
        
        @media (max-width: 1000px) {
            .grid-3, .grid-4 { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 600px) {
            .grid-2, .grid-3, .grid-4 { grid-template-columns: 1fr; }
        }

        /* Cards */
        .card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 24px;
        }
        
        .card h3 {
            font-size: 14px;
            color: var(--text-secondary);
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .card.highlight {
            border-color: var(--accent);
            background: linear-gradient(135deg, rgba(78, 204, 163, 0.05) 0%, var(--bg-card) 100%);
        }

        /* Stat Rows */
        .stat-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 0;
            border-bottom: 1px solid var(--border);
        }
        
        .stat-row:last-child { border-bottom: none; }
        .stat-row .label { color: var(--text-secondary); font-size: 13px; }
        .stat-row .value { font-weight: 600; font-size: 14px; }
        .stat-row .value.large { font-size: 18px; }

        /* Chart Container */
        .chart-container {
            height: 220px;
            position: relative;
        }

        /* 52-Week Range */
        .range-52w {
            margin-top: 12px;
            padding: 12px;
            background: rgba(255, 255, 255, 0.03);
            border-radius: 8px;
        }
        
        .range-52w .range-header {
            display: flex;
            justify-content: space-between;
            font-size: 12px;
            color: var(--text-secondary);
            margin-bottom: 8px;
        }
        
        .range-52w .range-bar {
            position: relative;
            height: 8px;
            background: linear-gradient(90deg, var(--negative) 0%, var(--warning) 50%, var(--positive) 100%);
            border-radius: 4px;
            margin-bottom: 6px;
        }
        
        .range-52w .range-marker {
            position: absolute;
            top: -4px;
            width: 16px;
            height: 16px;
            background: var(--accent);
            border: 2px solid var(--bg-dark);
            border-radius: 50%;
            transform: translateX(-50%);
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        }
        
        .range-52w .range-values {
            display: flex;
            justify-content: space-between;
            font-size: 13px;
            font-weight: 600;
        }
        
        .range-52w .range-values .low { color: var(--negative); }
        .range-52w .range-values .current { color: var(--accent); }
        .range-52w .range-values .high { color: var(--positive); }

        /* Shareholding Trend */
        .holding-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 0;
            border-bottom: 1px solid var(--border);
        }
        
        .holding-row:last-child { border-bottom: none; }
        
        .holding-info {
            display: flex;
            flex-direction: column;
        }
        
        .holding-label {
            color: var(--text-secondary);
            font-size: 13px;
        }
        
        .holding-value-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .holding-value {
            font-weight: 600;
            font-size: 14px;
        }
        
        .holding-trend {
            font-size: 12px;
            padding: 2px 6px;
            border-radius: 4px;
            font-weight: 500;
        }
        
        .holding-trend.up {
            background: rgba(78, 204, 163, 0.15);
            color: var(--positive);
        }
        
        .holding-trend.down {
            background: rgba(255, 107, 107, 0.15);
            color: var(--negative);
        }
        
        .holding-trend.neutral {
            background: rgba(255, 255, 255, 0.05);
            color: var(--text-secondary);
        }

        /* Score Breakdown */
        .score-item {
            display: grid;
            grid-template-columns: 140px 1fr 60px;
            gap: 16px;
            align-items: center;
            margin-bottom: 14px;
        }
        
        .score-item .name {
            font-size: 13px;
            color: var(--text-secondary);
        }
        
        .score-bar-bg {
            background: rgba(255, 255, 255, 0.08);
            border-radius: 6px;
            height: 10px;
            overflow: hidden;
        }
        
        .score-bar-fill {
            height: 100%;
            border-radius: 6px;
            transition: width 0.6s ease;
        }
        
        .score-bar-fill.high { background: linear-gradient(90deg, var(--positive), #6dd5a0); }
        .score-bar-fill.medium { background: linear-gradient(90deg, var(--warning), #ffe066); }
        .score-bar-fill.low { background: linear-gradient(90deg, var(--negative), #ff8787); }
        
        .score-item .score {
            font-weight: 700;
            font-size: 14px;
            text-align: right;
        }
        
        .total-score {
            text-align: center;
            padding: 20px;
            margin-top: 20px;
            border-radius: 12px;
        }
        .total-score.score-high   { background: rgba(78,204,163,0.1); }
        .total-score.score-medium { background: rgba(255,217,61,0.08); }
        .total-score.score-low    { background: rgba(255,107,107,0.08); }

        .total-score .label { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
        .total-score .value { font-size: 36px; font-weight: 700; }
        .total-score .value.score-high   { color: var(--positive); }
        .total-score .value.score-medium { color: #ffd93d; }
        .total-score .value.score-low    { color: var(--negative); }

        /* Pros/Cons */
        .pros-cons-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 24px;
        }
        
        .pros h4, .cons h4 {
            font-size: 14px;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .pros h4 { color: var(--positive); }
        .cons h4 { color: var(--negative); }
        
        .pros-cons-list {
            list-style: none;
        }
        
        .pros-cons-list li {
            padding: 8px 0 8px 24px;
            position: relative;
            font-size: 13px;
            border-bottom: 1px solid var(--border);
        }
        
        .pros-cons-list li:last-child { border-bottom: none; }
        
        .pros-cons-list li::before {
            position: absolute;
            left: 0;
            font-size: 14px;
        }
        
        .pros .pros-cons-list li::before { content: "✓"; color: var(--positive); }
        .cons .pros-cons-list li::before { content: "✗"; color: var(--negative); }
        .ai-loading { display: flex; align-items: center; gap: 10px; padding: 24px 0; opacity: 0.6; font-size: 13px; }
        .ai-spinner {
            width: 16px; height: 16px; border-radius: 50%;
            border: 2px solid rgba(255,255,255,0.15);
            border-top-color: var(--accent);
            animation: spin 0.8s linear infinite;
            flex-shrink: 0;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* News */
        .news-list { list-style: none; display: flex; flex-direction: column; gap: 0; }
        .news-item { padding: 12px 0; border-bottom: 1px solid var(--border); }
        .news-item:last-child { border-bottom: none; }
        .news-title {
            display: block;
            font-size: 13px;
            font-weight: 500;
            color: var(--text-primary);
            text-decoration: none;
            line-height: 1.4;
            margin-bottom: 4px;
        }
        .news-title:hover { color: var(--accent); text-decoration: underline; }
        .news-meta { display: flex; gap: 10px; font-size: 11px; opacity: 0.55; }
        .news-links { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
        .news-ext-link {
            font-size: 12px;
            padding: 5px 12px;
            border-radius: 6px;
            background: rgba(255,255,255,0.07);
            border: 1px solid rgba(255,255,255,0.12);
            color: var(--accent);
            text-decoration: none;
            cursor: pointer;
        }
        .news-ext-link:hover { background: rgba(255,255,255,0.12); }

        /* Price History */
        .tv-range-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
        .overlay-toggle {
            padding: 3px 10px; border-radius: 12px; border: 1px solid var(--border);
            background: transparent; color: var(--text-secondary);
            cursor: pointer; font-size: 11px;
        }
        .overlay-toggle:hover { background: rgba(255,255,255,0.07); color: var(--text-primary); }
        .overlay-toggle.active { background: rgba(255,255,255,0.1); color: var(--text-primary); border-color: rgba(255,255,255,0.3); }
        .tv-tab {
            padding: 4px 12px; border-radius: 6px; border: 1px solid var(--border);
            background: transparent; color: var(--text-secondary);
            cursor: pointer; font-size: 12px;
        }
        .tv-tab:hover { background: rgba(255,255,255,0.07); color: var(--text-primary); }
        .tv-tab.active { background: var(--accent); color: #fff; border-color: var(--accent); }

        /* Price Targets */
        .pt-subtitle { font-size: 12px; opacity: 0.6; margin-bottom: 14px; }
        .pt-actions { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
        .pt-ai-btn {
            padding: 7px 18px; background: rgba(124,77,255,0.2); color: #b39dff;
            border: 1px solid rgba(124,77,255,0.4); border-radius: 6px; cursor: pointer; font-size: 12px;
        }
        .pt-ai-btn:hover { background: rgba(124,77,255,0.35); }
        .pt-ai-btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .pt-ai-loading { font-size: 12px; opacity: 0.65; }
        .pt-chart-wrap { margin-top: 4px; }
        .pt-history-title { font-size: 11px; opacity: 0.5; text-transform: uppercase; letter-spacing: 0.5px; margin: 20px 0 8px; }
        .pt-summary {
            font-size: 13px; line-height: 1.6; font-style: italic;
            padding: 10px 14px; border-radius: 8px; margin-bottom: 12px;
            background: rgba(124,77,255,0.08); border-left: 3px solid #7c4dff;
            color: var(--text-primary);
        }
        .pt-reasoning {
            display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px;
            margin: 12px 0 4px; padding: 12px; border-radius: 8px;
            background: rgba(255,255,255,0.03); border: 1px solid var(--border);
        }
        .pt-reasoning-item { font-size: 11px; line-height: 1.4; }
        .pt-reasoning-label { font-weight: 600; margin-right: 4px; }
        .pt-history-reasoning { font-size: 11px; opacity: 0.55; margin-top: 4px; font-style: italic; width: 100%; }
        .pt-show-more { background: none; border: none; cursor: pointer; font-size: 11px; color: var(--accent); opacity: 0.75; padding: 2px 0; }
        .pt-show-more:hover { opacity: 1; }
        .pt-history-row {
            display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
            padding: 8px 0; border-top: 1px solid var(--border); font-size: 11px;
        }
        .pt-history-date { opacity: 0.5; flex-shrink: 0; min-width: 90px; }
        .pt-history-price { opacity: 0.6; flex-shrink: 0; }
        .pt-history-chip {
            padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; white-space: nowrap;
        }

        /* Returns & Risk — visual */
        .rr-metric-group { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; }
        .rr-bar-row { display: flex; flex-direction: column; gap: 4px; }
        .rr-bar-label { display: flex; justify-content: space-between; align-items: center; font-size: 12px; }
        .rr-bar-value { font-weight: 700; font-size: 14px; }
        .rr-bar-track {
            height: 8px; border-radius: 4px;
            background: rgba(255,255,255,0.07); overflow: hidden;
        }
        .rr-bar-fill { height: 100%; border-radius: 4px; transition: width 0.4s ease; }
        .rr-bar-tag { font-size: 10px; opacity: 0.65; margin-top: 1px; }
        .warning-text { color: #ffd93d; }
        .status-tag { font-size: 10px; opacity: 0.7; margin-left: 4px; font-weight: 400; }
        .rr-chips { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 4px; }
        .rr-chip {
            border-radius: 8px; padding: 8px 10px; text-align: center;
            border: 1px solid transparent;
        }
        .rr-chip.chip-green  { background: rgba(78,204,163,0.1);  border-color: rgba(78,204,163,0.3); }
        .rr-chip.chip-yellow { background: rgba(255,217,61,0.1);  border-color: rgba(255,217,61,0.3); }
        .rr-chip.chip-red    { background: rgba(255,107,107,0.1); border-color: rgba(255,107,107,0.3); }
        .rr-chip.chip-neutral{ background: rgba(255,255,255,0.04);border-color: rgba(255,255,255,0.1); }
        .rr-chip-label { font-size: 9px; opacity: 0.55; text-transform: uppercase; letter-spacing: 0.4px; }
        .rr-chip-value { font-size: 16px; font-weight: 700; margin: 2px 0; }
        .rr-chip-tag   { font-size: 9px; opacity: 0.7; }

        /* Returns Prediction */
        .prediction-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 16px;
            margin-top: 16px;
        }
        
        .prediction-card {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 20px;
            text-align: center;
            transition: all 0.3s;
        }
        
        .prediction-card:hover {
            border-color: var(--accent);
            background: rgba(78, 204, 163, 0.05);
        }
        
        .prediction-card .period {
            font-size: 12px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 8px;
        }
        
        .prediction-card .projected-price {
            font-size: 24px;
            font-weight: 700;
            color: var(--accent);
            margin-bottom: 4px;
        }
        
        .prediction-card .projected-return {
            font-size: 14px;
            font-weight: 600;
        }
        
        .prediction-card .projected-return.positive { color: var(--positive); }
        .prediction-card .projected-return.negative { color: var(--negative); }
        
        .prediction-card .cagr {
            font-size: 11px;
            color: var(--text-secondary);
            margin-top: 8px;
        }
        
        .prediction-card .invested-value {
            font-size: 13px;
            color: var(--text-secondary);
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--border);
        }
        
        .prediction-card .invested-value .future {
            font-size: 16px;
            font-weight: 600;
            color: var(--positive);
            display: block;
            margin-top: 4px;
        }
        
        .prediction-disclaimer {
            font-size: 11px;
            color: var(--text-secondary);
            text-align: center;
            margin-top: 16px;
            padding: 12px;
            background: rgba(255, 217, 61, 0.1);
            border-radius: 8px;
            border-left: 3px solid var(--warning);
        }
        
        .scenario-tabs {
            display: flex;
            gap: 8px;
            margin-bottom: 16px;
        }
        
        .scenario-tab {
            flex: 1;
            padding: 8px 12px;
            border: 1px solid var(--border);
            background: transparent;
            color: var(--text-secondary);
            border-radius: 8px;
            cursor: pointer;
            font-size: 12px;
            transition: all 0.2s;
        }
        
        .scenario-tab:hover {
            border-color: var(--accent-secondary);
        }
        
        .scenario-tab.active {
            background: var(--accent-secondary);
            color: white;
            border-color: var(--accent-secondary);
        }

        /* Valuation Indicators */
        .valuation-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 0;
            border-bottom: 1px solid var(--border);
        }
        
        .valuation-row:last-child { border-bottom: none; }
        
        .valuation-left {
            display: flex;
            flex-direction: column;
        }
        
        .valuation-label {
            color: var(--text-secondary);
            font-size: 13px;
        }
        
        .valuation-comparison {
            font-size: 10px;
            color: var(--text-secondary);
            margin-top: 2px;
        }
        
        .valuation-right {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .valuation-value {
            font-weight: 600;
            font-size: 14px;
        }
        
        .valuation-indicator {
            font-size: 10px;
            padding: 3px 8px;
            border-radius: 12px;
            font-weight: 600;
            cursor: help;
        }
        
        .valuation-indicator.undervalued {
            background: rgba(78, 204, 163, 0.15);
            color: var(--positive);
        }
        
        .valuation-indicator.fair {
            background: rgba(255, 217, 61, 0.15);
            color: var(--warning);
        }
        
        .valuation-indicator.overvalued {
            background: rgba(255, 107, 107, 0.15);
            color: var(--negative);
        }
        
        .pe-bar {
            margin-top: 12px;
            padding: 12px;
            background: rgba(255, 255, 255, 0.03);
            border-radius: 8px;
        }
        
        .pe-bar-header {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            color: var(--text-secondary);
            margin-bottom: 8px;
        }
        
        .pe-bar-track {
            position: relative;
            height: 8px;
            background: linear-gradient(90deg, var(--positive) 0%, var(--warning) 50%, var(--negative) 100%);
            border-radius: 4px;
        }
        
        .pe-bar-marker {
            position: absolute;
            top: -4px;
            width: 16px;
            height: 16px;
            background: white;
            border: 2px solid var(--bg-dark);
            border-radius: 50%;
            transform: translateX(-50%);
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        }
        
        .pe-bar-labels {
            display: flex;
            justify-content: space-between;
            font-size: 10px;
            margin-top: 6px;
            color: var(--text-secondary);
        }

        /* Info Button */
        .info-btn {
            background: rgba(124, 77, 255, 0.15);
            border: 1px solid var(--accent-secondary);
            color: var(--accent-secondary);
            width: 22px;
            height: 22px;
            border-radius: 50%;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-left: 8px;
            transition: all 0.2s;
        }
        
        .info-btn:hover {
            background: var(--accent-secondary);
            color: var(--bg-dark);
        }
        
        .header-with-info {
            display: flex;
            align-items: center;
        }

        /* Footer */
        .footer {
            text-align: center;
            padding: 20px;
            color: var(--text-secondary);
            font-size: 12px;
            border-top: 1px solid var(--border);
            margin-top: 32px;
        }
    </style>
</head>
<body>
    <header class="header">
        <div class="stock-info">
            <h1>📈 ${stock.symbol}</h1>
            <div class="name">${stock.name}</div>
            <span class="sector">${f.sector || stock.sector || "Equity"}</span>
            ${
              f.description
                ? `
            <p class="header-description" id="headerDesc">${f.description}</p>
            <span class="desc-toggle" id="descToggle" onclick="toggleDesc()">more ▾</span>
            `
                : ""
            }
        </div>
        <div class="header-right">
            <div class="price-display">₹${stock.currentPrice.toFixed(2)}</div>
            <div class="price-change ${stock.dayChangePct >= 0 ? "positive" : "negative"}">
                ${stock.dayChangePct >= 0 ? "▲" : "▼"} ₹${Math.abs(stock.dayChange).toFixed(2)} (${stock.dayChangePct >= 0 ? "+" : ""}${stock.dayChangePct.toFixed(2)}%)
            </div>
            ${
              stock.quantity > 0
                ? `
            <div class="header-pnl-row">
                <div class="header-pnl-item">
                    <span class="header-pnl-label">Today's P&L <span class="tooltip-icon">ⓘ</span></span>
                    <span class="header-pnl-value ${stock.dayChange * stock.quantity >= 0 ? "positive" : "negative"}">
                        ${stock.dayChange * stock.quantity >= 0 ? "+" : ""}${formatCurrency(stock.dayChange * stock.quantity)} (${stock.dayChangePct >= 0 ? "+" : ""}${stock.dayChangePct.toFixed(2)}%)
                    </span>
                </div>
                <div class="header-pnl-item">
                    <span class="header-pnl-label">Total P&L <span class="tooltip-icon">ⓘ</span></span>
                    <span class="header-pnl-value ${stock.profitLoss >= 0 ? "positive" : "negative"}">
                        ${stock.profitLoss >= 0 ? "+" : ""}${formatCurrency(stock.profitLoss)} (${stock.profitLossPct >= 0 ? "+" : ""}${stock.profitLossPct.toFixed(1)}%)
                    </span>
                </div>
            </div>
            `
                : ""
            }
            <div class="metric-band">
                <div class="metric-panel">
                    <span class="metric-panel-label">⚙ Fundamentals Score</span>
                    <div class="metric-panel-main">
                        <span class="verdict-large ${getVerdictClass(stock.verdict)}">${stock.verdictEmoji} ${stock.verdict}</span>
                        <div class="score-band-bar">
                            <div class="score-band-fill ${stock.totalScore >= 7 ? 'high' : stock.totalScore >= 5 ? 'medium' : 'low'}"
                                 style="width:${(stock.totalScore / 10 * 100).toFixed(0)}%"></div>
                        </div>
                        <span class="score-band-num ${stock.totalScore >= 7 ? 'positive' : stock.totalScore >= 5 ? '' : 'negative'}">${stock.totalScore}/10</span>
                    </div>
                </div>
                <div class="metric-panel">
                    <span class="metric-panel-label">📈 AI Market Zone</span>
                    <div class="metric-panel-main">
                        <span id="headerZone" class="zone-band-pill" style="display:none">—</span>
                        <span id="headerZoneEmpty" style="font-size:11px;opacity:0.4">Generating…</span>
                    </div>
                    <span class="zone-band-sub">Based on AI price targets</span>
                </div>
            </div>
        </div>
    </header>
    
    <main class="main-content">
        <!-- Position Summary -->
        <div class="grid-4">
            ${
              stock.quantity > 0
                ? `
            <div class="card highlight">
                <h3>💰 Your Position</h3>
                <div class="stat-row">
                    <span class="label">Quantity</span>
                    <span class="value large">${stock.quantity}</span>
                </div>
                <div class="stat-row">
                    <span class="label tooltip" data-tip="Average Buy Price — weighted average price at which you purchased these shares. Used to calculate your profit/loss.">Avg Buy Price <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value">₹${stock.avgPrice.toFixed(2)}</span>
                </div>
                <div class="stat-row">
                    <span class="label tooltip" data-tip="Total Invested Amount — Quantity × Average Buy Price. This is your total capital deployed in this stock.">Invested <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value">${formatCurrency(stock.investedValue)}</span>
                </div>
                <div class="stat-row">
                    <span class="label tooltip" data-tip="Current Market Value — Quantity × Current Price. This is what your holding is worth today.">Current Value <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value">${formatCurrency(stock.currentValue)}</span>
                </div>
                <div class="stat-row" style="border-top: 1px solid var(--border); padding-top: 8px; margin-top: 8px;">
                    <span class="label tooltip" data-tip="Today's Profit/Loss — change in your holding value since yesterday's close. Calculated as: (Today's price change × Quantity).">Today's P&L <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value ${stock.dayChange * stock.quantity >= 0 ? "positive" : "negative"}">
                        ${stock.dayChange * stock.quantity >= 0 ? "+" : ""}${formatCurrency(stock.dayChange * stock.quantity)} (${stock.dayChangePct >= 0 ? "+" : ""}${stock.dayChangePct.toFixed(2)}%)
                    </span>
                </div>
                <div class="stat-row">
                    <span class="label tooltip" data-tip="Total Profit/Loss — overall gain or loss since you bought. Calculated as: Current Value - Invested Amount. Green = profit, Red = loss.">Total P&L <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value ${stock.profitLoss >= 0 ? "positive" : "negative"}">${stock.profitLoss >= 0 ? "+" : ""}${formatCurrency(stock.profitLoss)} (${stock.profitLossPct >= 0 ? "+" : ""}${stock.profitLossPct.toFixed(1)}%)</span>
                </div>
            </div>
            `
                : ""
            }
            
            <div class="card">
                <h3>📊 Valuation</h3>
                <div class="valuation-row">
                    <div class="valuation-left">
                        <span class="valuation-label tooltip" data-tip="Price-to-Earnings Ratio — how much investors pay for each rupee of earnings. Lower P/E may indicate undervaluation, higher P/E may indicate growth expectations.">P/E Ratio <span class="tooltip-icon">ⓘ</span></span>
                        <span class="valuation-comparison">vs Industry: ${f.indPE?.toFixed(1) || "N/A"}</span>
                    </div>
                    <div class="valuation-right">
                        <span class="valuation-value">${f.pe?.toFixed(1) || "N/A"}</span>
                        ${getPEIndicator(f.pe, f.indPE)}
                    </div>
                </div>
                ${
                  f.medianPE
                    ? `
                <div class="valuation-row">
                    <div class="valuation-left">
                        <span class="valuation-label tooltip" data-tip="5-Year Median P/E — the middle P/E value over 5 years. Helps assess if current valuation is cheap or expensive vs historical norm.">5Y Median P/E <span class="tooltip-icon">ⓘ</span></span>
                        <span class="valuation-comparison">Historical average</span>
                    </div>
                    <div class="valuation-right">
                        <span class="valuation-value">${f.medianPE.toFixed(1)}</span>
                        ${getPETrendIndicator(f.peChange)}
                    </div>
                </div>
                `
                    : ""
                }
                <div class="valuation-row">
                    <div class="valuation-left">
                        <span class="valuation-label tooltip" data-tip="Price-to-Book Ratio — compares stock price to book value (assets minus liabilities). P/B < 1 may indicate undervaluation, P/B > 3 may suggest overvaluation.">P/B Ratio <span class="tooltip-icon">ⓘ</span></span>
                        <span class="valuation-comparison">Book value based</span>
                    </div>
                    <div class="valuation-right">
                        <span class="valuation-value">${f.pb?.toFixed(2) || "N/A"}</span>
                        ${getPBIndicator(f.pb)}
                    </div>
                </div>
                <div class="valuation-row">
                    <div class="valuation-left">
                        <span class="valuation-label tooltip" data-tip="Earnings Per Share — net profit divided by total shares. Higher EPS indicates more profit generated per share. Growing EPS is a positive sign.">EPS <span class="tooltip-icon">ⓘ</span></span>
                        <span class="valuation-comparison">Earnings per share</span>
                    </div>
                    <div class="valuation-right">
                        <span class="valuation-value">₹${f.eps?.toFixed(2) || "N/A"}</span>
                    </div>
                </div>
                <div class="valuation-row">
                    <div class="valuation-left">
                        <span class="valuation-label tooltip" data-tip="Market Capitalization — total market value of all shares. Large Cap > ₹20,000 Cr (stable), Mid Cap ₹5,000-20,000 Cr, Small Cap < ₹5,000 Cr (higher risk/reward).">Market Cap <span class="tooltip-icon">ⓘ</span></span>
                    </div>
                    <div class="valuation-right">
                        <span class="valuation-value">${f.marketCap ? formatCurrency(f.marketCap * 10000000) : "N/A"}</span>
                    </div>
                </div>
                ${
                  f.pe && f.indPE
                    ? `
                <div class="pe-bar">
                    <div class="pe-bar-header">
                        <span>P/E vs Industry</span>
                        <span>${((f.pe / f.indPE - 1) * 100).toFixed(0)}% ${f.pe < f.indPE ? "below" : "above"}</span>
                    </div>
                    <div class="pe-bar-track">
                        <div class="pe-bar-marker" style="left: ${Math.min(100, Math.max(0, (f.pe / (f.indPE * 2)) * 100))}%"></div>
                    </div>
                    <div class="pe-bar-labels">
                        <span>🟢 Cheap</span>
                        <span>🟡 Fair (${f.indPE.toFixed(0)})</span>
                        <span>🔴 Expensive</span>
                    </div>
                </div>
                `
                    : ""
                }
            </div>
            
            <div class="card">
                <h3>📈 Growth</h3>
                <div class="stat-row">
                    <span class="label tooltip" data-tip="3-Year Revenue CAGR (Compound Annual Growth Rate) — average yearly revenue growth over 3 years. Higher is better; >15% is excellent, 10-15% good, <5% weak.">Revenue (3Y CAGR) <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value ${f.salesGrowth3Y != null ? (f.salesGrowth3Y >= 0 ? "positive" : "negative") : ""}">${f.salesGrowth3Y?.toFixed(1) || "N/A"}%</span>
                </div>
                <div class="stat-row">
                    <span class="label tooltip" data-tip="5-Year Revenue CAGR — average yearly revenue growth over 5 years. Longer period shows consistency. >12% is excellent, 8-12% good.">Revenue (5Y CAGR) <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value ${f.salesGrowth5Y != null ? (f.salesGrowth5Y >= 0 ? "positive" : "negative") : ""}">${f.salesGrowth5Y?.toFixed(1) || "N/A"}%</span>
                </div>
                <div class="stat-row">
                    <span class="label tooltip" data-tip="TTM (Trailing Twelve Months) Revenue Growth — year-over-year revenue growth for the last 12 months. Shows current momentum.">TTM Revenue <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value ${f.salesGrowthTTM != null ? (f.salesGrowthTTM >= 0 ? "positive" : "negative") : ""}">${f.salesGrowthTTM?.toFixed(1) || "N/A"}%</span>
                </div>
                <div class="stat-row">
                    <span class="label tooltip" data-tip="3-Year Profit CAGR — average yearly net profit growth over 3 years. Profit growth > revenue growth indicates improving margins.">Profit (3Y CAGR) <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value ${f.profitGrowth3Y != null ? (f.profitGrowth3Y >= 0 ? "positive" : "negative") : ""}">${f.profitGrowth3Y?.toFixed(1) || "N/A"}%</span>
                </div>
                <div class="stat-row">
                    <span class="label tooltip" data-tip="5-Year Profit CAGR — average yearly net profit growth over 5 years. Consistent profit growth is a hallmark of quality companies.">Profit (5Y CAGR) <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value ${f.profitGrowth5Y != null ? (f.profitGrowth5Y >= 0 ? "positive" : "negative") : ""}">${f.profitGrowth5Y?.toFixed(1) || "N/A"}%</span>
                </div>
                <div class="stat-row">
                    <span class="label tooltip" data-tip="TTM (Trailing Twelve Months) Profit Growth — year-over-year profit growth for the last 12 months. Shows recent profitability trend.">TTM Profit <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value ${f.profitGrowthTTM != null ? (f.profitGrowthTTM >= 0 ? "positive" : "negative") : ""}">${f.profitGrowthTTM?.toFixed(1) || "N/A"}%</span>
                </div>
            </div>
            
            <div class="card">
                <h3>📉 Returns & Risk</h3>

                ${
                  f.roe != null
                    ? `<div class="stat-row">
                    <span class="label tooltip" data-tip="Return on Equity — profit per ₹100 of shareholders' money. >15% good, >20% excellent.">ROE <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value ${f.roe >= 15 ? "positive" : f.roe >= 10 ? "warning-text" : "negative"}">${f.roe.toFixed(1)}% <span class="status-tag">${f.roe >= 20 ? "● Excellent" : f.roe >= 15 ? "● Good" : f.roe >= 10 ? "● Average" : "● Weak"}</span></span>
                </div>`
                    : ""
                }
                ${
                  f.roce != null
                    ? `<div class="stat-row">
                    <span class="label tooltip" data-tip="Return on Capital Employed — profit per ₹100 of total capital. >15% good.">ROCE <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value ${f.roce >= 15 ? "positive" : f.roce >= 10 ? "warning-text" : "negative"}">${f.roce.toFixed(1)}% <span class="status-tag">${f.roce >= 20 ? "● Excellent" : f.roce >= 15 ? "● Good" : f.roce >= 10 ? "● Average" : "● Weak"}</span></span>
                </div>`
                    : ""
                }
                ${
                  f.debtToEquity != null
                    ? `<div class="stat-row">
                    <span class="label tooltip" data-tip="Debt-to-Equity — total debt vs shareholders' equity. <0.5 low risk, >1 high risk.">Debt/Equity <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value ${f.debtToEquity < 0.5 ? "positive" : f.debtToEquity < 1 ? "warning-text" : "negative"}">${f.debtToEquity.toFixed(2)} <span class="status-tag">${f.debtToEquity < 0.5 ? "● Low debt" : f.debtToEquity < 1 ? "● Moderate" : "● High debt"}</span></span>
                </div>`
                    : ""
                }
                ${
                  f.divYield != null
                    ? `<div class="stat-row">
                    <span class="label tooltip" data-tip="Dividend Yield — annual dividend as % of stock price. >2% decent for Indian stocks.">Dividend Yield <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value ${f.divYield >= 2 ? "positive" : f.divYield > 0 ? "warning-text" : ""}">${f.divYield.toFixed(2)}% <span class="status-tag">${f.divYield >= 3 ? "● High income" : f.divYield >= 1 ? "● Moderate" : "● Low"}</span></span>
                </div>`
                    : ""
                }
                ${
                  f.beta != null
                    ? `<div class="stat-row">
                    <span class="label tooltip" data-tip="Beta — volatility vs market. <1 defensive, ~1 market-like, >1 aggressive.">Beta <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value ${f.beta <= 0.8 ? "positive" : f.beta <= 1.2 ? "warning-text" : "negative"}">${f.beta.toFixed(2)} <span class="status-tag">${f.beta <= 0.8 ? "● Defensive" : f.beta <= 1.2 ? "● Market-like" : "● High risk"}</span></span>
                </div>`
                    : ""
                }

                <!-- 52W Range bar -->
                ${
                  stock.low52w && stock.high52w
                    ? `
                <div class="range-52w" style="margin-top:16px">
                    <div class="range-header">
                        <span class="tooltip" data-tip="52-Week Range — lowest and highest price over the last year. Near 52W low = possible value, near 52W high = momentum or expensive.">52-Week Range <span class="tooltip-icon">ⓘ</span></span>
                        <span style="font-size:11px;opacity:0.6">Current ₹${stock.currentPrice.toFixed(0)} — ${(((stock.currentPrice - stock.low52w) / (stock.high52w - stock.low52w)) * 100).toFixed(0)}% of range</span>
                    </div>
                    <div class="range-bar">
                        <div class="range-marker" style="left:${stock.high52w === stock.low52w ? 50 : Math.min(100, Math.max(0, ((stock.currentPrice - stock.low52w) / (stock.high52w - stock.low52w)) * 100))}%"></div>
                    </div>
                    <div class="range-values">
                        <span class="low">₹${stock.low52w.toFixed(0)}<br><span style="font-size:9px;opacity:0.5">52W Low</span></span>
                        <span class="high">₹${stock.high52w.toFixed(0)}<br><span style="font-size:9px;opacity:0.5">52W High</span></span>
                    </div>
                </div>`
                    : ""
                }
            </div>
        </div>
        
        <!-- Charts Row -->
        <div class="grid-2">
            <div class="card">
                <h3>🎯 Score Breakdown</h3>
                <div class="chart-container">
                    <canvas id="scoreRadar"></canvas>
                </div>
            </div>
            <div class="card">
                <h3>👥 Shareholding Pattern</h3>
                <div class="chart-container">
                    <canvas id="shareholdingChart"></canvas>
                </div>
            </div>
        </div>
        
        <!-- Detailed Score Breakdown -->
        <div class="grid-2">
            <div class="card">
                <h3 class="header-with-info">📋 Category Scores <button class="info-btn" onclick="showScoringInfo()" title="How scores are calculated">ℹ</button></h3>
                ${renderScoreItems(stock)}
                <div class="total-score score-${stock.totalScore >= 7 ? "high" : stock.totalScore >= 5 ? "medium" : "low"}">
                    <div class="label">OVERALL SCORE</div>
                    <div class="value score-${stock.totalScore >= 7 ? "high" : stock.totalScore >= 5 ? "medium" : "low"}">${stock.totalScore}/10</div>
                </div>
            </div>
            
            <div class="card">
                <h3>👥 Shareholding Details</h3>
                <p style="font-size: 11px; color: var(--text-secondary); margin-bottom: 12px;">QoQ change shown →</p>
                
                <div class="holding-row">
                    <div class="holding-info">
                        <span class="holding-label tooltip" data-tip="Promoter Holding — % of shares owned by company founders/management. High promoter stake (>50%) shows confidence. Increasing trend is positive, decreasing may signal concerns.">Promoters <span class="tooltip-icon">ⓘ</span></span>
                        <div class="holding-value-row">
                            <span class="holding-value">${f.promoterHolding?.toFixed(1) || "N/A"}%</span>
                            ${renderTrendBadge(f.promoterHoldingChange)}
                        </div>
                    </div>
                </div>
                <div class="holding-row">
                    <div class="holding-info">
                        <span class="holding-label tooltip" data-tip="FII (Foreign Institutional Investors) — % held by foreign funds like BlackRock, Vanguard. High FII = global confidence. Increasing FII is bullish, sharp decrease may cause selling pressure.">FII (Foreign) <span class="tooltip-icon">ⓘ</span></span>
                        <div class="holding-value-row">
                            <span class="holding-value">${f.fiiHolding?.toFixed(1) || "N/A"}%</span>
                            ${renderTrendBadge(f.fiiHoldingChange)}
                        </div>
                    </div>
                </div>
                <div class="holding-row">
                    <div class="holding-info">
                        <span class="holding-label tooltip" data-tip="DII (Domestic Institutional Investors) — % held by Indian mutual funds, insurance companies, banks. Stable DIIs provide price support. Increasing DII shows domestic confidence.">DII (Domestic) <span class="tooltip-icon">ⓘ</span></span>
                        <div class="holding-value-row">
                            <span class="holding-value">${f.diiHolding?.toFixed(1) || "N/A"}%</span>
                            ${renderTrendBadge(f.diiHoldingChange)}
                        </div>
                    </div>
                </div>
                <div class="holding-row">
                    <div class="holding-info">
                        <span class="holding-label tooltip" data-tip="Public/Retail Holding — % owned by individual investors. Very high retail % with low institutions may indicate less analyst coverage and higher volatility.">Public <span class="tooltip-icon">ⓘ</span></span>
                        <div class="holding-value-row">
                            <span class="holding-value">${f.publicHolding?.toFixed(1) || "N/A"}%</span>
                            ${renderTrendBadge(f.publicHoldingChange)}
                        </div>
                    </div>
                </div>
                
                <div class="stat-row" style="margin-top: 16px; padding-top: 16px; border-top: 2px solid var(--border);">
                    <span class="label tooltip" data-tip="Book Value Per Share — total assets minus liabilities, divided by shares. Represents liquidation value. Stock price near book value may indicate undervaluation.">Book Value <span class="tooltip-icon">ⓘ</span></span>
                    <span class="value">₹${f.bookValue?.toFixed(2) || "N/A"}</span>
                </div>
            </div>
        </div>
        
        <!-- Price History -->
        <div class="card">
            <h3>📈 Price History</h3>
            <div class="tv-range-tabs">
                <button class="tv-tab" onclick="loadPriceHistory('1d','1d',this)">1D</button>
                <button class="tv-tab" onclick="loadPriceHistory('5d','1d',this)">1W</button>
                <button class="tv-tab active" onclick="loadPriceHistory('3mo','1d',this)">3M</button>
                <button class="tv-tab" onclick="loadPriceHistory('6mo','1d',this)">6M</button>
                <button class="tv-tab" onclick="loadPriceHistory('1y','1d',this)">1Y</button>
                <button class="tv-tab" onclick="loadPriceHistory('2y','1wk',this)">2Y</button>
                <button class="tv-tab" onclick="loadPriceHistory('5y','1wk',this)">5Y</button>
            </div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap">
                <span style="font-size:11px;opacity:0.45;text-transform:uppercase;letter-spacing:0.4px">Overlays:</span>
                <button class="overlay-toggle active" id="toggleAiTargets" onclick="toggleOverlay('aiTargets')" data-active="true">🎯 AI Targets</button>
                <button class="overlay-toggle" id="toggle52w" onclick="toggleOverlay('52w')" data-active="false">📊 52W Range</button>
            </div>
            <div id="phLoading" style="display:none;padding:20px 0;opacity:0.5;font-size:12px">⏳ Loading chart…</div>
            <div id="phError" style="display:none;padding:20px 0;opacity:0.5;font-size:12px"></div>
            <div style="height:320px;margin-top:10px;position:relative">
                <canvas id="priceHistoryChart"></canvas>
            </div>
            <!-- AI Price Targets inline -->
            <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                    <span style="font-size:13px;font-weight:600">🎯 AI Price Targets</span>
                    <div style="display:flex;align-items:center;gap:10px">
                        <button class="pt-ai-btn" id="ptRefreshBtn" onclick="forceRefreshPriceTargets()" title="Re-generate targets">↻ Refresh</button>
                        <span class="pt-ai-loading" id="ptAiLoading" style="display:none">⏳ Generating…</span>
                        <span id="ptLastUpdated" class="pt-subtitle" style="margin:0;opacity:0.5"></span>
                    </div>
                </div>
                <div id="ptZone" style="margin-bottom:10px;display:none"></div>
                <div id="ptTargetsTable" style="display:none;margin-bottom:12px"></div>
                <div id="ptReasoningWrap" style="display:none"></div>
                <div id="ptHistory" style="display:none">
                    <div class="pt-history-title">Suggestion History</div>
                    <div id="ptHistoryRows"></div>
                </div>
            </div>
        </div>

        <!-- Pros & Cons -->
        <div class="card">
            <h3>⚖️ Strengths & Concerns</h3>
            <div id="prosConsContent">
                ${
                  f.pros?.length || f.cons?.length
                    ? `
                <div class="pros-cons-grid">
                    <div class="pros">
                        <h4>✅ Strengths</h4>
                        <ul class="pros-cons-list">
                            ${(f.pros || []).map((p) => `<li>${p}</li>`).join("")}
                        </ul>
                    </div>
                    <div class="cons">
                        <h4>❌ Concerns</h4>
                        <ul class="pros-cons-list">
                            ${(f.cons || []).map((c) => `<li>${c}</li>`).join("")}
                        </ul>
                    </div>
                </div>
                `
                    : `<div class="ai-loading" id="aiLoading">
                    <span class="ai-spinner"></span> Generating AI analysis…
                </div>
                <div id="aiProsConsResult" style="display:none"></div>`
                }
            </div>
        </div>

        <!-- Returns Prediction — only show if CAGR data exists -->
        ${
          (f.salesGrowth5Y ??
            f.salesGrowth3Y ??
            f.profitGrowth5Y ??
            f.profitGrowth3Y) !== null &&
          (f.salesGrowth5Y ??
            f.salesGrowth3Y ??
            f.profitGrowth5Y ??
            f.profitGrowth3Y) !== undefined
            ? `
        <div class="card">
            <h3>🔮 Projected Returns (Based on Historical Growth)</h3>

            <div class="scenario-tabs">
                <button class="scenario-tab active" onclick="setScenario('moderate')">Moderate</button>
                <button class="scenario-tab" onclick="setScenario('conservative')">Conservative</button>
                <button class="scenario-tab" onclick="setScenario('optimistic')">Optimistic</button>
            </div>

            <div class="prediction-grid" id="predictionGrid">
                ${renderPredictions(stock, f)}
            </div>

            <div class="prediction-disclaimer">
                ⚠️ <strong>Disclaimer:</strong> Moderate scenario uses avg of Revenue 5Y CAGR (${f.salesGrowth5Y?.toFixed(1) ?? f.salesGrowth3Y?.toFixed(1) ?? "N/A"}%) and Profit 5Y CAGR (${f.profitGrowth5Y?.toFixed(1) ?? f.profitGrowth3Y?.toFixed(1) ?? "N/A"}%) — same figures shown in Growth Metrics. Actual returns may vary significantly. Not financial advice.
            </div>
        </div>
        `
            : ""
        }
    </main>
    
    <footer class="footer">
        Analysis generated on ${new Date().toLocaleString()} | Data sources: IndMoney, Tickertape, Screener.in
    </footer>

    <script>
        const vscode = acquireVsCodeApi();
        const stock = ${stockJson};
        const f = stock.fundamentals || {};
        
        function showScoringInfo() {
            vscode.postMessage({ type: 'showScoringInfo' });
        }

        // Price Targets
        function requestAIPriceSuggestions() {
            document.getElementById('ptAiLoading').style.display = 'inline';
            document.getElementById('ptRefreshBtn').disabled = true;
            vscode.postMessage({ type: 'suggestPricesAI', symbol: stock.symbol, stock: stock, fundamentals: f });
        }

        function forceRefreshPriceTargets() {
            requestAIPriceSuggestions();
        }

        function setLastUpdated(history) {
            const el = document.getElementById('ptLastUpdated');
            if (!el) return;
            if (!history || history.length === 0) { el.textContent = ''; return; }
            const last = history[history.length - 1];
            const lastDate = new Date(last.date);
            const today = new Date().toDateString();
            const isToday = lastDate.toDateString() === today;
            el.textContent = isToday
                ? '✓ Updated today'
                : 'Last: ' + lastDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
            el.style.color = isToday ? 'var(--positive)' : '';
        }

        function loadPriceTargets() {
            vscode.postMessage({ type: 'loadPriceTargets', symbol: stock.symbol });
        }

        function deleteTargetEntry(index) {
            vscode.postMessage({ type: 'deleteTargetEntry', symbol: stock.symbol, index });
        }

        function renderReasoning(reasoning, containerId, summary) {
            const container = document.getElementById(containerId);
            if (!container) { return; }
            const levels = [
                { key: 'strongBuy', label: '🟢 Strong Buy', color: '#4ecca3' },
                { key: 'buy',       label: '🔵 Buy',        color: '#5bc0eb' },
                { key: 'consider',  label: '🟡 Consider',   color: '#ffd93d' },
                { key: 'fair',      label: '⚪ Fair Value',  color: '#a0a0b0' },
                { key: 'reduce',    label: '🔴 Reduce',     color: '#ff6b6b' },
            ].filter(l => reasoning?.[l.key]);
            const summaryHtml = summary ? \`<div class="pt-summary">💬 \${summary}</div>\` : '';
            const detailHtml = levels.length > 0 ? \`<div class="pt-reasoning">\${
                levels.map(l => \`<div class="pt-reasoning-item">
                    <span class="pt-reasoning-label" style="color:\${l.color}">\${l.label}:</span>
                    \${reasoning[l.key]}
                </div>\`).join('')
            }</div>\` : '';
            if (!summaryHtml && !detailHtml) { return; }
            container.innerHTML = summaryHtml + detailHtml;
            container.style.display = 'block';
        }

        function updateZoneLabel(targets) {
            const el = document.getElementById('ptZone');
            if (!el) { return; }
            const price = stock.currentPrice;
            if (!targets || !price) { el.style.display = 'none'; return; }

            const { strongBuy, buy, consider, fair, reduce } = targets;
            let label, emoji, bg, color;

            const near = (v) => v && Math.abs(price - v) / v <= 0.005;
            const ZONES = [
                { value: strongBuy, exact: ['At Strong Buy',            '🟢', 'rgba(78,204,163,0.15)',  '#4ecca3'],
                                    below: ['Below Strong Buy',          '🟢', 'rgba(78,204,163,0.15)',  '#4ecca3'] },
                { value: buy,       exact: ['At Buy',                   '🔵', 'rgba(91,192,235,0.15)',  '#5bc0eb'],
                                    below: ['Between Strong Buy & Buy',  '🔵', 'rgba(91,192,235,0.15)',  '#5bc0eb'] },
                { value: consider,  exact: ['At Consider',              '🟡', 'rgba(255,217,61,0.15)',  '#ffd93d'],
                                    below: ['Between Buy & Consider',    '🟡', 'rgba(255,217,61,0.15)',  '#ffd93d'] },
                { value: fair,      exact: ['At Fair Value',            '⚪', 'rgba(160,160,176,0.15)', '#a0a0b0'],
                                    below: ['Between Consider & Fair Value', '⚪', 'rgba(160,160,176,0.15)', '#a0a0b0'] },
                { value: reduce,    exact: ['At Reduce',                '🔴', 'rgba(255,107,107,0.15)', '#ff6b6b'],
                                    below: ['Between Fair Value & Reduce', '🟠', 'rgba(255,159,67,0.15)', '#ff9f43'] },
            ];
            let resolved = ['Above Reduce', '🔴', 'rgba(255,107,107,0.15)', '#ff6b6b'];
            for (const z of ZONES) {
                if (!z.value) { continue; }
                if (near(z.value))    { resolved = z.exact; break; }
                if (price < z.value) { resolved = z.below; break; }
            }
            [label, emoji, bg, color] = resolved;

            el.innerHTML = \`<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:600;background:\${bg};color:\${color}">
                \${emoji} Current Price Zone: \${label}
            </span>\`;
            el.style.display = 'block';

            // Update header band zone pill
            const headerEl = document.getElementById('headerZone');
            const headerEmpty = document.getElementById('headerZoneEmpty');
            if (headerEl) {
                headerEl.textContent = \`\${emoji} \${label}\`;
                headerEl.className = 'zone-band-pill ' + getZoneBandClass(label);
                headerEl.style.display = 'inline-flex';
            }
            if (headerEmpty) { headerEmpty.style.display = 'none'; }
        }

        function renderTargetsTable(targets) {
            const el = document.getElementById('ptTargetsTable');
            if (!el || !targets) { if (el) el.style.display = 'none'; return; }
            const price = stock.currentPrice;
            const levels = [
                { key: 'strongBuy', label: 'Strong Buy', color: '#4ecca3', bg: 'rgba(78,204,163,0.08)' },
                { key: 'buy',       label: 'Buy',         color: '#5bc0eb', bg: 'rgba(91,192,235,0.08)' },
                { key: 'consider',  label: 'Consider',    color: '#ffd93d', bg: 'rgba(255,217,61,0.08)'  },
                { key: 'fair',      label: 'Fair Value',  color: '#a0a0b0', bg: 'rgba(160,160,176,0.08)' },
                { key: 'reduce',    label: 'Reduce',      color: '#ff6b6b', bg: 'rgba(255,107,107,0.08)' },
            ].filter(r => targets[r.key]);

            // Build items list: target levels sorted descending by price, with current price injected in position
            const items = levels.map(r => ({ type: 'target', ...r, val: targets[r.key] }));
            items.sort((a, b) => b.val - a.val);

            // Determine zone color for current price row
            const zoneMap = {
                strongBuy: { color: '#4ecca3', bg: 'rgba(78,204,163,0.18)'  },
                buy:       { color: '#5bc0eb', bg: 'rgba(91,192,235,0.18)'  },
                consider:  { color: '#ffd93d', bg: 'rgba(255,217,61,0.18)'  },
                fair:      { color: '#a0a0b0', bg: 'rgba(160,160,176,0.18)' },
                reduce:    { color: '#ff9f43', bg: 'rgba(255,159,67,0.18)'  },
                aboveReduce:{ color: '#ff6b6b', bg: 'rgba(255,107,107,0.18)' },
            };
            let zoneColor = '#ffffff', zoneBg = 'rgba(255,255,255,0.06)';
            if (price) {
                const { strongBuy, buy, consider, fair, reduce } = targets;
                if      (strongBuy && price <= strongBuy) { zoneColor = zoneMap.strongBuy.color; zoneBg = zoneMap.strongBuy.bg; }
                else if (buy       && price <= buy)       { zoneColor = zoneMap.buy.color;       zoneBg = zoneMap.buy.bg; }
                else if (consider  && price <= consider)  { zoneColor = zoneMap.consider.color;  zoneBg = zoneMap.consider.bg; }
                else if (fair      && price <= fair)      { zoneColor = zoneMap.fair.color;       zoneBg = zoneMap.fair.bg; }
                else if (reduce    && price <= reduce)    { zoneColor = zoneMap.reduce.color;     zoneBg = zoneMap.reduce.bg; }
                else                                      { zoneColor = zoneMap.aboveReduce.color; zoneBg = zoneMap.aboveReduce.bg; }
            }
            const currentRow = \`<tr style="background:\${zoneBg};border-bottom:1px solid rgba(255,255,255,0.1);border-top:1px solid rgba(255,255,255,0.1)">
                <td style="padding:6px 10px;color:\${zoneColor};font-weight:700;font-size:12px;white-space:nowrap">▶ Current Price</td>
                <td style="padding:6px 10px;font-size:12px;text-align:right;font-weight:700;color:\${zoneColor}">₹\${price ? price.toLocaleString('en-IN', {minimumFractionDigits:0, maximumFractionDigits:0}) : '—'}</td>
                <td style="padding:6px 10px;font-size:12px;text-align:right;opacity:0.4">—</td>
            </tr>\`;

            let inserted = false;
            const tableRows = [];
            for (const r of items) {
                const diff = price ? ((r.val - price) / price * 100) : null;
                const diffStr = diff !== null
                    ? \`<span style="color:\${diff >= 0 ? '#4ecca3' : '#ff6b6b'};font-weight:600">\${diff >= 0 ? '+' : ''}\${diff.toFixed(1)}%</span>\`
                    : '—';
                // Inject current price row just before the first level that is below current price
                if (!inserted && price && r.val < price) {
                    tableRows.push(currentRow);
                    inserted = true;
                }
                tableRows.push(\`<tr style="background:transparent;border-bottom:1px solid rgba(255,255,255,0.05)">
                    <td style="padding:6px 10px;color:\${r.color};font-weight:600;font-size:12px;white-space:nowrap">\${r.label}</td>
                    <td style="padding:6px 10px;font-size:12px;text-align:right;font-weight:500">₹\${r.val.toLocaleString('en-IN', {minimumFractionDigits:0, maximumFractionDigits:0})}</td>
                    <td style="padding:6px 10px;font-size:12px;text-align:right">\${diffStr}</td>
                </tr>\`);
            }
            // If current price is below all levels, append at bottom
            if (!inserted) { tableRows.push(currentRow); }

            el.innerHTML = \`<table style="width:100%;border-collapse:collapse;border:1px solid rgba(255,255,255,0.08);border-radius:8px;overflow:hidden">
                <thead>
                    <tr style="background:rgba(255,255,255,0.04);border-bottom:1px solid rgba(255,255,255,0.1)">
                        <th style="padding:6px 10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.5;font-weight:600">Level</th>
                        <th style="padding:6px 10px;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.5;font-weight:600">Price</th>
                        <th style="padding:6px 10px;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.5;font-weight:600">vs Current</th>
                    </tr>
                </thead>
                <tbody>\${tableRows.join('')}</tbody>
            </table>\`;
            el.style.display = 'block';
        }

        function buildHistoryRow(h, origIdx) {
            const d = new Date(h.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
            const t = h.targets;
            const chips = [
                t.strongBuy ? \`<span class="pt-history-chip" style="background:rgba(78,204,163,0.15);color:#4ecca3">🟢 ₹\${t.strongBuy.toLocaleString('en-IN')}</span>\` : '',
                t.buy       ? \`<span class="pt-history-chip" style="background:rgba(91,192,235,0.15);color:#5bc0eb">🔵 ₹\${t.buy.toLocaleString('en-IN')}</span>\` : '',
                t.consider  ? \`<span class="pt-history-chip" style="background:rgba(255,217,61,0.15);color:#ffd93d">🟡 ₹\${t.consider.toLocaleString('en-IN')}</span>\` : '',
                t.fair      ? \`<span class="pt-history-chip" style="background:rgba(160,160,176,0.15);color:#a0a0b0">⚪ ₹\${t.fair.toLocaleString('en-IN')}</span>\` : '',
                t.reduce    ? \`<span class="pt-history-chip" style="background:rgba(255,107,107,0.15);color:#ff6b6b">🔴 ₹\${t.reduce.toLocaleString('en-IN')}</span>\` : '',
            ].filter(Boolean).join('');
            const snippet = h.summary || '';
            return \`<div class="pt-history-row">
                <span class="pt-history-date">\${d}</span>
                <span class="pt-history-price">@ ₹\${h.priceAtSuggestion?.toFixed(0)}</span>
                \${chips}
                <button onclick="deleteTargetEntry(\${origIdx})" style="margin-left:auto;background:none;border:none;cursor:pointer;font-size:11px;color:#ff6b6b;opacity:0.55;padding:0 2px;flex-shrink:0" title="Delete this entry">✕</button>
                \${snippet ? \`<div class="pt-history-reasoning">\${snippet}</div>\` : ''}
            </div>\`;
        }

        function renderHistory(history) {
            if (!history || history.length === 0) {
                document.getElementById('ptHistory').style.display = 'none';
                return;
            }
            document.getElementById('ptHistory').style.display = 'block';

            const sorted = [...history].map((h, origIdx) => ({ h, origIdx })).reverse();
            const visible = sorted.slice(0, 3);
            const hidden  = sorted.slice(3);

            const visibleHtml = visible.map(({ h, origIdx }) => buildHistoryRow(h, origIdx)).join('');
            const hiddenHtml  = hidden.length > 0
                ? \`<div id="ptHistoryExtra" style="display:none">\${hidden.map(({ h, origIdx }) => buildHistoryRow(h, origIdx)).join('')}</div>
                   <div style="text-align:center;margin-top:6px">
                       <button class="pt-show-more" id="ptShowMoreBtn" onclick="toggleHistoryMore()">Show \${hidden.length} more ▾</button>
                   </div>\`
                : '';

            document.getElementById('ptHistoryRows').innerHTML = visibleHtml + hiddenHtml;
        }

        function toggleHistoryMore() {
            const extra = document.getElementById('ptHistoryExtra');
            const btn   = document.getElementById('ptShowMoreBtn');
            if (!extra || !btn) return;
            const expanded = extra.style.display === 'none';
            extra.style.display = expanded ? 'block' : 'none';
            btn.textContent = expanded ? 'Show less ▴' : \`Show \${extra.children.length} more ▾\`;
        }

        let priceTargetsLoaded = false;
        let priceTargetsData = null;

        window.addEventListener('load', function() {
            loadPriceTargets();
            // AI will fire once price targets load (or after 1s timeout)
            setTimeout(function() {
                if (!priceTargetsLoaded && document.getElementById('aiLoading')) {
                    triggerAIGeneration();
                }
            }, 1000);
        });

        function triggerAIGeneration() {
            priceTargetsLoaded = true;
            if (document.getElementById('aiLoading')) {
                vscode.postMessage({ type: 'generateProsConsAI', symbol: stock.symbol, fundamentals: f, priceTargets: priceTargetsData || null });
            }
        }

        window.addEventListener('message', function(event) {
            const msg = event.data;
            if (msg.type === 'priceTargetsLoaded') {
                if (msg.targets) {
                    priceTargetsData = msg.targets;
                    updateZoneLabel(msg.targets);
                    renderTargetsTable(msg.targets);
                    const latest = msg.history?.length ? msg.history[msg.history.length - 1] : null;
                    if (latest?.reasoning || latest?.summary) { renderReasoning(latest.reasoning, 'ptReasoningWrap', latest.summary); }
                    if (phChart) { loadPriceHistory(phCurrentRange, phCurrentRange === '1d' ? '1d' : phCurrentRange === '5d' ? '1d' : phCurrentRange === '2y' || phCurrentRange === '5y' ? '1wk' : '1d', null); }
                }
                renderHistory(msg.history);
                setLastUpdated(msg.history);
                priceTargetsData = msg.targets;
                updateZoneLabel(msg.targets);
                renderTargetsTable(msg.targets);
                if (!priceTargetsLoaded) {
                    // Auto-generate only if no entry from today
                    const history = msg.history || [];
                    const lastEntry = history[history.length - 1];
                    const lastDate = lastEntry ? new Date(lastEntry.date).toDateString() : null;
                    const today = new Date().toDateString();
                    if (lastDate !== today) { requestAIPriceSuggestions(); }
                    else { priceTargetsLoaded = true; }
                    triggerAIGeneration();
                }
            } else if (msg.type === 'prosConsResult') {
                document.getElementById('aiLoading')?.remove();
                const container = document.getElementById('aiProsConsResult');
                if (container) { container.style.display = 'block'; container.innerHTML = msg.html; }
            } else if (msg.type === 'priceSuggestionsResult') {
                document.getElementById('ptAiLoading').style.display = 'none';
                document.getElementById('ptRefreshBtn').disabled = false;
                if (msg.targets) {
                    priceTargetsData = msg.targets;
                    updateZoneLabel(msg.targets);
                    renderTargetsTable(msg.targets);
                    if (msg.targets.reasoning || msg.targets.summary) { renderReasoning(msg.targets.reasoning, 'ptReasoningWrap', msg.targets.summary); }
                    renderHistory(msg.history);
                    setLastUpdated(msg.history);
                    loadPriceHistory(phCurrentRange, phCurrentRange === '1d' ? '1d' : phCurrentRange === '5d' ? '1d' : phCurrentRange === '2y' || phCurrentRange === '5y' ? '1wk' : '1d', null);
                }
            } else if (msg.type === 'targetEntryDeleted') {
                renderHistory(msg.history);
                const latest = msg.history.length > 0 ? msg.history[msg.history.length - 1].targets : null;
                priceTargetsData = latest || null;
                updateZoneLabel(priceTargetsData);
                renderTargetsTable(priceTargetsData);
                loadPriceHistory(phCurrentRange, phCurrentRange === '1d' ? '1d' : phCurrentRange === '5d' ? '1d' : phCurrentRange === '2y' || phCurrentRange === '5y' ? '1wk' : '1d', null);
            } else if (msg.type === 'priceHistoryData') {
                renderPriceHistoryChart(msg.timestamps, msg.closes, phCurrentRange);
            } else if (msg.type === 'priceHistoryError') {
                document.getElementById('phLoading').style.display = 'none';
                document.getElementById('phError').style.display = 'block';
                document.getElementById('phError').textContent = '⚠️ ' + msg.message;
            }
        });

        // Price History chart — fetch via extension host (avoids CORS)
        let phChart = null;
        let phCurrentRange = '3mo';
        const overlays = { aiTargets: true, '52w': false };

        function toggleOverlay(key) {
            overlays[key] = !overlays[key];
            const btn = document.getElementById('toggle' + key.charAt(0).toUpperCase() + key.slice(1));
            btn.classList.toggle('active', overlays[key]);
            const interval = phCurrentRange === '1d' ? '1d' : (phCurrentRange === '5d' ? '1d' : (phCurrentRange === '2y' || phCurrentRange === '5y' ? '1wk' : '1d'));
            loadPriceHistory(phCurrentRange, interval, null);
        }

        function loadPriceHistory(range, interval, btn) {
            document.querySelectorAll('.tv-tab').forEach(t => t.classList.remove('active'));
            if (btn) { btn.classList.add('active'); }
            else {
                // activate matching button on init
                document.querySelectorAll('.tv-tab').forEach(t => {
                    if (t.getAttribute('onclick')?.includes(\`'\${range}'\`)) { t.classList.add('active'); }
                });
            }
            phCurrentRange = range;
            document.getElementById('phLoading').style.display = 'block';
            document.getElementById('phError').style.display = 'none';
            vscode.postMessage({ type: 'fetchPriceHistory', symbol: stock.symbol, range, interval });
        }

        function renderPriceHistoryChart(timestamps, closes, range) {
            document.getElementById('phLoading').style.display = 'none';
            const labels = (timestamps || []).map(t => {
                const d = new Date(t * 1000);
                return range === '1d'
                    ? d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
                    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: (range === '5y' || range === '2y') ? 'numeric' : undefined });
            });
            const validCloses = (closes || []).map(c => c ?? null);
            const firstVal = validCloses.find(c => c !== null) || 0;
            const lastVal  = [...validCloses].reverse().find(c => c !== null) || 0;
            const isUp     = lastVal >= firstVal;
            const lineColor = isUp ? '#4ecca3' : '#ff6b6b';
            const fillColor = isUp ? 'rgba(78,204,163,0.08)' : 'rgba(255,107,107,0.08)';
            const canvas = document.getElementById('priceHistoryChart');
            if (phChart) { phChart.destroy(); phChart = null; }
            const high52 = stock.high52w || 0;
            const low52  = stock.low52w  || 0;
            const n = labels.length;

            const datasets = [{
                label: 'Price',
                data: validCloses, borderColor: lineColor, backgroundColor: fillColor,
                fill: true, tension: 0.3, borderWidth: 2,
                pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: lineColor,
                spanGaps: true
            }];

            // 52W Range — only when toggle is on
            if (overlays['52w']) {
                if (high52 > 0) datasets.push({
                    label: '52W High', data: Array(n).fill(high52),
                    borderColor: 'rgba(255,255,255,0.25)', borderDash: [8, 4],
                    borderWidth: 1, pointRadius: 0, fill: false, spanGaps: true
                });
                if (low52 > 0) datasets.push({
                    label: '52W Low', data: Array(n).fill(low52),
                    borderColor: 'rgba(255,255,255,0.25)', borderDash: [8, 4],
                    borderWidth: 1, pointRadius: 0, fill: false, spanGaps: true
                });
            }

            // AI price targets — only when toggled on
            // Colors chosen to be distinct from price line (green/red) and 52W (white)
            const pt = priceTargetsData;
            if (pt && overlays.aiTargets) {
                const targetLevels = [
                    { key: 'strongBuy', label: 'Strong Buy',  color: '#00d4aa', dash: [4,3] },  // teal
                    { key: 'buy',       label: 'Buy',         color: '#60a5fa', dash: [4,3] },  // blue
                    { key: 'consider',  label: 'Consider',    color: '#fbbf24', dash: [4,3] },  // amber
                    { key: 'fair',      label: 'Fair Value',  color: '#e2e8f0', dash: [6,3] },  // white — solid-ish
                    { key: 'reduce',    label: 'Reduce',      color: '#f87171', dash: [4,3] },  // rose
                ];
                targetLevels.forEach(({ key, label, color, dash }) => {
                    if (pt[key] > 0) datasets.push({
                        label, data: Array(n).fill(pt[key]),
                        borderColor: color, borderDash: dash,
                        borderWidth: 1.5, pointRadius: 0, fill: false, spanGaps: true
                    });
                });
            }

            phChart = new Chart(canvas, {
                type: 'line',
                data: { labels, datasets },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { intersect: false, mode: 'index' },
                    layout: { padding: { left: 80 } },
                    scales: {
                        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#a0a0b0', maxTicksLimit: 8, maxRotation: 0 }},
                        y: { position: 'right', grid: { color: 'rgba(255,255,255,0.04)' },
                             ticks: { color: '#a0a0b0', callback: v => '₹' + Number(v).toLocaleString('en-IN') }}
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: { backgroundColor: '#16213e', borderColor: '#2d3a5a', borderWidth: 1,
                            callbacks: { label: ctx => \` \${ctx.dataset.label}: ₹\${Number(ctx.parsed.y).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\` }}
                    }
                },
                plugins: [{
                    id: 'lineLabels',
                    afterDraw(chart) {
                        const ctx = chart.ctx;
                        const yAxis = chart.scales.y;
                        const xLeft = chart.chartArea.left;
                        chart.data.datasets.forEach((ds, i) => {
                            if (ds.label === 'Price' || !ds.data || !ds.data[0]) return;
                            const val = ds.data[0];
                            const yPx = yAxis.getPixelForValue(val);
                            if (yPx < chart.chartArea.top || yPx > chart.chartArea.bottom) return;
                            ctx.save();
                            ctx.font = '10px sans-serif';
                            ctx.fillStyle = ds.borderColor;
                            ctx.textAlign = 'right';
                            ctx.textBaseline = 'middle';
                            ctx.fillText(ds.label, xLeft - 6, yPx);
                            ctx.restore();
                        });
                    }
                }]
            });
        }

        // Load default on open
        loadPriceHistory('3mo', '1d', null);

        function toggleDesc() {
            const el = document.getElementById('headerDesc');
            const btn = document.getElementById('descToggle');
            if (!el || !btn) return;
            const expanded = el.classList.toggle('expanded');
            btn.textContent = expanded ? 'less ▴' : 'more ▾';
        }

        function formatCurrency(value) {
            if (Math.abs(value) >= 10000000) return '₹' + (value / 10000000).toFixed(2) + ' Cr';
            if (Math.abs(value) >= 100000) return '₹' + (value / 100000).toFixed(2) + ' L';
            return '₹' + value.toLocaleString('en-IN', { maximumFractionDigits: 0 });
        }
        
        function getVerdictClass(verdict) {
            const v = verdict.toLowerCase();
            if (v.includes('strong')) return 'strong-buy';
            if (v.includes('buy')) return 'buy';
            if (v.includes('weak')) return 'weak-hold';
            if (v.includes('hold')) return 'hold';
            return 'sell';
        }

        const ZONE_CLASS_MAP = {
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
        function getZoneBandClass(label) {
            if (!label) return '';
            for (const [key, cls] of Object.entries(ZONE_CLASS_MAP)) {
                if (label.includes(key)) return cls;
            }
            return 'zone-btw';
        }
        
        // Scenario-based projections
        // Revenue CAGR is more stable than profit (profit can be distorted by one-off years)
        // Use average of revenue + profit 5Y where both available, else prefer revenue
        const revenueCagr = f.salesGrowth5Y   ?? f.salesGrowth3Y   ?? null;
        const profitCagr  = f.profitGrowth5Y  ?? f.profitGrowth3Y  ?? null;
        const baseGrowth = (revenueCagr !== null && profitCagr !== null)
            ? (revenueCagr + profitCagr) / 2
            : (revenueCagr ?? profitCagr ?? null);
        const scenarios = {
            conservative: baseGrowth * 0.6,
            moderate:     baseGrowth,
            optimistic:   baseGrowth * 1.4
        };
        
        function setScenario(scenario) {
            // Update tab styling
            document.querySelectorAll('.scenario-tab').forEach(tab => {
                tab.classList.remove('active');
                if (tab.textContent.toLowerCase().includes(scenario)) {
                    tab.classList.add('active');
                }
            });
            
            // Calculate projections
            const growth = scenarios[scenario];
            const currentPrice = stock.currentPrice;
            const investedValue = stock.investedValue;
            
            const project = (years) => {
                const factor = Math.pow(1 + growth / 100, years);
                const price = currentPrice * factor;
                const returnPct = (factor - 1) * 100;
                // CAGR back-calculated from projected price to current price over N years
                const cagr = (Math.pow(price / currentPrice, 1 / years) - 1) * 100;
                return { price, returnPct, futureValue: investedValue * factor, cagr };
            };
            
            const proj3Y = project(3);
            const proj5Y = project(5);
            const proj10Y = project(10);
            
            document.getElementById('predictionGrid').innerHTML = \`
                <div class="prediction-card">
                    <div class="period">3 Years</div>
                    <div class="projected-price">₹\${proj3Y.price.toFixed(0)}</div>
                    <div class="projected-return \${proj3Y.returnPct >= 0 ? 'positive' : 'negative'}">
                        \${proj3Y.returnPct >= 0 ? '+' : ''}\${proj3Y.returnPct.toFixed(0)}%
                    </div>
                    <div class="cagr">@ \${proj3Y.cagr.toFixed(1)}% CAGR</div>
                    <div class="invested-value">
                        Your ₹\${formatCurrency(investedValue)} becomes
                        <span class="future">\${formatCurrency(proj3Y.futureValue)}</span>
                    </div>
                </div>
                <div class="prediction-card">
                    <div class="period">5 Years</div>
                    <div class="projected-price">₹\${proj5Y.price.toFixed(0)}</div>
                    <div class="projected-return \${proj5Y.returnPct >= 0 ? 'positive' : 'negative'}">
                        \${proj5Y.returnPct >= 0 ? '+' : ''}\${proj5Y.returnPct.toFixed(0)}%
                    </div>
                    <div class="cagr">@ \${proj5Y.cagr.toFixed(1)}% CAGR</div>
                    <div class="invested-value">
                        Your ₹\${formatCurrency(investedValue)} becomes
                        <span class="future">\${formatCurrency(proj5Y.futureValue)}</span>
                    </div>
                </div>
                <div class="prediction-card">
                    <div class="period">10 Years</div>
                    <div class="projected-price">₹\${proj10Y.price.toFixed(0)}</div>
                    <div class="projected-return \${proj10Y.returnPct >= 0 ? 'positive' : 'negative'}">
                        \${proj10Y.returnPct >= 0 ? '+' : ''}\${proj10Y.returnPct.toFixed(0)}%
                    </div>
                    <div class="cagr">@ \${proj10Y.cagr.toFixed(1)}% CAGR</div>
                    <div class="invested-value">
                        Your ₹\${formatCurrency(investedValue)} becomes
                        <span class="future">\${formatCurrency(proj10Y.futureValue)}</span>
                    </div>
                </div>
            \`;
        }
        
        // Score Radar Chart
        const radarCtx = document.getElementById('scoreRadar').getContext('2d');
        new Chart(radarCtx, {
            type: 'radar',
            data: {
                labels: ['Revenue', 'Profit', 'Balance', 'Cash Flow', 'Mgmt', 'Industry', 'Moat', 'Value', 'Capital', 'Risk'],
                datasets: [{
                    label: 'Score',
                    data: [
                        stock.scores.revenueGrowth,
                        stock.scores.profitGrowth,
                        stock.scores.balanceSheet,
                        stock.scores.cashFlow,
                        stock.scores.management,
                        stock.scores.industry,
                        stock.scores.moat,
                        stock.scores.valuation,
                        stock.scores.capitalAllocation,
                        stock.scores.risk
                    ],
                    backgroundColor: 'rgba(78, 204, 163, 0.2)',
                    borderColor: '#4ecca3',
                    borderWidth: 2,
                    pointBackgroundColor: '#4ecca3'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    r: {
                        beginAtZero: true,
                        max: 10,
                        ticks: { stepSize: 2, color: '#a0a0b0', backdropColor: 'transparent' },
                        grid: { color: 'rgba(255,255,255,0.1)' },
                        angleLines: { color: 'rgba(255,255,255,0.1)' },
                        pointLabels: { color: '#a0a0b0', font: { size: 10 } }
                    }
                },
                plugins: {
                    legend: { display: false }
                }
            }
        });
        
        // Shareholding Pie Chart — only render when real data exists
        const holdingData = [
            f.promoterHolding ?? null,
            f.fiiHolding ?? null,
            f.diiHolding ?? null,
            f.publicHolding ?? null
        ];
        const hasHoldingData = holdingData.some(v => v !== null && v > 0);

        if (hasHoldingData) {
            const pieCtx = document.getElementById('shareholdingChart').getContext('2d');
            new Chart(pieCtx, {
                type: 'doughnut',
                data: {
                    labels: ['Promoters', 'FII', 'DII', 'Public'],
                    datasets: [{
                        data: holdingData.map(v => v ?? 0),
                        backgroundColor: ['#4ecca3', '#7c4dff', '#ffd93d', '#4dabf7'],
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'right',
                            labels: { color: '#a0a0b0', font: { size: 11 }, padding: 12 }
                        },
                        tooltip: {
                            callbacks: {
                                label: function(ctx) {
                                    return ctx.label + ': ' + ctx.raw.toFixed(1) + '%';
                                }
                            }
                        }
                    }
                }
            });
        }
        
    </script>
</body>
</html>`;

    function formatCurrency(value: number): string {
      if (Math.abs(value) >= 10000000)
        return "₹" + (value / 10000000).toFixed(2) + " Cr";
      if (Math.abs(value) >= 100000)
        return "₹" + (value / 100000).toFixed(2) + " L";
      return "₹" + value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
    }

    function getVerdictClass(verdict: string): string {
      const v = verdict.toLowerCase();
      if (v.includes("super")) return "super-strong-buy";
      if (v.includes("strong")) return "strong-buy";
      if (v.includes("buy")) return "buy";
      if (v.includes("weak")) return "weak-hold";
      if (v.includes("hold")) return "hold";
      return "sell";
    }

    function getScoreClass(score: number): string {
      if (score >= 7) return "high";
      if (score >= 5) return "medium";
      return "low";
    }

    function getPEIndicator(
      pe: number | null | undefined,
      indPE: number | null | undefined,
    ): string {
      if (!pe || !indPE) return "";
      const ratio = pe / indPE;
      if (ratio < 0.8) {
        return '<span class="valuation-indicator undervalued" title="P/E < 80% of Industry P/E">Undervalued</span>';
      } else if (ratio <= 1.2) {
        return '<span class="valuation-indicator fair" title="P/E within 80-120% of Industry P/E">Fair Value</span>';
      } else {
        return '<span class="valuation-indicator overvalued" title="P/E > 120% of Industry P/E">Overvalued</span>';
      }
    }

    function getPBIndicator(pb: number | null | undefined): string {
      if (!pb) return "";
      if (pb < 1.5) {
        return '<span class="valuation-indicator undervalued" title="P/B < 1.5 (Trading below 1.5x book value)">Attractive</span>';
      } else if (pb <= 3) {
        return '<span class="valuation-indicator fair" title="P/B between 1.5 - 3.0">Fair</span>';
      } else if (pb <= 5) {
        return '<span class="valuation-indicator overvalued" title="P/B between 3.0 - 5.0">Premium</span>';
      } else {
        return '<span class="valuation-indicator overvalued" title="P/B > 5.0 (Very high premium)">Expensive</span>';
      }
    }

    function getPETrendIndicator(peChange: number | null | undefined): string {
      if (peChange === null || peChange === undefined) return "";
      if (peChange < -15) {
        return (
          '<span class="valuation-indicator undervalued" title="Current P/E is more than 15% below 5-year median">↓ ' +
          Math.abs(peChange).toFixed(0) +
          "% Below Avg</span>"
        );
      } else if (peChange <= 15) {
        return '<span class="valuation-indicator fair" title="Current P/E is within ±15% of 5-year median">≈ Near Average</span>';
      } else {
        return (
          '<span class="valuation-indicator overvalued" title="Current P/E is more than 15% above 5-year median">↑ ' +
          peChange.toFixed(0) +
          "% Above Avg</span>"
        );
      }
    }

    function renderScoreItems(stock: StockAnalysis): string {
      const items = [
        { name: "Revenue Growth (15%)", score: stock.scores.revenueGrowth },
        { name: "Profit Growth (15%)", score: stock.scores.profitGrowth },
        { name: "Balance Sheet (10%)", score: stock.scores.balanceSheet },
        { name: "Cash Flow (10%)", score: stock.scores.cashFlow },
        { name: "Management (10%)", score: stock.scores.management },
        { name: "Industry Tailwind (10%)", score: stock.scores.industry },
        { name: "Competitive Moat (10%)", score: stock.scores.moat },
        { name: "Valuation (10%)", score: stock.scores.valuation },
        { name: "Capital Alloc (5%)", score: stock.scores.capitalAllocation },
        { name: "Risk Level (5%)", score: stock.scores.risk },
      ];

      return items
        .map(
          (item) => `
                <div class="score-item">
                    <span class="name">${item.name}</span>
                    <div class="score-bar-bg">
                        <div class="score-bar-fill ${getScoreClass(item.score)}" style="width: ${item.score * 10}%"></div>
                    </div>
                    <span class="score">${item.score}/10</span>
                </div>
            `,
        )
        .join("");
    }

    function renderPredictions(
      stock: StockAnalysis,
      f: Partial<FundamentalData>,
    ): string {
      const revenueCagr = f.salesGrowth5Y ?? f.salesGrowth3Y ?? null;
      const profitCagr = f.profitGrowth5Y ?? f.profitGrowth3Y ?? null;
      const moderateGrowth =
        revenueCagr !== null && profitCagr !== null
          ? (revenueCagr + profitCagr) / 2
          : (revenueCagr ?? profitCagr ?? null);
      const currentPrice = stock.currentPrice;
      const investedValue = stock.investedValue;

      const project = (years: number, growthRate: number) => {
        const factor = Math.pow(1 + growthRate / 100, years);
        const price = currentPrice * factor;
        const returnPct = (factor - 1) * 100;
        const cagr = (Math.pow(price / currentPrice, 1 / years) - 1) * 100;
        return { price, returnPct, futureValue: investedValue * factor, cagr };
      };

      const proj3Y = project(3, moderateGrowth ?? 0);
      const proj5Y = project(5, moderateGrowth ?? 0);
      const proj10Y = project(10, moderateGrowth ?? 0);

      return `
                <div class="prediction-card">
                    <div class="period">3 Years</div>
                    <div class="projected-price">₹${proj3Y.price.toFixed(0)}</div>
                    <div class="projected-return ${proj3Y.returnPct >= 0 ? "positive" : "negative"}">
                        ${proj3Y.returnPct >= 0 ? "+" : ""}${proj3Y.returnPct.toFixed(0)}%
                    </div>
                    <div class="cagr">@ ${proj3Y.cagr.toFixed(1)}% CAGR</div>
                    <div class="invested-value">
                        Your ₹${formatCurrency(investedValue)} becomes
                        <span class="future">${formatCurrency(proj3Y.futureValue)}</span>
                    </div>
                </div>
                <div class="prediction-card">
                    <div class="period">5 Years</div>
                    <div class="projected-price">₹${proj5Y.price.toFixed(0)}</div>
                    <div class="projected-return ${proj5Y.returnPct >= 0 ? "positive" : "negative"}">
                        ${proj5Y.returnPct >= 0 ? "+" : ""}${proj5Y.returnPct.toFixed(0)}%
                    </div>
                    <div class="cagr">@ ${proj5Y.cagr.toFixed(1)}% CAGR</div>
                    <div class="invested-value">
                        Your ₹${formatCurrency(investedValue)} becomes
                        <span class="future">${formatCurrency(proj5Y.futureValue)}</span>
                    </div>
                </div>
                <div class="prediction-card">
                    <div class="period">10 Years</div>
                    <div class="projected-price">₹${proj10Y.price.toFixed(0)}</div>
                    <div class="projected-return ${proj10Y.returnPct >= 0 ? "positive" : "negative"}">
                        ${proj10Y.returnPct >= 0 ? "+" : ""}${proj10Y.returnPct.toFixed(0)}%
                    </div>
                    <div class="cagr">@ ${proj10Y.cagr.toFixed(1)}% CAGR</div>
                    <div class="invested-value">
                        Your ₹${formatCurrency(investedValue)} becomes
                        <span class="future">${formatCurrency(proj10Y.futureValue)}</span>
                    </div>
                </div>
            `;
    }
  }
}
