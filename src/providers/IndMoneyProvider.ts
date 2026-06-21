/**
 * IndMoney (INDstocks) Provider
 * Broker-specific: holdings and live quotes via IndMoney API.
 * Fundamentals are inherited from BasePortfolioProvider.
 */

import * as vscode from "vscode";
import { Holding, MarketQuote } from "./IPortfolioProvider";
import { BasePortfolioProvider } from "./BasePortfolioProvider";

const INDMONEY_BASE = "https://api.indstocks.com";

export class IndMoneyProvider extends BasePortfolioProvider {
  readonly id = "indmoney";
  readonly name = "IndMoney";

  private getToken(): string {
    const config = vscode.workspace.getConfiguration("portfolioAnalyzer");
    return config.get<string>("indmoney.accessToken", "");
  }

  isConfigured(): boolean {
    return this.getToken().length > 0;
  }

  async getHoldings(): Promise<Holding[]> {
    const token = this.getToken();
    if (!token) {
      throw new Error("IndMoney access token not configured");
    }

    try {
      const response = await fetch(`${INDMONEY_BASE}/portfolio/holdings`, {
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
      });

      const data = (await response.json()) as any;

      if (data.status === "success" && data.data) {
        return data.data.map((h: any) => ({
          symbol: h.symbol,
          name: h.symbol,
          quantity: h.total_qty || 0,
          avgPrice: h.avg_price || 0,
          currentPrice: 0,
          securityId: h.security_id || "",
          isin: h.isin,
          exchange: "NSE",
        }));
      }

      return [];
    } catch (error) {
      console.error("Error fetching IndMoney holdings:", error);
      throw error;
    }
  }

  async getQuotes(holdings: Holding[]): Promise<Map<string, MarketQuote>> {
    const token = this.getToken();
    const quotes = new Map<string, MarketQuote>();
    const exchanges = ["NSE", "BSE"];

    await Promise.all(
      holdings.map(async (holding) => {
        for (const exchange of exchanges) {
          try {
            const scripCode = `${exchange}_${holding.securityId}`;
            const response = await fetch(
              `${INDMONEY_BASE}/market/quotes/full?scrip-codes=${scripCode}`,
              {
                headers: {
                  Authorization: token,
                  "Content-Type": "application/json",
                },
              },
            );
            const data = (await response.json()) as any;
            if (data.status === "success" && data.data?.[scripCode]) {
              const quote = data.data[scripCode];
              quotes.set(holding.symbol, {
                symbol: holding.symbol,
                livePrice: quote.live_price || 0,
                dayChange: quote.day_change || 0,
                dayChangePct: quote.day_change_percentage || 0,
                dayHigh: quote.day_high || 0,
                dayLow: quote.day_low || 0,
                dayOpen: quote.day_open || 0,
                prevClose: quote.prev_close || 0,
                high52w: quote["52week_high"] || 0,
                low52w: quote["52week_low"] || 0,
                volume: quote.volume || 0,
              });
              break;
            }
          } catch {
            // try next exchange
          }
        }
      }),
    );

    return quotes;
  }
}
