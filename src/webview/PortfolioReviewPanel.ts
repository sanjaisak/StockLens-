/**
 * Portfolio Review Panel
 * Opens in a separate editor tab and streams the AI portfolio review
 */

import * as vscode from "vscode";
import { StockAnalysis } from "../services/AnalysisService";
import { PortfolioSidebarProvider } from "./PortfolioSidebarProvider";

export class PortfolioReviewPanel {
  public static readonly viewType = "portfolioAnalyzer.portfolioReview";
  private static _current: PortfolioReviewPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    stocks: StockAnalysis[],
    summary: any,
    zones: Record<string, string>,
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : vscode.ViewColumn.One;

    if (PortfolioReviewPanel._current) {
      PortfolioReviewPanel._current._panel.reveal(column);
      PortfolioReviewPanel._current._startReview(stocks, summary, zones);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      PortfolioReviewPanel.viewType,
      "🤖 AI Portfolio Review",
      column || vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
    );

    PortfolioReviewPanel._current = new PortfolioReviewPanel(panel);
    PortfolioReviewPanel._current._startReview(stocks, summary, zones);
  }

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._panel.webview.html = this._getHtml();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  private async _startReview(
    stocks: StockAnalysis[],
    summary: any,
    zones: Record<string, string>,
  ) {
    this._panel.webview.postMessage({ type: "reviewStart" });

    await PortfolioSidebarProvider.generatePortfolioReview(
      stocks,
      summary,
      zones,
      (chunk) => this._panel.webview.postMessage({ type: "chunk", chunk }),
      () => this._panel.webview.postMessage({ type: "done" }),
      (err) => this._panel.webview.postMessage({ type: "error", message: err }),
    );
  }

  public dispose() {
    PortfolioReviewPanel._current = undefined;
    this._panel.dispose();
    this._disposables.forEach((d) => d.dispose());
    this._disposables = [];
  }

  private _getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Portfolio Review</title>
<style>
  :root {
    --bg:       var(--vscode-editor-background);
    --fg:       var(--vscode-editor-foreground);
    --border:   var(--vscode-panel-border);
    --muted:    var(--vscode-descriptionForeground);
    --accent:   var(--vscode-button-background);
    --green:    #4ecca3;
    --blue:     #5bc0eb;
    --yellow:   #ffd93d;
    --red:      #ff6b6b;
    --orange:   #ff9f43;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 13.5px;
    color: var(--fg);
    background: var(--bg);
    padding: 36px 40px;
    max-width: 860px;
    margin: 0 auto;
    line-height: 1.7;
  }

  /* ── Header ── */
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 32px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border);
    gap: 16px;
  }
  .page-header h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.3px; }
  .page-header .sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .status-chip {
    flex-shrink: 0;
    font-size: 11px;
    padding: 5px 14px;
    border-radius: 20px;
    border: 1px solid var(--border);
    color: var(--muted);
    white-space: nowrap;
  }
  .status-chip.generating { border-color: var(--accent); color: var(--accent); animation: pulse 1.4s ease-in-out infinite; }
  .status-chip.done   { border-color: var(--green);  color: var(--green); }
  .status-chip.error  { border-color: var(--red);    color: var(--red); }
  @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.45 } }

  /* ── Spinner ── */
  .spinner-wrap { display:flex; align-items:center; gap:12px; padding:48px 0; color:var(--muted); font-size:13px; }
  .spinner { width:20px; height:20px; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:spin 0.75s linear infinite; flex-shrink:0; }
  @keyframes spin { to { transform:rotate(360deg) } }

  /* ── Sections ── */
  .rs {
    margin-bottom: 24px;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .rs h3 {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.7px;
    padding: 10px 16px;
    margin: 0;
    border-bottom: 1px solid var(--border);
  }
  .rs > p, .rs > ul { padding: 14px 16px; }
  .rs > p + p { padding-top: 0; }
  .rs > ul { padding-top: 10px; padding-bottom: 14px; }
  .rs p { margin-bottom: 8px; opacity: 0.92; }
  .rs p:last-child { margin-bottom: 0; }

  /* Section accent colours */
  .rs-health  h3 { background: rgba(91,192,235,0.12);  color: var(--blue);   border-color: rgba(91,192,235,0.2); }
  .rs-stocks  h3 { background: rgba(78,204,163,0.12);  color: var(--green);  border-color: rgba(78,204,163,0.2); }
  .rs-rebalance h3 { background: rgba(255,217,61,0.1);  color: var(--yellow); border-color: rgba(255,217,61,0.18); }
  .rs-risks   h3 { background: rgba(255,107,107,0.12); color: var(--red);    border-color: rgba(255,107,107,0.2); }
  .rs-opps    h3 { background: rgba(78,204,163,0.12);  color: var(--green);  border-color: rgba(78,204,163,0.2); }

  /* Section border-left accent */
  .rs-health    { border-color: rgba(91,192,235,0.25); }
  .rs-stocks    { border-color: rgba(78,204,163,0.25); }
  .rs-rebalance { border-color: rgba(255,217,61,0.22); }
  .rs-risks     { border-color: rgba(255,107,107,0.25); }
  .rs-opps      { border-color: rgba(78,204,163,0.25); }

  /* ── Stock cards ── */
  .stock-card {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .stock-card:last-child { border-bottom: none; }
  .stock-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 5px;
    flex-wrap: wrap;
  }
  .sym {
    font-size: 13px;
    font-weight: 700;
    color: var(--fg);
    letter-spacing: 0.2px;
  }
  .stock-card p { font-size: 12.5px; opacity: 0.85; margin: 0; line-height: 1.6; }

  /* Verdict badges */
  .badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 8px;
    letter-spacing: 0.3px;
    white-space: nowrap;
  }
  .badge-strong-buy { background: rgba(78,204,163,0.18);  color: var(--green);  }
  .badge-buy        { background: rgba(91,192,235,0.18);  color: var(--blue);   }
  .badge-hold       { background: rgba(255,217,61,0.15);  color: var(--yellow); }
  .badge-weak-hold  { background: rgba(255,159,67,0.15);  color: var(--orange); }
  .badge-sell       { background: rgba(255,107,107,0.15); color: var(--red);    }

  /* Zone tag */
  .zone-tag {
    font-size: 10px;
    color: var(--muted);
    opacity: 0.75;
    white-space: nowrap;
  }

  /* ── Lists ── */
  .rs ul {
    list-style: none;
    padding: 10px 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .rs ul li {
    display: flex;
    gap: 10px;
    font-size: 13px;
    line-height: 1.6;
    opacity: 0.9;
  }
  .rs ul li::before {
    content: '›';
    font-weight: 700;
    flex-shrink: 0;
    margin-top: 1px;
  }
  .rs-rebalance ul li::before { color: var(--yellow); }
  .rs-risks     ul li::before { color: var(--red);    }
  .rs-opps      ul li::before { color: var(--green);  }

  /* bold/strong inside content */
  b, strong { font-weight: 600; }

  /* ── Timestamp ── */
  .timestamp {
    margin-top: 28px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--muted);
    opacity: 0.55;
  }
