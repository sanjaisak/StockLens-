/**
 * Stock Search Service
 * Search for any Indian stock and analyze it
 */

import * as path from 'path';
import * as fs from 'fs';
import { FundamentalData, MarketQuote } from '../providers/IPortfolioProvider';
import { StockAnalysis, ScoreBreakdown, VERDICT_THRESHOLDS } from './AnalysisService';

const TICKERTAPE_BASE = 'https://api.tickertape.in';
const SCREENER_BASE = 'https://www.screener.in';

interface IndianStockInfo {
    symbol: string;
    name: string;
    series: string;
    isin: string;
    sector: string;
}

export interface SearchResult {
    symbol: string;
    name: string;
    sector: string;
    market: 'IN';
}

export class StockSearchService {
    private indianStocks: IndianStockInfo[] = [];
    private extensionPath: string;

    constructor(extensionPath?: string) {
        this.extensionPath = extensionPath || '';
        this.loadStocks();
    }

    private loadJsonFile(filename: string): any[] {
        const possiblePaths = [
            this.extensionPath ? path.join(this.extensionPath, 'out', filename) : '',
            this.extensionPath ? path.join(this.extensionPath, 'src', filename) : '',
            path.join(__dirname, '..', filename),
            path.join(__dirname, filename),
            path.join(__dirname, '..', '..', 'src', filename),
        ].filter(p => p);

        for (const jsonPath of possiblePaths) {
            if (fs.existsSync(jsonPath)) {
                try {
                    const data = fs.readFileSync(jsonPath, 'utf8');
                    const parsed = JSON.parse(data);
                    console.log(`Loaded ${parsed.length} entries from ${jsonPath}`);
                    return parsed;
                } catch (e) {
                    console.error(`Failed to parse ${jsonPath}:`, e);
                }
            }
        }
        console.error(`Could not find ${filename} in any location. Tried:`, possiblePaths);
        return [];
    }

    private loadStocks() {
        this.indianStocks = this.loadJsonFile('indian_stocks.json');
    }

    /**
     * Search stocks by symbol or name
     */
    searchStocks(query: string, limit: number = 20): SearchResult[] {
        if (!query || query.length < 1) return [];

        console.log(`Searching for: ${query}, IN: ${this.indianStocks.length}`);

        const lq = query.toLowerCase();

        const rank = (s: { symbol: string; name: string }): number => {
            if (s.symbol.toLowerCase() === lq) return 0;
            if (s.symbol.toLowerCase().startsWith(lq)) return 1;
            if (s.name.toLowerCase().startsWith(lq)) return 2;
            if (s.name.toLowerCase().includes(lq)) return 3;
            return 99;
        };

        return this.indianStocks
            .filter(s => rank(s) < 99)
            .sort((a, b) => rank(a) - rank(b))
            .map(s => ({ symbol: s.symbol, name: s.name, sector: s.sector, market: 'IN' as const }))
            .slice(0, limit);
    }

    /**
     * Get full analysis for a stock by symbol
     */
    async analyzeStock(symbol: string): Promise<StockAnalysis | null> {
        return this.analyzeIndianStock(symbol);
    }

    private async analyzeIndianStock(symbol: string): Promise<StockAnalysis | null> {
        try {
            const stockInfo = this.indianStocks.find(s =>
                s.symbol.toLowerCase() === symbol.toLowerCase()
            );

            const tickertapeData = await this.fetchTickertapeData(symbol);
            const screenerData = await this.fetchScreenerData(symbol);

            if (!tickertapeData && !screenerData) {
                throw new Error(`Could not fetch data for ${symbol}`);
            }

            const quote = await this.fetchQuote(symbol, tickertapeData?.sid);
            const fundamentals = this.buildFundamentals(tickertapeData, screenerData, symbol);
            const scores = this.calculateScores(fundamentals);
            const totalScore = this.calculateTotalScore(scores);

            const ref52wHigh = tickertapeData?.high52w || null;
            const rawQuotePrice = quote?.livePrice || 0;
            const priceIsSane = !ref52wHigh || (rawQuotePrice > 0 && rawQuotePrice <= ref52wHigh * 2);
            const currentPrice = (priceIsSane && rawQuotePrice > 0)
                ? rawQuotePrice
                : (screenerData?.screenerPrice || rawQuotePrice || 0);

            const verdictInfo = this.getVerdict(totalScore);

            return {
                symbol: symbol.toUpperCase(),
                name: stockInfo?.name || tickertapeData?.name || symbol,
                sector: fundamentals?.sector || stockInfo?.sector || 'Unknown',
                market: 'IN',
                currency: 'INR',

                quantity: 0,
                avgPrice: 0,
                currentPrice,
                investedValue: 0,
                currentValue: 0,
                profitLoss: 0,
                profitLossPct: 0,
                dayChange: quote?.dayChange || 0,
                dayChangePct: quote?.dayChangePct || 0,

                high52w: quote?.high52w || tickertapeData?.high52w || fundamentals?.high52w || 0,
                low52w: quote?.low52w || tickertapeData?.low52w || fundamentals?.low52w || 0,

                fundamentals,
                scores,
                totalScore,
                verdict: verdictInfo.verdict,
                verdictEmoji: verdictInfo.emoji,
                verdictDescription: verdictInfo.description,
            };
        } catch (error) {
            console.error(`Error analyzing Indian stock ${symbol}:`, error);
            return null;
        }
    }

