/**
 * Manual Holdings Provider
 * Lets users enter holdings manually. Persisted in globalState.
 * Live prices auto-fetched via Tickertape (same as other providers).
 */

import * as vscode from "vscode";
import { BasePortfolioProvider } from "./BasePortfolioProvider";
import { Holding, MarketQuote } from "./IPortfolioProvider";
import fetch from "node-fetch";

export interface ManualHolding {
  symbol: string;
  name: string;
  quantity: number;
  avgPrice: number;
  exchange: string;
}

const STORAGE_KEY = "manualHoldings";
const TICKERTAPE_BASE = "https://api.tickertape.in";

export class ManualHoldingsProvider extends BasePortfolioProvider {
  readonly id = "manual";
  readonly name = "Manual Holdings";

  constructor(private readonly context: vscode.ExtensionContext) {
    super();
  }

  isConfigured(): boolean {
    return true; // always available — no credentials needed
  }

  getStoredHoldings(): ManualHolding[] {
    return this.context.globalState.get<ManualHolding[]>(STORAGE_KEY) || [];
  }

  async saveHoldings(holdings: ManualHolding[]): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, holdings);
  }

  async addOrUpdateHolding(h: ManualHolding): Promise<void> {
    const list = this.getStoredHoldings();
    const idx = list.findIndex(x => x.symbol.toUpperCase() === h.symbol.toUpperCase());
    if (idx >= 0) {
      list[idx] = h;
    } else {
      list.push(h);
    }
    await this.saveHoldings(list);
  }

  async deleteHolding(symbol: string): Promise<void> {
    const list = this.getStoredHoldings().filter(
      x => x.symbol.toUpperCase() !== symbol.toUpperCase()
    );
    await this.saveHoldings(list);
  }

  async getHoldings(): Promise<Holding[]> {
    const stored = this.getStoredHoldings();
    return stored.map(h => ({
      symbol: h.symbol,
      name: h.name,
      quantity: h.quantity,
      avgPrice: h.avgPrice,
      currentPrice: 0, // will be filled by getQuotes
      securityId: h.symbol,
      exchange: h.exchange || "NSE",
    }));
  }

  async addOrUpdateMultipleHoldings(holdings: ManualHolding[]): Promise<void> {
    const list = this.getStoredHoldings();
    for (const h of holdings) {
      const idx = list.findIndex(x => x.symbol.toUpperCase() === h.symbol.toUpperCase());
      if (idx >= 0) {
        list[idx] = h;
      } else {
        list.push(h);
      }
    }
    await this.saveHoldings(list);
  }

  async getQuotes(holdings: Holding[]): Promise<Map<string, MarketQuote>> {
    const result = new Map<string, MarketQuote>();
    await Promise.all(
      holdings.map(async h => {
        try {
          const quote = await this._fetchTickertapeQuote(h.symbol);
          if (quote) result.set(h.symbol, quote);
        } catch {
          // skip failed quotes
        }
      })
    );
    return result;
  }

  private async _fetchTickertapeQuote(symbol: string): Promise<MarketQuote | null> {
    try {
      const searchRes = await fetch(`${TICKERTAPE_BASE}/stocks/search?text=${symbol}`);
      const searchData = (await searchRes.json()) as any;

      let sid: string | null = null;
      if (searchData.success && searchData.data) {
        const results: any[] = searchData.data.searchResults || searchData.data.stocks || [];
        const symUpper = symbol.toUpperCase();
        const exact = results.find((r: any) =>
          (r.stock?.info?.ticker || r.info?.ticker || "").toUpperCase() === symUpper
        );
        sid = exact ? exact.sid : results[0]?.sid || null;
      }
      if (!sid) return null;

      const qRes = await fetch(`${TICKERTAPE_BASE}/stocks/quotes/${sid}`);
      const qData = (await qRes.json()) as any;
      if (!qData.success || !qData.data) return null;

      const q = qData.data;
      const dayChange = q.change || q.ch || 0;
      const prevClose = q.close || q.pc || q.prevClose || 0;
      const dayChangePct = q.changePct || q.chp ||
        (prevClose > 0 ? (dayChange / prevClose) * 100 : 0);

      return {
        symbol,
        livePrice: q.price || q.lp || q.ltp || prevClose || 0,
        dayChange,
        dayChangePct,
        dayHigh: q.high || q.h || 0,
        dayLow: q.low || q.l || 0,
        dayOpen: q.open || q.o || 0,
        prevClose,
        high52w: q["52wH"] || q["52whigh"] || q.high52w || 0,
        low52w: q["52wL"] || q["52wlow"] || q.low52w || 0,
        volume: q.volume || q.v || 0,
      };
    } catch {
      return null;
    }
  }
}
