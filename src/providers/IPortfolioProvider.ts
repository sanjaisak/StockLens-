/**
 * Portfolio Provider Interface
 * All broker integrations must implement this interface
 */

export interface Holding {
  symbol: string;
  name?: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  securityId: string;
  isin?: string;
  exchange: string;
}

export interface MarketQuote {
  symbol: string;
  livePrice: number;
  dayChange: number;
  dayChangePct: number;
  dayHigh: number;
  dayLow: number;
  dayOpen: number;
  prevClose: number;
  high52w: number;
  low52w: number;
  volume: number;
}

export interface FundamentalData {
  // Valuation
  pe: number | null;
  pb: number | null;
  eps: number | null;
  indPE: number | null;
  marketCap: number | null;

  // Valuation Trend (historical)
  medianPE: number | null; // 5-year median P/E
  peChange: number | null; // % change from median (positive = expensive now)
  historicalPE: { year: string; pe: number }[]; // Historical P/E data for trend chart
  historicalPB: { year: string; pb: number }[]; // Historical P/B data for trend chart

  // Returns
  roe: number | null;
  roce: number | null;
  divYield: number | null;

  // Growth
  salesGrowth3Y: number | null;
  salesGrowth5Y: number | null;
  salesGrowthTTM: number | null;
  profitGrowth3Y: number | null;
  profitGrowth5Y: number | null;
  profitGrowthTTM: number | null;

  // Balance Sheet
  debtToEquity: number | null;
  bookValue: number | null;

  // Shareholding (current)
  promoterHolding: number | null;
  fiiHolding: number | null;
  diiHolding: number | null;
  publicHolding: number | null;

  // Shareholding Change (QoQ - positive means increase)
  promoterHoldingChange: number | null;
  fiiHoldingChange: number | null;
  diiHoldingChange: number | null;
  publicHoldingChange: number | null;

  // Risk
  beta: number | null;
  high52w: number | null;
  low52w: number | null;

  // Company Info
  name: string;
  sector: string;
  description: string | null;

  // Qualitative
  pros: string[];
  cons: string[];
}

export interface PortfolioSummary {
  totalInvested: number;
  currentValue: number;
  totalPnL: number;
  totalPnLPct: number;
  dayPnL: number;
  dayPnLPct: number;
}

export interface IPortfolioProvider {
  /** Provider identifier */
  readonly id: string;

  /** Display name */
  readonly name: string;

  /** Whether the provider is configured and ready */
  isConfigured(): boolean;

  /** Fetch user holdings */
  getHoldings(): Promise<Holding[]>;

  /** Get live market quotes for holdings */
  getQuotes(holdings: Holding[]): Promise<Map<string, MarketQuote>>;

  /** Get fundamental data for a stock */
  getFundamentals(symbol: string): Promise<FundamentalData | null>;
}
