/**
 * Watchlist Service
 * Persists multiple named watchlists in VSCode globalState.
 */

import * as vscode from "vscode";

export interface WatchlistStock {
  symbol: string;
  name: string;
  sector: string;
  addedAt: number; // timestamp
}

export interface Watchlist {
  id: string;
  name: string;
  stocks: WatchlistStock[];
  createdAt: number;
}

const STORAGE_KEY = "portfolioAnalyzer.watchlists";

export class WatchlistService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getAll(): Watchlist[] {
    return this.context.globalState.get<Watchlist[]>(STORAGE_KEY) || [];
  }

  get(id: string): Watchlist | undefined {
    return this.getAll().find((w) => w.id === id);
  }

  async create(name: string): Promise<Watchlist> {
    const lists = this.getAll();
    const watchlist: Watchlist = {
      id: Date.now().toString(),
      name,
      stocks: [],
      createdAt: Date.now(),
    };
    lists.push(watchlist);
    await this.save(lists);
    return watchlist;
  }

  async rename(id: string, name: string): Promise<void> {
    const lists = this.getAll();
    const list = lists.find((w) => w.id === id);
    if (list) {
      list.name = name;
      await this.save(lists);
    }
  }

  async delete(id: string): Promise<void> {
    const lists = this.getAll().filter((w) => w.id !== id);
    await this.save(lists);
  }

  async addStock(watchlistId: string, stock: WatchlistStock): Promise<void> {
    const lists = this.getAll();
    const list = lists.find((w) => w.id === watchlistId);
    if (!list) return;
    if (list.stocks.some((s) => s.symbol === stock.symbol)) return; // already exists
    list.stocks.push(stock);
    await this.save(lists);
  }

  async removeStock(watchlistId: string, symbol: string): Promise<void> {
    const lists = this.getAll();
    const list = lists.find((w) => w.id === watchlistId);
    if (!list) return;
    list.stocks = list.stocks.filter((s) => s.symbol !== symbol);
    await this.save(lists);
  }

  async moveStock(
    symbol: string,
    fromId: string,
    toId: string,
  ): Promise<void> {
    const lists = this.getAll();
    const from = lists.find((w) => w.id === fromId);
    const to = lists.find((w) => w.id === toId);
    if (!from || !to) return;
    const stock = from.stocks.find((s) => s.symbol === symbol);
    if (!stock) return;
    from.stocks = from.stocks.filter((s) => s.symbol !== symbol);
    if (!to.stocks.some((s) => s.symbol === symbol)) {
      to.stocks.push(stock);
    }
    await this.save(lists);
  }

  private async save(lists: Watchlist[]): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, lists);
  }
}
