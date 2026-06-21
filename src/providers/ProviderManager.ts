/**
 * Provider Manager
 * Factory and registry for all broker providers.
 * To add a new provider: implement BasePortfolioProvider, then add a case below.
 */

import * as vscode from "vscode";
import {
  IPortfolioProvider,
  Holding,
  MarketQuote,
  FundamentalData,
} from "./IPortfolioProvider";
import { IndMoneyProvider } from "./IndMoneyProvider";
import { ManualHoldingsProvider } from "./ManualHoldingsProvider";

export class ProviderManager {
  private readonly providers: Map<string, IPortfolioProvider> = new Map();
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.registerProviders();
  }

  /** Factory: create a provider by id. Add new providers here. */
  create(id: string): IPortfolioProvider {
    if (id === "indmoney") return new IndMoneyProvider();
    if (id === "manual") return new ManualHoldingsProvider(this.context);
    throw new Error(`Unknown provider id: "${id}"`);
  }

  private registerProviders(): void {
    const providerIds = ["indmoney", "manual"];
    for (const id of providerIds) {
      const provider = this.create(id);
      this.providers.set(provider.id, provider);
    }
  }

  getManualProvider(): ManualHoldingsProvider {
    return this.providers.get("manual") as ManualHoldingsProvider;
  }

  getActiveProvider(): IPortfolioProvider | undefined {
    const config = vscode.workspace.getConfiguration("portfolioAnalyzer");
    const activeId = config.get<string>("activeProvider", "indmoney");
    return this.providers.get(activeId);
  }

  getAvailableProviders(): { id: string; name: string; configured: boolean }[] {
    return Array.from(this.providers.entries()).map(([id, provider]) => ({
      id,
      name: provider.name,
      configured: provider.isConfigured(),
    }));
  }

  async getHoldings(): Promise<Holding[]> {
    const provider = this.getActiveProvider();
    if (!provider) {
      throw new Error("No active provider configured");
    }
    if (!provider.isConfigured()) {
      throw new Error(
        `${provider.name} is not configured. Please set up your credentials.`,
      );
    }
    return provider.getHoldings();
  }

  async getQuotes(holdings: Holding[]): Promise<Map<string, MarketQuote>> {
    const provider = this.getActiveProvider();
    if (!provider) {
      return new Map();
    }
    return provider.getQuotes(holdings);
  }

  async getFundamentals(symbol: string): Promise<FundamentalData | null> {
    const provider = this.getActiveProvider();
    if (!provider) {
      return null;
    }
    return provider.getFundamentals(symbol);
  }
}