    private async fetchTickertapeData(symbol: string): Promise<any> {
        try {
            // Search for the stock
            const searchResponse = await fetch(`${TICKERTAPE_BASE}/stocks/search?text=${symbol}`);
            const searchData = await searchResponse.json() as any;
            
            let sid = null;
            if (searchData.success && searchData.data) {
                const results: any[] = searchData.data.searchResults || searchData.data.stocks || [];
                if (results.length > 0) {
                    // Prefer the result whose ticker exactly matches the NSE symbol we searched
                    const symUpper = symbol.toUpperCase();
                    const exactMatch = results.find((r: any) => {
                        const ticker = (r.stock?.info?.ticker || r.info?.ticker || '').toUpperCase();
                        return ticker === symUpper;
                    });
                    if (!exactMatch) {
                        console.warn(`Tickertape: no exact ticker match for ${symbol}, top result: ${results[0].stock?.info?.ticker || results[0].sid}`);
                    }
                    sid = exactMatch ? exactMatch.sid : results[0].sid;
                }
            }
            
            if (!sid) return null;

            // Get stock info
            const infoResponse = await fetch(`${TICKERTAPE_BASE}/stocks/info/${sid}`);
            const infoData = await infoResponse.json() as any;
            
            if (infoData.success && infoData.data) {
                const info = infoData.data.info || {};
                const ratios = infoData.data.ratios || {};
                
                return {
                    sid,
                    name: info.name || symbol,
                    sector: info.sector || 'Unknown',
                    pe: ratios.pe || null,
                    pb: ratios.pb || ratios.pbr || null,
                    roe: ratios.roe || null,
                    beta: ratios.beta || null,
                    divYield: ratios.divYield || null,
                    marketCap: ratios.marketCap || ratios.mrktCapf || null,
                    eps: ratios.eps || null,
                    high52w: ratios['52wHigh'] || null,
                    low52w: ratios['52wLow'] || null,
                    indPE: ratios.indpe || null,
                    ltp: null  // do not use info.ltp — unreliable units; use fetchQuote instead
                };
            }
            
            return { sid };
        } catch (error) {
            console.error('Tickertape fetch error:', error);
            return null;
        }
    }

