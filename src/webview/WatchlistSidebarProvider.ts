/**
 * Watchlist Sidebar Provider
 * Renders multiple named watchlists with live prices and analysis scores.
 */

import * as vscode from "vscode";
import { WatchlistService, Watchlist } from "../services/WatchlistService";
import { StockSearchService } from "../services/StockSearchService";
import { StockAnalysis } from "../services/AnalysisService";
import { StockDetailPanel } from "./StockDetailPanel";

interface WatchlistStockData extends StockAnalysis {
  watchlistId: string;
}

export class WatchlistSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "portfolioAnalyzer.watchlist";

  private _view?: vscode.WebviewView;
  private readonly _cache = new Map<string, WatchlistStockData>();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _watchlistService: WatchlistService,
    private readonly _stockSearchService: StockSearchService,
    private readonly _context: vscode.ExtensionContext,
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          await this.refresh();
          break;
        case "createWatchlist":
          await this.createWatchlist();
          break;
        case "renameWatchlist":
          await this._renameWatchlist(msg.id);
          break;
        case "deleteWatchlist":
          await this._deleteWatchlist(msg.id);
          break;
        case "addStock":
          await this._addStock(msg.watchlistId);
          break;
        case "removeStock":
          await this._watchlistService.removeStock(msg.watchlistId, msg.symbol);
          await this.refresh();
          break;
        case "moveStock":
          await this._moveStock(msg.symbol, msg.fromId);
          break;
        case "openStock":
          await this._openStockDetail(msg.symbol);
          break;
        case "refresh":
          await this.refresh();
          break;
      }
    });
  }

  public async refresh() {
    if (!this._view) return;

    const lists = this._watchlistService.getAll();
    if (lists.length === 0) {
      this._post({ type: "empty" });
      return;
    }

    this._post({ type: "loading" });

    // Fetch live data for all stocks across all watchlists
    const results: { list: Watchlist; stocks: WatchlistStockData[] }[] = [];
    const today = new Date().toDateString();
    const zones: Record<string, string> = {};

    for (const list of lists) {
      const stocks: WatchlistStockData[] = [];
      await Promise.all(
        list.stocks.map(async (s) => {
          try {
            const analysis = await this._stockSearchService.analyzeStock(s.symbol);
            if (analysis) {
              const entry = { ...analysis, watchlistId: list.id };
              this._cache.set(s.symbol, entry);
              stocks.push(entry);

              // Generate AI targets if none exist today
              const key = `priceTargetHistory_${s.symbol}`;
              let history = this._context.globalState.get<any[]>(key) || [];
              const hasToday = history.some(
                (h) => new Date(h.date).toDateString() === today,
              );
              if (!hasToday) {
                await StockDetailPanel.generateAndSaveTargets(this._context, analysis);
                history = this._context.globalState.get<any[]>(key) || [];
              }
              const latest = history.length ? history[history.length - 1].targets : null;
              if (latest && analysis.currentPrice > 0) {
                zones[s.symbol] = this._getZoneLabel(analysis.currentPrice, latest);
              }
            }
          } catch {
            // skip failed stocks silently
          }
        }),
      );
      const ordered = list.stocks
        .map((s) => stocks.find((x) => x.symbol === s.symbol))
        .filter((x): x is WatchlistStockData => !!x);
      results.push({ list, stocks: ordered });
    }

    this._post({ type: "data", results, allLists: lists, zones });
  }

  /** Called from extension when a stock is added directly (e.g. from search) */
  public async addStockToWatchlist(
    symbol: string,
    name: string,
    sector: string,
  ) {
    const lists = this._watchlistService.getAll();

    let targetId: string;

    if (lists.length === 0) {
      const created = await this._watchlistService.create("My Watchlist");
      targetId = created.id;
    } else if (lists.length === 1) {
      targetId = lists[0].id;
    } else {
      const pick = await vscode.window.showQuickPick(
        lists.map((l) => ({ label: l.name, id: l.id })),
        { placeHolder: "Add to which watchlist?" },
      );
      if (!pick) return;
      targetId = pick.id;
    }

    await this._watchlistService.addStock(targetId, {
      symbol,
      name,
      sector,
      addedAt: Date.now(),
    });

    vscode.window.showInformationMessage(`${symbol} added to watchlist.`);
    await this.refresh();
  }

  private async _openStockDetail(symbol: string) {
    // Use cached analysis if available for instant open, else fetch fresh
    const cached = this._cache.get(symbol);
    if (cached) {
      await vscode.commands.executeCommand(
        "portfolioAnalyzer.openStockDetail",
        cached,
      );
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Analyzing ${symbol}...`,
        cancellable: false,
      },
      async () => {
        const analysis = await this._stockSearchService.analyzeStock(symbol);
        if (analysis) {
          const entry = { ...analysis, watchlistId: "" };
          this._cache.set(symbol, entry);
          await vscode.commands.executeCommand(
            "portfolioAnalyzer.openStockDetail",
            analysis,
          );
        } else {
          vscode.window.showErrorMessage(`Could not load data for ${symbol}.`);
        }
      },
    );
  }

  public async createWatchlist() {
    const name = await vscode.window.showInputBox({
      prompt: "Watchlist name",
      placeHolder: "e.g. Tech Stocks, Dividend Picks",
      validateInput: (v) => (v.trim() ? null : "Name cannot be empty"),
    });
    if (!name) return;
    await this._watchlistService.create(name.trim());
    await this.refresh();
  }

  private async _renameWatchlist(id: string) {
    const list = this._watchlistService.get(id);
    if (!list) return;
    const name = await vscode.window.showInputBox({
      prompt: "New name",
      value: list.name,
      validateInput: (v) => (v.trim() ? null : "Name cannot be empty"),
    });
    if (!name) return;
    await this._watchlistService.rename(id, name.trim());
    await this.refresh();
  }

  private async _deleteWatchlist(id: string) {
    const list = this._watchlistService.get(id);
    if (!list) return;
    const confirm = await vscode.window.showWarningMessage(
      `Delete watchlist "${list.name}"? This cannot be undone.`,
      { modal: true },
      "Delete",
    );
    if (confirm !== "Delete") return;
    await this._watchlistService.delete(id);
    await this.refresh();
  }

  private async _addStock(watchlistId: string) {
    const quickPick = vscode.window.createQuickPick<
      vscode.QuickPickItem & { stockSymbol?: string }
    >();
    quickPick.placeholder = "Search stock by symbol or name";
    quickPick.matchOnDescription = true;

    let debounce: NodeJS.Timeout | undefined;

    quickPick.onDidChangeValue((value) => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (value.length >= 1) {
          const results = this._stockSearchService.searchStocks(value, 15);
          quickPick.items = results.map((s) => ({
            label: `$(symbol-class) ${s.symbol}`,
            description: s.name,
            detail: s.sector,
            stockSymbol: s.symbol,
          }));
        } else {
          quickPick.items = [];
        }
      }, 100);
    });

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0] as any;
      if (selected?.stockSymbol) {
        quickPick.hide();
        const list = this._watchlistService.get(watchlistId);
        if (!list) return;
        await this._watchlistService.addStock(watchlistId, {
          symbol: selected.stockSymbol,
          name: selected.description || selected.stockSymbol,
          sector: selected.detail || "Unknown",
          addedAt: Date.now(),
        });
        vscode.window.showInformationMessage(
          `${selected.stockSymbol} added to "${list.name}".`,
        );
        await this.refresh();
      }
    });

    quickPick.onDidHide(() => {
      if (debounce) clearTimeout(debounce);
      quickPick.dispose();
    });

    quickPick.show();
  }

  private async _moveStock(symbol: string, fromId: string) {
    const lists = this._watchlistService
      .getAll()
      .filter((l) => l.id !== fromId);
    if (lists.length === 0) {
      vscode.window.showInformationMessage(
        "Create another watchlist first to move stocks.",
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      lists.map((l) => ({ label: l.name, id: l.id })),
      { placeHolder: "Move to which watchlist?" },
    );
    if (!pick) return;
    await this._watchlistService.moveStock(symbol, fromId, pick.id);
    await this.refresh();
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

  private _post(message: any) {
    this._view?.webview.postMessage(message);
  }

  private _getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Watchlist</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --bg2: var(--vscode-sideBar-background);
      --hover: var(--vscode-list-hoverBackground);
      --fg: var(--vscode-editor-foreground);
      --fg2: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --accent: var(--vscode-button-background);
      --green: #4caf50;
      --red: #f44336;
      --yellow: #ff9800;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--fg); background: var(--bg); padding: 10px; line-height: 1.4; }

    /* Buttons */
    .btn { background: var(--accent); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; }
    .btn:hover { opacity: 0.85; }
    .btn-ghost { background: transparent; color: var(--fg2); border: 1px solid var(--border); }
    .btn-ghost:hover { background: var(--hover); color: var(--fg); }
    .btn-danger { background: rgba(244,67,54,0.15); color: var(--red); border: 1px solid rgba(244,67,54,0.3); }
    .btn-danger:hover { background: rgba(244,67,54,0.25); }
    .btn-icon { background: transparent; border: none; color: var(--fg2); cursor: pointer; font-size: 13px; padding: 2px 4px; border-radius: 3px; }
    .btn-icon:hover { background: var(--hover); color: var(--fg); }

    /* States */
    .center { text-align: center; padding: 40px 16px; color: var(--fg2); }
    .spinner { width: 28px; height: 28px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 12px; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Top bar */
    .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .topbar-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--fg2); }

    /* Watchlist section */
    .watchlist-section { margin-bottom: 16px; }
    .watchlist-header { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; user-select: none; }
    .watchlist-header.open { border-radius: 6px 6px 0 0; }
    .watchlist-name { font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
    .chevron { font-size: 10px; color: var(--fg2); transition: transform 0.2s; display: inline-block; }
    .chevron.open { transform: rotate(90deg); }
    .watchlist-actions { display: flex; gap: 2px; }
    .watchlist-body { border: 1px solid var(--border); border-top: none; border-radius: 0 0 6px 6px; overflow: hidden; }
    .watchlist-body.collapsed { display: none; }

    /* Stock card */
    .stock-card { padding: 8px 10px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.1s; }
    .stock-card:last-child { border-bottom: none; }
    .stock-card:hover { background: var(--hover); }

    /* Top row: symbol + name + price + change + menu */
    .sc-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; }
    .sc-left { flex: 1; min-width: 0; }
    .sc-symbol { font-size: 12px; font-weight: 600; color: var(--accent); }
    .sc-name { font-size: 10px; color: var(--fg2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 130px; margin-top: 1px; }
    .sc-right { text-align: right; flex-shrink: 0; }
    .sc-price { font-size: 12px; font-weight: 500; }
    .sc-change { font-size: 10px; font-weight: 500; }
    .sc-menu { display: flex; gap: 2px; opacity: 0; transition: opacity 0.1s; flex-shrink: 0; margin-top: 1px; }
    .stock-card:hover .sc-menu { opacity: 1; }

    /* Metric rows */
    .sc-metrics { display: flex; flex-direction: column; gap: 3px; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
    .sc-metric-row { display: flex; align-items: center; gap: 5px; }
    .sc-metric-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--fg2); opacity: 0.7; min-width: 62px; }
    .sc-bar-wrap { display: flex; align-items: center; gap: 4px; flex: 1; }
    .sc-bar { height: 3px; border-radius: 2px; flex: 1; background: var(--border); overflow: hidden; }
    .sc-bar-fill { height: 100%; border-radius: 2px; }
    .sc-bar-fill.score-high  { background: #4caf50; }
    .sc-bar-fill.score-mid   { background: #ff9800; }
    .sc-bar-fill.score-low   { background: #f44336; }
    .sc-score-num { font-size: 9px; font-weight: 600; }

    .positive { color: var(--green); }
    .negative { color: var(--red); }
    .neutral { color: var(--fg2); }
    .score-high { color: var(--green); }
    .score-mid { color: var(--yellow); }
    .score-low { color: var(--red); }

    /* Add stock row */
    .add-stock-row { padding: 7px 10px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 6px; color: var(--fg2); font-size: 11px; cursor: pointer; }
    .add-stock-row:hover { background: var(--hover); color: var(--fg); }

    /* Empty watchlist */
    .empty-list { padding: 16px; text-align: center; color: var(--fg2); font-size: 11px; }

    /* Zone pill */
    .zone-pill { font-size: 9px; padding: 1px 7px; border-radius: 8px; font-weight: 500; white-space: nowrap; margin-top: 3px; display: inline-block; }
    .zone-sb  { background: rgba(78,204,163,0.15); color: #4ecca3; }
    .zone-b   { background: rgba(91,192,235,0.15); color: #5bc0eb; }
    .zone-c   { background: rgba(255,217,61,0.15);  color: #ffd93d; }
    .zone-fv  { background: rgba(160,160,176,0.15); color: #a0a0b0; }
    .zone-btw { background: rgba(255,159,67,0.15);  color: #ff9f43; }
    .zone-r   { background: rgba(255,107,107,0.15); color: #ff6b6b; }

    /* Verdict pill */
    .verdict { font-size: 9px; padding: 1px 6px; border-radius: 8px; font-weight: 500; white-space: nowrap; }
.verdict-sb { background: rgba(76,175,80,0.2); color: var(--green); }
    .verdict-b  { background: rgba(76,175,80,0.12); color: #6dd5a0; }
    .verdict-h  { background: rgba(255,152,0,0.15); color: var(--yellow); }
    .verdict-wh { background: rgba(255,159,67,0.12); color: #ff9f43; }
    .verdict-s  { background: rgba(244,67,54,0.12); color: var(--red); }

    /* Sort chips */
    .sort-chips { display: flex; gap: 4px; flex-wrap: wrap; padding: 6px 10px; border-bottom: 1px solid var(--border); background: var(--bg2); }
    .sort-chip { font-size: 9px; padding: 2px 7px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--fg2); cursor: pointer; font-family: var(--vscode-font-family); transition: all 0.15s; }
    .sort-chip:hover { border-color: var(--accent); color: var(--fg); }
    .sort-chip.active { background: var(--accent); color: var(--vscode-button-foreground); border-color: var(--accent); font-weight: 600; }

    .timestamp { text-align: center; font-size: 10px; color: var(--fg2); margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); }
  </style>
</head>
<body>

  <div id="loading" class="center" style="display:none;">
    <div class="spinner"></div>
    <p>Fetching prices...</p>
  </div>

  <div id="empty" class="center" style="display:none;">
    <p style="font-size:22px;margin-bottom:10px;">📋</p>
    <p style="margin-bottom:14px;">No watchlists yet.<br>Create one to start tracking stocks.</p>
    <button class="btn" onclick="send('createWatchlist')">+ New Watchlist</button>
  </div>

  <div id="content" style="display:none;">
    <div id="lists"></div>
    <div class="timestamp" id="ts"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function send(type, extra) { vscode.postMessage({ type, ...extra }); }
    let _zones = {};
    let _allResults = [];

    function getActiveSort(listId) {
      return (getState().sorts || {})[listId] || 'zone';
    }

    function setSort(listId, key) {
      const state = getState();
      const sorts = state.sorts || {};
      sorts[listId] = key;
      saveState({ ...state, sorts });
      // Update chip active states for this list
      document.querySelectorAll(\`[data-sort-list="\${listId}"] .sort-chip\`).forEach(c => {
        c.classList.toggle('active', c.dataset.sortKey === key);
      });
      // Re-render only the stock rows for this list
      const result = _allResults.find(r => r.list.id === listId);
      if (result) {
        const section = document.querySelector(\`[data-list-id="\${listId}"]\`);
        if (section) {
          section.querySelector('.wl-stock-rows').innerHTML = buildStockRows(result.stocks, listId, result.list.id);
        }
      }
    }

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

    function sortStocks(stocks, listId) {
      const key = getActiveSort(listId);
      const s = [...stocks];
      if (key === 'zone')  return s.sort((a, b) => zoneRank(a.symbol) - zoneRank(b.symbol));
      if (key === 'score') return s.sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
      if (key === 'day')   return s.sort((a, b) => (b.dayChangePct || 0) - (a.dayChangePct || 0));
      if (key === 'az')    return s.sort((a, b) => a.symbol.localeCompare(b.symbol));
      return s;
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

    function getState() { return vscode.getState() || {}; }
    function saveState(s) { vscode.setState(s); }

    function toggleCollapse(id, event) {
      event.stopPropagation();
      const state = getState();
      const collapsed = state.collapsed || {};
      collapsed[id] = !collapsed[id];
      saveState({ ...state, collapsed });
      // Toggle classes directly without full re-render
      const section = event.currentTarget.closest('.watchlist-section');
      const header = section.querySelector('.watchlist-header');
      const body = section.querySelector('.watchlist-body');
      const chevron = section.querySelector('.chevron');
      const isNowCollapsed = collapsed[id];
      header.classList.toggle('open', !isNowCollapsed);
      body.classList.toggle('collapsed', isNowCollapsed);
      chevron.classList.toggle('open', !isNowCollapsed);
    }

    function scoreClass(s) {
      return s >= 7 ? 'score-high' : s >= 5 ? 'score-mid' : 'score-low';
    }

    function verdictClass(v) {
      if (!v) return 'verdict-h';
      const u = v.toUpperCase();
if (u.includes('STRONG')) return 'verdict-sb';
      if (u.includes('BUY'))    return 'verdict-b';
      if (u.includes('WEAK'))   return 'verdict-wh';
      if (u.includes('HOLD'))   return 'verdict-h';
      return 'verdict-s';
    }

    function formatPrice(p) {
      if (!p || p === 0) return '—';
      return '₹' + p.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    }

    function buildStockRows(stocks, listId, wlId) {
      if (stocks.length === 0) return \`<div class="empty-list">No stocks — click + Add to start tracking</div>\`;
      return sortStocks(stocks, listId).map(s => {
        const chgPos = (s.dayChangePct || 0) >= 0;
        const priceDisplay = s.currentPrice > 0 ? formatPrice(s.currentPrice) : '—';
        const chgDisplay = s.currentPrice > 0
          ? \`<span class="\${chgPos ? 'positive' : 'negative'}">\${chgPos ? '▲' : '▼'} \${Math.abs(s.dayChangePct || 0).toFixed(2)}%</span>\`
          : '<span class="neutral">—</span>';
        const score = s.totalScore || 0;
        const vText = (s.verdictEmoji || '') + ' ' + (s.verdict || '');
        const zone = _zones[s.symbol];
        const sc = scoreClass(score);
        const barWidth = (score / 10 * 100).toFixed(0);
        return \`
          <div class="stock-card" onclick="send('openStock', {symbol: '\${s.symbol}'})">
            <div class="sc-top">
              <div class="sc-left">
                <div class="sc-symbol">\${s.symbol}</div>
                <div class="sc-name">\${s.name || s.symbol}</div>
              </div>
              <div class="sc-right">
                <div class="sc-price">\${priceDisplay}</div>
                <div class="sc-change">\${chgDisplay}</div>
              </div>
              <div class="sc-menu" onclick="event.stopPropagation()">
                <button class="btn-icon" title="Move" onclick="send('moveStock', {symbol: '\${s.symbol}', fromId: '\${wlId}'})">↗</button>
                <button class="btn-icon" title="Remove" onclick="send('removeStock', {watchlistId: '\${wlId}', symbol: '\${s.symbol}'})">✕</button>
              </div>
            </div>
            <div class="sc-metrics">
              <div class="sc-metric-row">
                <span class="sc-metric-label">⚙ Fundamentals</span>
                <div class="sc-bar-wrap">
                  <div class="sc-bar"><div class="sc-bar-fill \${sc}" style="width:\${barWidth}%"></div></div>
                  <span class="sc-score-num \${sc}">\${score}</span>
                </div>
                <span class="verdict \${verdictClass(s.verdict)}">\${vText.trim()}</span>
              </div>
              \${zone ? \`
              <div class="sc-metric-row">
                <span class="sc-metric-label">📈 Market</span>
                <span class="zone-pill \${getZoneClass(zone)}">\${zone}</span>
              </div>\` : ''}
            </div>
          </div>
        \`;
      }).join('');
    }

    function renderLists(results, allLists) {
      const container = document.getElementById('lists');
      _allResults = results;

      // Show watchlists that have no live data yet (newly created, empty)
      const renderedIds = new Set(results.map(r => r.list.id));
      const allToRender = [
        ...results,
        ...allLists
          .filter(l => !renderedIds.has(l.id))
          .map(l => ({ list: l, stocks: [] }))
      ];

      container.innerHTML = allToRender.map(({ list, stocks }) => {
        const collapsed = (getState().collapsed || {})[list.id] === true;
        const activeSort = getActiveSort(list.id);
        const sortChips = [
          { key: 'zone',  label: '📈 Zone' },
          { key: 'score', label: '⚙ Score' },
          { key: 'day',   label: 'Day %' },
          { key: 'az',    label: 'A–Z' },
        ].map(c => \`<button class="sort-chip\${activeSort === c.key ? ' active' : ''}" data-sort-key="\${c.key}" onclick="event.stopPropagation();setSort('\${list.id}','\${c.key}')">\${c.label}</button>\`).join('');

        return \`
          <div class="watchlist-section" data-list-id="\${list.id}">
            <div class="watchlist-header \${collapsed ? '' : 'open'}" onclick="toggleCollapse('\${list.id}', event)">
              <span class="watchlist-name">
                <span class="chevron \${collapsed ? '' : 'open'}">▶</span>
                \${list.name} <span style="font-weight:400;color:var(--fg2)">(\${list.stocks.length})</span>
              </span>
              <div class="watchlist-actions" onclick="event.stopPropagation()">
                <button class="btn-icon" title="Add stock" onclick="send('addStock', {watchlistId: '\${list.id}'})">＋</button>
                <button class="btn-icon" title="Rename" onclick="send('renameWatchlist', {id: '\${list.id}'})">✎</button>
                <button class="btn-icon" title="Delete" onclick="send('deleteWatchlist', {id: '\${list.id}'})">🗑</button>
              </div>
            </div>
            <div class="watchlist-body \${collapsed ? 'collapsed' : ''}">
              <div class="sort-chips" data-sort-list="\${list.id}">\${sortChips}</div>
              <div class="wl-stock-rows">\${buildStockRows(stocks, list.id, list.id)}</div>
              <div class="add-stock-row" onclick="send('addStock', {watchlistId: '\${list.id}'})">
                ＋ Add stock
              </div>
            </div>
          </div>
        \`;
      }).join('');

      document.getElementById('ts').textContent = 'Updated: ' + new Date().toLocaleTimeString();
    }

    window.addEventListener('message', ({ data }) => {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('empty').style.display = 'none';
      document.getElementById('content').style.display = 'none';

      if (data.type === 'loading') {
        document.getElementById('loading').style.display = 'block';
      } else if (data.type === 'empty') {
        document.getElementById('empty').style.display = 'block';
      } else if (data.type === 'data') {
        _zones = data.zones || {};
        document.getElementById('content').style.display = 'block';
        renderLists(data.results, data.allLists);
      }
    });

    // Tell extension we are ready
    send('ready');
  </script>
</body>
</html>`;
  }
}