</style>
</head>
<body>
  <div class="page-header">
    <div>
      <h1>🤖 AI Portfolio Review</h1>
      <div class="sub">Powered by Claude · Score, zone, P&amp;L &amp; sector analysis</div>
    </div>
    <span class="status-chip" id="statusChip">Waiting…</span>
  </div>

  <div id="spinner" class="spinner-wrap">
    <div class="spinner"></div>
    Analyzing your holdings, please wait…
  </div>

  <div id="content" style="display:none"></div>
  <div id="timestamp" class="timestamp" style="display:none"></div>

  <script>
    const vscode = acquireVsCodeApi();
    let _buffer = '';

    window.addEventListener('message', event => {
      const msg     = event.data;
      const content = document.getElementById('content');
      const spinner = document.getElementById('spinner');
      const chip    = document.getElementById('statusChip');
      const ts      = document.getElementById('timestamp');

      if (msg.type === 'reviewStart') {
        _buffer = '';
        content.style.display = 'none';
        content.innerHTML = '';
        spinner.style.display = 'flex';
        chip.className = 'status-chip generating';
        chip.textContent = '⏳ Generating…';
        ts.style.display = 'none';

      } else if (msg.type === 'chunk') {
        // Accumulate — don't touch DOM yet (partial HTML breaks rendering)
        _buffer += msg.chunk;

      } else if (msg.type === 'done') {
        // Full response received — write once so DOM is always valid HTML
        spinner.style.display = 'none';
        content.style.display = 'block';
        content.innerHTML = _buffer.replace(/\`\`\`html?\\n?|\`\`\`/g, '').trim();
        chip.className = 'status-chip done';
        chip.textContent = '✓ Complete';
        ts.style.display = 'block';
        ts.textContent = 'Generated ' + new Date().toLocaleString();

      } else if (msg.type === 'error') {
        spinner.style.display = 'none';
        content.style.display = 'block';
        content.innerHTML = '<p style="color:var(--red);opacity:0.85;padding:8px 0">⚠️ ' + msg.message + '</p>';
        chip.className = 'status-chip error';
        chip.textContent = '✗ Error';
      }
    });
  </script>
</body>
</html>`;
  }
}