    private async fetchQuote(symbol: string, sid?: string): Promise<MarketQuote | null> {
        try {
            if (sid) {
                const response = await fetch(`${TICKERTAPE_BASE}/stocks/quotes/${sid}`);
                const data: any = await response.json();
                
                if (data.success && data.data) {
                    const q = data.data;
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
                        high52w: q['52wH'] || q['52whigh'] || q.high52w || 0,
                        low52w: q['52wL'] || q['52wlow'] || q.low52w || 0,
                        volume: q.volume || q.v || 0
                    };
                }
            }
            return null;
        } catch (error) {
            console.error('Quote fetch error:', error);
            return null;
        }
    }

    private async fetchScreenerData(symbol: string): Promise<any> {
        try {
            const response = await fetch(`${SCREENER_BASE}/company/${symbol}/`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            const html = await response.text();
            
            // Parse growth rates
            const salesGrowth = this.parseGrowthSection(html, 'Compounded Sales Growth');
            const profitGrowth = this.parseGrowthSection(html, 'Compounded Profit Growth');
            
            // Parse metrics
            const roce = this.parseMetric(html, 'ROCE');
            const bookValue = this.parseMetric(html, 'Book Value');
            const debtToEquity = this.parseMetric(html, 'Debt to equity');
            
            // Parse shareholding
            const shareholding = this.parseShareholding(html);
            
            // Parse current price from Screener page (reliable even when market is closed)
            const pricePatterns = [
                /class="[^"]*number[^"]*"[^>]*>\s*([\d,]+\.?\d*)\s*<\/span>/i,
                /#price[^>]*>\s*<span[^>]*>([\d,]+\.?\d*)/i,
                /id="[^"]*current[^"]*"[^>]*>([\d,]+\.?\d*)/i,
            ];
            let screenerPrice: number | null = null;
            for (const pat of pricePatterns) {
                const m = pat.exec(html);
                if (m) {
                    const val = Number.parseFloat(m[1].replace(/,/g, ''));
                    // Only accept values in a realistic Indian stock price range
                    if (val > 0.5 && val < 200000) { screenerPrice = val; break; }
                }
            }

            // Parse company description
            const descMatch = html.match(/<div[^>]+class="[^"]*company-profile[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)
                || html.match(/<section[^>]+id="about"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
            const description = descMatch
                ? descMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
                : null;

            // Parse pros/cons
            const proscons = this.parseProsAndCons(html);

            return {
                salesGrowth3Y: salesGrowth['3 Years'] || null,
                salesGrowth5Y: salesGrowth['5 Years'] || null,
                salesGrowthTTM: salesGrowth['TTM'] || null,
                profitGrowth3Y: profitGrowth['3 Years'] || null,
                profitGrowth5Y: profitGrowth['5 Years'] || null,
                profitGrowthTTM: profitGrowth['TTM'] || null,
                roce,
                bookValue,
                debtToEquity,
                promoterHolding: shareholding.promoter,
                fiiHolding: shareholding.fii,
                diiHolding: shareholding.dii,
                publicHolding: shareholding.public,
                promoterHoldingChange: shareholding.promoterChange,
                fiiHoldingChange: shareholding.fiiChange,
                diiHoldingChange: shareholding.diiChange,
                publicHoldingChange: shareholding.publicChange,
                description,
                screenerPrice,
                pros: proscons.pros,
                cons: proscons.cons
            };
        } catch (error) {
            console.error('Screener fetch error:', error);
            return null;
        }
    }

    private parseGrowthSection(html: string, sectionName: string): Record<string, number> {
        const result: Record<string, number> = {};
        const regex = new RegExp(`${sectionName}[\\s\\S]*?<\\/table>`, 'i');
        const match = html.match(regex);
        
        if (match) {
            const section = match[0];
            const rows = section.match(/<tr>[\s\S]*?<\/tr>/gi) || [];
            
            for (const row of rows) {
                const yearMatch = row.match(/<td>(\d+ Years?|TTM):?<\/td>\s*<td>([^<]*)<\/td>/i);
                if (yearMatch) {
                    const period = yearMatch[1].replace(':', '');
                    const value = parseFloat(yearMatch[2].replace('%', ''));
                    if (!isNaN(value)) {
                        result[period] = value;
                    }
                }
            }
        }
        
        return result;
    }

    private parseMetric(html: string, metricName: string): number | null {
        const regex = new RegExp(`${metricName}[^<]*<[^>]*>[^<]*<[^>]*>([\\d.]+)`, 'i');
        const match = html.match(regex);
        if (match) {
            const value = parseFloat(match[1]);
            return isNaN(value) ? null : value;
        }
        return null;
    }

    private parseShareholding(html: string): Record<string, number | null> {
        const result: Record<string, number | null> = {
            promoter: null,
            fii: null,
            dii: null,
            public: null,
            promoterChange: null,
            fiiChange: null,
            diiChange: null,
            publicChange: null
        };

        const section = html.match(/Shareholding Pattern[\s\S]*?<\/section>/i);
        if (section) {
            const promoterMatch = section[0].match(/Promoters[^\d]*([\d.]+)%/i);
            const fiiMatch = section[0].match(/FIIs[^\d]*([\d.]+)%/i);
            const diiMatch = section[0].match(/DIIs[^\d]*([\d.]+)%/i);
            const publicMatch = section[0].match(/Public[^\d]*([\d.]+)%/i);
            
            if (promoterMatch) result.promoter = parseFloat(promoterMatch[1]);
            if (fiiMatch) result.fii = parseFloat(fiiMatch[1]);
            if (diiMatch) result.dii = parseFloat(diiMatch[1]);
            if (publicMatch) result.public = parseFloat(publicMatch[1]);
        }
        
        return result;
    }

    private parseProsAndCons(html: string): { pros: string[]; cons: string[] } {
        const result = { pros: [] as string[], cons: [] as string[] };
        
        const prosMatch = html.match(/<section[^>]*class="[^"]*pros[^"]*"[^>]*>[\s\S]*?<ul>([\s\S]*?)<\/ul>/i);
        if (prosMatch) {
            const prosItems = prosMatch[1].match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
            result.pros = prosItems
                .map(item => item.replace(/<[^>]*>/g, '').trim())
                .filter(p => p.length > 0)
                .slice(0, 5);
        }
        
        const consMatch = html.match(/<section[^>]*class="[^"]*cons[^"]*"[^>]*>[\s\S]*?<ul>([\s\S]*?)<\/ul>/i);
        if (consMatch) {
            const consItems = consMatch[1].match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
            result.cons = consItems
                .map(item => item.replace(/<[^>]*>/g, '').trim())
                .filter(c => c.length > 0)
                .slice(0, 5);
        }
        
        return result;
    }

    private buildFundamentals(tickertape: any, screener: any, symbol: string): FundamentalData {
        return {
            pe: tickertape?.pe || null,
            pb: tickertape?.pb || null,
            eps: tickertape?.eps || null,
            indPE: tickertape?.indPE || null,
            marketCap: tickertape?.marketCap || null,
            
            medianPE: null,
            peChange: null,
            historicalPE: [],
            historicalPB: [],
            
            roe: tickertape?.roe || null,
            roce: screener?.roce || null,
            divYield: tickertape?.divYield || null,
            
            salesGrowth3Y: screener?.salesGrowth3Y || null,
            salesGrowth5Y: screener?.salesGrowth5Y || null,
            salesGrowthTTM: screener?.salesGrowthTTM || null,
            profitGrowth3Y: screener?.profitGrowth3Y || null,
            profitGrowth5Y: screener?.profitGrowth5Y || null,
            profitGrowthTTM: screener?.profitGrowthTTM || null,
            
            debtToEquity: screener?.debtToEquity || null,
            bookValue: screener?.bookValue || null,
            
            promoterHolding: screener?.promoterHolding || null,
            fiiHolding: screener?.fiiHolding || null,
            diiHolding: screener?.diiHolding || null,
            publicHolding: screener?.publicHolding || null,
            
            promoterHoldingChange: screener?.promoterHoldingChange || null,
            fiiHoldingChange: screener?.fiiHoldingChange || null,
            diiHoldingChange: screener?.diiHoldingChange || null,
            publicHoldingChange: screener?.publicHoldingChange || null,
            
            beta: tickertape?.beta || null,
            high52w: tickertape?.high52w || null,
            low52w: tickertape?.low52w || null,

            name: tickertape?.name || symbol,
            sector: tickertape?.sector || 'Unknown',
            description: screener?.description || null,

            pros: screener?.pros || [],
            cons: screener?.cons || []
        };
    }

    private calculateScores(f: FundamentalData | null): ScoreBreakdown {
        if (!f) {
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

        // Revenue Growth Score (based on 3Y and 5Y CAGR)
        let revenueScore = 5;
        const avgSalesGrowth = ((f.salesGrowth3Y || 0) + (f.salesGrowth5Y || 0)) / 2;
        if (avgSalesGrowth >= 20) revenueScore = 10;
        else if (avgSalesGrowth >= 15) revenueScore = 8;
        else if (avgSalesGrowth >= 10) revenueScore = 7;
        else if (avgSalesGrowth >= 5) revenueScore = 6;
        else if (avgSalesGrowth >= 0) revenueScore = 5;
        else revenueScore = 3;

        // Profit Growth Score
        let profitScore = 5;
        const avgProfitGrowth = ((f.profitGrowth3Y || 0) + (f.profitGrowth5Y || 0)) / 2;
        if (avgProfitGrowth >= 25) profitScore = 10;
        else if (avgProfitGrowth >= 18) profitScore = 8;
        else if (avgProfitGrowth >= 12) profitScore = 7;
        else if (avgProfitGrowth >= 5) profitScore = 6;
        else if (avgProfitGrowth >= 0) profitScore = 5;
        else profitScore = 3;

        // Balance Sheet Score (D/E ratio)
        let balanceScore = 5;
        const de = f.debtToEquity;
        if (de !== null) {
            if (de <= 0.1) balanceScore = 10;
            else if (de <= 0.3) balanceScore = 8;
            else if (de <= 0.5) balanceScore = 7;
            else if (de <= 1) balanceScore = 6;
            else if (de <= 2) balanceScore = 4;
            else balanceScore = 2;
        }

        // Cash Flow Score (using profit consistency as proxy)
        let cashFlowScore = 5;
        if (f.profitGrowthTTM !== null && f.profitGrowth3Y !== null) {
            const consistency = Math.abs(f.profitGrowthTTM - f.profitGrowth3Y);
            if (consistency < 5) cashFlowScore = 8;
            else if (consistency < 10) cashFlowScore = 7;
            else if (consistency < 20) cashFlowScore = 5;
            else cashFlowScore = 4;
        }

        // Management Score (promoter holding)
        let managementScore = 5;
        const promoter = f.promoterHolding;
        if (promoter !== null) {
            if (promoter >= 70) managementScore = 10;
            else if (promoter >= 55) managementScore = 8;
            else if (promoter >= 45) managementScore = 7;
            else if (promoter >= 30) managementScore = 5;
            else managementScore = 4;
        }

        // Industry Score (placeholder - would need sector data)
        const industryScore = 6;

        // Moat Score (ROCE + ROE average)
        let moatScore = 5;
        const avgReturn = ((f.roce || 0) + (f.roe || 0)) / 2;
        if (avgReturn >= 25) moatScore = 10;
        else if (avgReturn >= 20) moatScore = 8;
        else if (avgReturn >= 15) moatScore = 7;
        else if (avgReturn >= 10) moatScore = 5;
        else moatScore = 4;

        // Valuation Score (PE vs Industry PE)
        let valuationScore = 5;
        if (f.pe !== null && f.indPE !== null && f.indPE > 0) {
            const peRatio = f.pe / f.indPE;
            if (peRatio < 0.6) valuationScore = 10;
            else if (peRatio < 0.8) valuationScore = 8;
            else if (peRatio < 1) valuationScore = 7;
            else if (peRatio < 1.2) valuationScore = 6;
            else if (peRatio < 1.5) valuationScore = 4;
            else valuationScore = 3;
        }

        // Capital Allocation Score (ROE + Div Yield)
        let capitalScore = 5;
        const roe = f.roe || 0;
        const divYield = f.divYield || 0;
        if (roe >= 20 && divYield >= 1) capitalScore = 9;
        else if (roe >= 15) capitalScore = 7;
        else if (roe >= 10) capitalScore = 6;
        else capitalScore = 5;

        // Risk Score (Beta)
        let riskScore = 5;
        if (f.beta !== null) {
            if (f.beta < 0.7) riskScore = 9;
            else if (f.beta < 0.9) riskScore = 8;
            else if (f.beta < 1.1) riskScore = 7;
            else if (f.beta < 1.3) riskScore = 5;
            else riskScore = 3;
        }

        return {
            revenueGrowth: revenueScore,
            profitGrowth: profitScore,
            balanceSheet: balanceScore,
            cashFlow: cashFlowScore,
            management: managementScore,
            industry: industryScore,
            moat: moatScore,
            valuation: valuationScore,
            capitalAllocation: capitalScore,
            risk: riskScore
        };
    }

    private calculateTotalScore(scores: ScoreBreakdown): number {
        const weights = {
            revenueGrowth: 0.15,
            profitGrowth: 0.15,
            balanceSheet: 0.10,
            cashFlow: 0.10,
            management: 0.10,
            industry: 0.10,
            moat: 0.10,
            valuation: 0.10,
            capitalAllocation: 0.05,
            risk: 0.05
        };

        let total = 0;
        for (const [key, weight] of Object.entries(weights)) {
            total += scores[key as keyof ScoreBreakdown] * weight;
        }
        
        return Math.round(total * 10) / 10;
    }

    private getVerdict(score: number): { verdict: string; emoji: string; description: string } {
        for (const threshold of VERDICT_THRESHOLDS) {
            if (score >= threshold.minScore) { return threshold; }
        }
        return VERDICT_THRESHOLDS[VERDICT_THRESHOLDS.length - 1];
    }
}
