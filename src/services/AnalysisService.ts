/**
 * Analysis Service
 * Calculates scores and verdicts for stocks
 */

import { FundamentalData, Holding, MarketQuote } from '../providers/IPortfolioProvider';

export interface ScoreBreakdown {
    revenueGrowth: number;
    profitGrowth: number;
    balanceSheet: number;
    cashFlow: number;
    management: number;
    industry: number;
    moat: number;
    valuation: number;
    capitalAllocation: number;
    risk: number;
}

export interface StockAnalysis {
    symbol: string;
    name: string;
    sector: string;
    market: 'IN';
    currency: 'INR';

    // Position
    quantity: number;
    avgPrice: number;
    currentPrice: number;
    investedValue: number;
    currentValue: number;
    profitLoss: number;
    profitLossPct: number;
    dayChange: number;
    dayChangePct: number;
    
    // 52-week range
    high52w: number;
    low52w: number;
    
    // Fundamentals
    fundamentals: FundamentalData | null;
    
    // Scores
    scores: ScoreBreakdown;
    totalScore: number;
    verdict: string;
    verdictEmoji: string;
    verdictDescription: string;

    // Fair value (medianPE × EPS), null if data unavailable
}

export interface PortfolioAnalysis {
    stocks: StockAnalysis[];
    summary: {
        totalInvested: number;
        currentValue: number;
        totalPnL: number;
        totalPnLPct: number;
        dayPnL: number;
        dayPnLPct: number;
        avgScore: number;
    };
}

export const SCORING_WEIGHTS = {
    revenueGrowth: { weight: 0.15, name: 'Revenue Growth', description: '3Y & 5Y Sales CAGR' },
    profitGrowth: { weight: 0.15, name: 'Profit Growth', description: '3Y & 5Y Profit CAGR' },
    balanceSheet: { weight: 0.10, name: 'Balance Sheet', description: 'Debt/Equity ratio' },
    cashFlow: { weight: 0.10, name: 'Cash Flow', description: 'Profit consistency' },
    management: { weight: 0.10, name: 'Management', description: 'Promoter holding %' },
    industry: { weight: 0.10, name: 'Industry Tailwind', description: 'Sector growth potential' },
    moat: { weight: 0.10, name: 'Competitive Moat', description: 'ROCE + ROE average' },
    valuation: { weight: 0.10, name: 'Valuation', description: 'PE vs Industry, P/B' },
    capitalAllocation: { weight: 0.05, name: 'Capital Allocation', description: 'ROE + Div yield' },
    risk: { weight: 0.05, name: 'Risk Level', description: 'Beta (volatility)' }
};

export const VERDICT_THRESHOLDS = [
    { minScore: 8.0, verdict: 'STRONG BUY', emoji: '🚀', description: 'Exceptional fundamentals' },
    { minScore: 7.0, verdict: 'BUY', emoji: '📈', description: 'Good quality, favorable outlook' },
    { minScore: 6.0, verdict: 'HOLD', emoji: '📊', description: 'Average, monitor closely' },
    { minScore: 5.0, verdict: 'WEAK HOLD', emoji: '⚠️', description: 'Concerns exist, consider reducing' },
    { minScore: 0.0, verdict: 'SELL', emoji: '📉', description: 'Poor fundamentals, exit recommended' }
];


export class AnalysisService {
    analyzeStock(
        holding: Holding,
        quote: MarketQuote | undefined,
        fundamentals: FundamentalData | null
    ): StockAnalysis {
        const currentPrice = quote?.livePrice || holding.currentPrice || 0;
        const investedValue = holding.quantity * holding.avgPrice;
        const currentValue = holding.quantity * currentPrice;
        const profitLoss = currentValue - investedValue;
        const profitLossPct = investedValue > 0 ? ((currentValue - investedValue) / investedValue) * 100 : 0;

        const scores = this.calculateScores(fundamentals);
        const totalScore = this.calculateTotalScore(scores);

        const verdictInfo = this.getVerdict(totalScore);

        return {
            symbol: holding.symbol,
            name: fundamentals?.name || holding.name || holding.symbol,
            sector: fundamentals?.sector || 'Unknown',
            market: 'IN',
            currency: 'INR',

            quantity: holding.quantity,
            avgPrice: holding.avgPrice,
            currentPrice,
            investedValue,
            currentValue,
            profitLoss,
            profitLossPct,
            dayChange: quote?.dayChange || 0,
            dayChangePct: quote?.dayChangePct || 0,

            high52w: quote?.high52w || fundamentals?.high52w || 0,
            low52w: quote?.low52w || fundamentals?.low52w || 0,

            fundamentals,
            scores,
            totalScore,
            verdict: verdictInfo.verdict,
            verdictEmoji: verdictInfo.emoji,
            verdictDescription: verdictInfo.description,
        };
    }

    analyzePortfolio(stocks: StockAnalysis[]): PortfolioAnalysis {
        const totalInvested = stocks.reduce((sum, s) => sum + s.investedValue, 0);
        const currentValue = stocks.reduce((sum, s) => sum + s.currentValue, 0);
        const totalPnL = currentValue - totalInvested;
        const totalPnLPct = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;
        
        const dayPnL = stocks.reduce((sum, s) => sum + (s.dayChange * s.quantity), 0);
        const dayPnLPct = currentValue > 0 ? (dayPnL / (currentValue - dayPnL)) * 100 : 0;
        
        const avgScore = stocks.length > 0
            ? stocks.reduce((sum, s) => sum + s.totalScore, 0) / stocks.length
            : 0;

        return {
            stocks: stocks.sort((a, b) => b.totalScore - a.totalScore),
            summary: {
                totalInvested,
                currentValue,
                totalPnL,
                totalPnLPct,
                dayPnL,
                dayPnLPct,
                avgScore
            }
        };
    }

    private calculateScores(data: FundamentalData | null): ScoreBreakdown {
        if (!data) {
            return {
                revenueGrowth: 5,
                profitGrowth: 5,
                balanceSheet: 5,
                cashFlow: 5,
                management: 5,
                industry: 5,
                moat: 5,
                valuation: 5,
                capitalAllocation: 5,
                risk: 5
            };
        }

        return {
            revenueGrowth: this.scoreGrowth(data.salesGrowth3Y, data.salesGrowth5Y),
            profitGrowth: this.scoreGrowth(data.profitGrowth3Y, data.profitGrowth5Y),
            balanceSheet: this.scoreBalanceSheet(data.debtToEquity, data.bookValue),
            cashFlow: this.scoreCashFlow(data.profitGrowthTTM, data.profitGrowth3Y),
            management: this.scoreManagement(data.promoterHolding),
            industry: this.scoreIndustry(data.sector),
            moat: this.scoreMoat(data.roce, data.roe),
            valuation: this.scoreValuation(data.pe, data.indPE, data.pb),
            capitalAllocation: this.scoreCapitalAllocation(data.roe, data.divYield),
            risk: this.scoreRisk(data.beta)
        };
    }

    private calculateTotalScore(scores: ScoreBreakdown): number {
        let total = 0;
        for (const [key, info] of Object.entries(SCORING_WEIGHTS)) {
            const score = scores[key as keyof ScoreBreakdown] || 5;
            total += score * info.weight;
        }
        return Math.round(total * 10) / 10;
    }

    private getVerdict(score: number): { verdict: string; emoji: string; description: string } {
        for (const threshold of VERDICT_THRESHOLDS) {
            if (score >= threshold.minScore) {
                return threshold;
            }
        }
        return VERDICT_THRESHOLDS[VERDICT_THRESHOLDS.length - 1];
    }

    private scoreGrowth(growth3Y: number | null, growth5Y: number | null): number {
        const avg = ((growth3Y || 0) + (growth5Y || 0)) / 2;
        if (avg >= 25) return 10;
        if (avg >= 20) return 9;
        if (avg >= 15) return 8;
        if (avg >= 10) return 7;
        if (avg >= 5) return 6;
        if (avg >= 0) return 5;
        if (avg >= -5) return 4;
        return 3;
    }

    private scoreBalanceSheet(debtToEquity: number | null, bookValue: number | null): number {
        let score = 5;
        if (debtToEquity !== null) {
            if (debtToEquity <= 0.3) score += 3;
            else if (debtToEquity <= 0.5) score += 2;
            else if (debtToEquity <= 1) score += 1;
            else if (debtToEquity > 2) score -= 2;
        }
        if (bookValue && bookValue > 0) score += 1;
        return Math.min(10, Math.max(1, score));
    }

    private scoreCashFlow(growthTTM: number | null, growth3Y: number | null): number {
        if (growthTTM === null || growth3Y === null) return 5;
        const consistency = Math.abs(growthTTM - growth3Y);
        if (consistency < 5 && growthTTM > 10) return 9;
        if (consistency < 10 && growthTTM > 5) return 7;
        if (growthTTM > 0) return 6;
        return 4;
    }

    private scoreManagement(promoterHolding: number | null): number {
        if (promoterHolding === null) return 5;
        if (promoterHolding >= 70) return 10;
        if (promoterHolding >= 60) return 9;
        if (promoterHolding >= 50) return 8;
        if (promoterHolding >= 40) return 7;
        if (promoterHolding >= 30) return 6;
        return 5;
    }

    private scoreIndustry(sector: string): number {
        const highGrowthSectors = ['Software Services', 'Pharmaceuticals', 'Diversified Financials', 'Utilities', 'Water Management'];
        const moderateSectors = ['Banking', 'Consumer Goods', 'Healthcare'];
        
        if (highGrowthSectors.some(s => sector?.includes(s))) return 8;
        if (moderateSectors.some(s => sector?.includes(s))) return 7;
        return 6;
    }

    private scoreMoat(roce: number | null, roe: number | null): number {
        const avgReturn = ((roce || 0) + (roe || 0)) / 2;
        if (avgReturn >= 25) return 10;
        if (avgReturn >= 20) return 9;
        if (avgReturn >= 15) return 8;
        if (avgReturn >= 12) return 7;
        if (avgReturn >= 10) return 6;
        return 5;
    }

    private scoreValuation(pe: number | null, indPE: number | null, pb: number | null): number {
        let score = 5;
        if (pe !== null && indPE !== null) {
            const peRatio = pe / indPE;
            if (peRatio < 0.7) score += 2;
            else if (peRatio < 0.9) score += 1;
            else if (peRatio > 1.3) score -= 1;
            else if (peRatio > 1.5) score -= 2;
        }
        if (pb !== null) {
            if (pb < 2) score += 2;
            else if (pb < 3) score += 1;
            else if (pb > 5) score -= 1;
        }
        return Math.min(10, Math.max(1, score));
    }

    private scoreCapitalAllocation(roe: number | null, divYield: number | null): number {
        let score = 5;
        if (roe !== null) {
            if (roe >= 20) score += 2;
            else if (roe >= 15) score += 1;
        }
        if (divYield !== null && divYield > 0) {
            if (divYield >= 2) score += 2;
            else if (divYield >= 1) score += 1;
        }
        return Math.min(10, Math.max(1, score));
    }

    private scoreRisk(beta: number | null): number {
        if (beta === null) return 5;
        if (beta <= 0.7) return 9;
        if (beta <= 1.0) return 8;
        if (beta <= 1.2) return 7;
        if (beta <= 1.5) return 6;
        return 4;
    }
}
