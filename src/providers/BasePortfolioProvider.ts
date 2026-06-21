/**
 * Base Portfolio Provider
 * Shared market data logic (Tickertape + Screener) for all broker integrations.
 * Subclasses only need to implement getHoldings() and getQuotes().
 */

import {
  IPortfolioProvider,
  Holding,
  MarketQuote,
  FundamentalData,
} from "./IPortfolioProvider";

const TICKERTAPE_BASE = "https://api.tickertape.in";
const SCREENER_BASE = "https://www.screener.in";

export abstract class BasePortfolioProvider implements IPortfolioProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract isConfigured(): boolean;
  abstract getHoldings(): Promise<Holding[]>;
  abstract getQuotes(holdings: Holding[]): Promise<Map<string, MarketQuote>>;

  async getFundamentals(symbol: string): Promise<FundamentalData | null> {
    try {
      const tickertapeData = await this.fetchTickertapeData(symbol);
      const screenerData = await this.fetchScreenerData(symbol);

      let historicalPE = tickertapeData?.historicalPE || [];
      let historicalPB = tickertapeData?.historicalPB || [];
      let medianPE = tickertapeData?.medianPE || null;
      let peChange = tickertapeData?.peChange || null;

      if (historicalPE.length < 2 && screenerData?.historicalPE?.length > 0) {
        historicalPE = screenerData.historicalPE;
      }

      const currentPE = tickertapeData?.pe;
      if (historicalPE.length > 0 && !medianPE) {
        const peValues = historicalPE
          .map((h: { year: string; pe: number }) => h.pe)
          .sort((a: number, b: number) => a - b);
        const mid = Math.floor(peValues.length / 2);
        medianPE =
          peValues.length % 2 !== 0
            ? peValues[mid]
            : (peValues[mid - 1] + peValues[mid]) / 2;

        if (currentPE && medianPE) {
          peChange = (currentPE / medianPE - 1) * 100;
        }
      }

      return {
        pe: tickertapeData?.pe || null,
        pb: tickertapeData?.pb || null,
        eps: tickertapeData?.eps || null,
        indPE: tickertapeData?.indPE || null,
        marketCap: tickertapeData?.marketCap || null,

        medianPE,
        peChange,
        historicalPE,
        historicalPB,

        roe: tickertapeData?.roe || null,
        roce: screenerData?.roce || null,
        divYield: tickertapeData?.divYield || null,

        salesGrowth3Y: screenerData?.salesGrowth3Y || null,
        salesGrowth5Y: screenerData?.salesGrowth5Y || null,
        salesGrowthTTM: screenerData?.salesGrowthTTM || null,
        profitGrowth3Y: screenerData?.profitGrowth3Y || null,
        profitGrowth5Y: screenerData?.profitGrowth5Y || null,
        profitGrowthTTM: screenerData?.profitGrowthTTM || null,

        debtToEquity: screenerData?.debtToEquity || null,
        bookValue: screenerData?.bookValue || null,

        promoterHolding: screenerData?.promoterHolding || null,
        fiiHolding: screenerData?.fiiHolding || null,
        diiHolding: screenerData?.diiHolding || null,
        publicHolding: screenerData?.publicHolding || null,

        promoterHoldingChange: screenerData?.promoterHoldingChange || null,
        fiiHoldingChange: screenerData?.fiiHoldingChange || null,
        diiHoldingChange: screenerData?.diiHoldingChange || null,
        publicHoldingChange: screenerData?.publicHoldingChange || null,

        beta: tickertapeData?.beta || null,
        high52w: tickertapeData?.high52w || null,
        low52w: tickertapeData?.low52w || null,

        name: tickertapeData?.name || symbol,
        sector: tickertapeData?.sector || "Unknown",
        description: screenerData?.description || null,

        pros: screenerData?.pros || [],
        cons: screenerData?.cons || [],
      };
    } catch (error) {
      console.error(`Error fetching fundamentals for ${symbol}:`, error);
      return null;
    }
  }

  protected async fetchTickertapeData(symbol: string): Promise<any> {
    try {
      const searchResponse = await fetch(
        `${TICKERTAPE_BASE}/stocks/search?text=${symbol}`,
      );
      const searchData = (await searchResponse.json()) as any;

      let sid = null;
      if (searchData.success && searchData.data) {
        const results: any[] =
          searchData.data.searchResults || searchData.data.stocks || [];
        if (results.length > 0) {
          const symUpper = symbol.toUpperCase();
          const exactMatch = results.find((r: any) => {
            const ticker = (
              r.stock?.info?.ticker ||
              r.info?.ticker ||
              ""
            ).toUpperCase();
            return ticker === symUpper;
          });
          if (!exactMatch) {
            console.warn(
              `Tickertape: no exact ticker match for ${symbol}, top result: ${results[0].stock?.info?.ticker || results[0].sid}`,
            );
          }
          sid = exactMatch ? exactMatch.sid : results[0].sid;
        }
      }

      if (!sid) return null;

      const infoResponse = await fetch(`${TICKERTAPE_BASE}/stocks/info/${sid}`);
      const infoData = (await infoResponse.json()) as any;

      let result: any = null;

      if (infoData.success && infoData.data) {
        const info = infoData.data.info || {};
        const ratios = infoData.data.ratios || {};

        result = {
          name: info.name || symbol,
          sector: info.sector || "Unknown",
          pe: ratios.pe || null,
          pb: ratios.pb || ratios.pbr || null,
          roe: ratios.roe || null,
          beta: ratios.beta || null,
          divYield: ratios.divYield || null,
          marketCap: ratios.marketCap || ratios.mrktCapf || null,
          eps: ratios.eps || null,
          high52w: ratios["52wHigh"] || null,
          low52w: ratios["52wLow"] || null,
          indPE: ratios.indpe || null,
          medianPE: null,
          peChange: null,
          historicalPE: [] as { year: string; pe: number }[],
          historicalPB: [] as { year: string; pb: number }[],
        };
      }

      if (result && result.pe) {
        try {
          const valResponse = await fetch(
            `${TICKERTAPE_BASE}/stocks/valuations/${sid}`,
          );
          const valData = (await valResponse.json()) as any;

          if (valData.success && valData.data?.valuations) {
            const valuations = valData.data.valuations || [];
            const historicalPE: { year: string; pe: number }[] = [];
            const historicalPB: { year: string; pb: number }[] = [];
            const peValues: number[] = [];

            for (const v of valuations.slice(-5)) {
              const year = v.fiscalYear || v.year || v.period || "";
              if (v.pe && v.pe > 0 && v.pe < 500) {
                peValues.push(v.pe);
                historicalPE.push({ year: String(year), pe: v.pe });
              }
              if (v.pb && v.pb > 0 && v.pb < 100) {
                historicalPB.push({ year: String(year), pb: v.pb });
              }
            }

            result.historicalPE = historicalPE;
            result.historicalPB = historicalPB;

            if (peValues.length > 0) {
              peValues.sort((a, b) => a - b);
              const mid = Math.floor(peValues.length / 2);
              result.medianPE =
                peValues.length % 2 !== 0
                  ? peValues[mid]
                  : (peValues[mid - 1] + peValues[mid]) / 2;
              result.peChange = (result.pe / result.medianPE - 1) * 100;
            }
          }

          if (result.historicalPE.length === 0) {
            const histResponse = await fetch(
              `${TICKERTAPE_BASE}/stocks/financials/historical/${sid}?period=annual`,
            );
            const histData = (await histResponse.json()) as any;

            const entries =
              histData.data?.income ||
              histData.data?.ratios ||
              histData.data ||
              [];
            if (Array.isArray(entries)) {
              const historicalPE: { year: string; pe: number }[] = [];
              const peValues: number[] = [];

              for (const entry of entries.slice(-5)) {
                const year =
                  entry.fiscalYear || entry.year || entry.period || "";
                const pe = entry.pe || entry.priceToEarnings || entry.peRatio;
                if (pe && pe > 0 && pe < 500) {
                  peValues.push(pe);
                  historicalPE.push({ year: String(year), pe });
                }
              }

              if (historicalPE.length > 0) {
                result.historicalPE = historicalPE;

                peValues.sort((a, b) => a - b);
                const mid = Math.floor(peValues.length / 2);
                result.medianPE =
                  peValues.length % 2 !== 0
                    ? peValues[mid]
                    : (peValues[mid - 1] + peValues[mid]) / 2;
                result.peChange = (result.pe / result.medianPE - 1) * 100;
              }
            }
          }

          if (result.historicalPE.length > 0) {
            const currentYear = new Date().getFullYear().toString();
            if (
              !result.historicalPE.find(
                (h: { year: string; pe: number }) => h.year === currentYear,
              )
            ) {
              result.historicalPE.push({ year: currentYear, pe: result.pe });
            }
          }
        } catch (histError) {
          console.log("Historical PE fetch error (non-critical):", histError);
        }
      }

      return result;
    } catch (error) {
      console.error("Tickertape fetch error:", error);
      return null;
    }
  }

  protected async fetchScreenerData(symbol: string): Promise<any> {
    try {
      const response = await fetch(`${SCREENER_BASE}/company/${symbol}/`, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const html = await response.text();

      const salesGrowth = this.parseGrowthSection(
        html,
        "Compounded Sales Growth",
      );
      const profitGrowth = this.parseGrowthSection(
        html,
        "Compounded Profit Growth",
      );

      const roce = this.parseMetric(html, "ROCE");
      const bookValue = this.parseMetric(html, "Book Value");
      const debtToEquity = this.parseMetric(html, "Debt to equity");

      const shareholding = this.parseShareholding(html);

      const descMatch =
        html.match(
          /<div[^>]+class="[^"]*company-profile[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i,
        ) ||
        html.match(
          /<section[^>]+id="about"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i,
        );
      const description = descMatch
        ? descMatch[1]
            .replace(/<[^>]+>/g, "")
            .replace(/\s+/g, " ")
            .trim()
        : null;

      const proscons = this.parseProsAndCons(html);
      const historicalPE = this.parseHistoricalPE(html);

      return {
        salesGrowth3Y: salesGrowth["3 Years"] || null,
        salesGrowth5Y: salesGrowth["5 Years"] || null,
        salesGrowthTTM: salesGrowth["TTM"] || null,
        profitGrowth3Y: profitGrowth["3 Years"] || null,
        profitGrowth5Y: profitGrowth["5 Years"] || null,
        profitGrowthTTM: profitGrowth["TTM"] || null,
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
        pros: proscons.pros,
        cons: proscons.cons,
        historicalPE,
        description,
      };
    } catch (error) {
      console.error("Screener fetch error:", error);
      return null;
    }
  }

  protected parseGrowthSection(
    html: string,
    sectionName: string,
  ): Record<string, number> {
    const result: Record<string, number> = {};
    const regex = new RegExp(`${sectionName}[\\s\\S]*?<\\/table>`, "i");
    const match = html.match(regex);

    if (match) {
      const section = match[0];
      const rows = section.match(/<tr>[\s\S]*?<\/tr>/gi) || [];

      for (const row of rows) {
        const yearMatch = row.match(
          /<td>(\d+ Years?|TTM):?<\/td>\s*<td>([^<]*)<\/td>/i,
        );
        if (yearMatch) {
          const period = yearMatch[1].replace(":", "");
          const value = parseFloat(yearMatch[2].replace("%", "").trim());
          if (!isNaN(value)) {
            result[period] = value;
          }
        }
      }
    }
    return result;
  }

  protected parseMetric(html: string, metricName: string): number | null {
    const patterns = [
      new RegExp(
        `${metricName}[\\s\\S]*?<span class="number">([\\d,.]+)<\\/span>`,
        "i",
      ),
      new RegExp(
        `>${metricName}<[\\s\\S]*?<span[^>]*>([\\d,.]+)<\\/span>`,
        "i",
      ),
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        const value = parseFloat(match[1].replace(/,/g, ""));
        if (!isNaN(value)) return value;
      }
    }
    return null;
  }

  protected parseShareholding(html: string): Record<string, number | null> {
    const result: Record<string, number | null> = {
      promoter: null,
      fii: null,
      dii: null,
      public: null,
      promoterChange: null,
      fiiChange: null,
      diiChange: null,
      publicChange: null,
    };

    const shareholdingMatch = html.match(
      /Shareholding Pattern[\s\S]*?<\/table>/i,
    );
    if (shareholdingMatch) {
      const section = shareholdingMatch[0];

      const promoterMatch = section.match(
        /Promoters[\s\S]*?<td[^>]*>[\s\S]*?([\d.]+)%/i,
      );
      const fiiMatch = section.match(/FIIs[\s\S]*?<td[^>]*>[\s\S]*?([\d.]+)%/i);
      const diiMatch = section.match(/DIIs[\s\S]*?<td[^>]*>[\s\S]*?([\d.]+)%/i);
      const publicMatch = section.match(
        /Public[\s\S]*?<td[^>]*>[\s\S]*?([\d.]+)%/i,
      );

      if (promoterMatch) result.promoter = parseFloat(promoterMatch[1]);
      if (fiiMatch) result.fii = parseFloat(fiiMatch[1]);
      if (diiMatch) result.dii = parseFloat(diiMatch[1]);
      if (publicMatch) result.public = parseFloat(publicMatch[1]);

      const parseHoldingTrend = (
        row: string,
      ): { current: number; change: number } | null => {
        const values = row.match(/([\d.]+)%/g);
        if (values && values.length >= 2) {
          const current = parseFloat(values[0].replace("%", ""));
          const previous = parseFloat(values[1].replace("%", ""));
          return { current, change: current - previous };
        }
        return null;
      };

      const promoterRow = section.match(/Promoters[^\n]*[\s\S]*?<\/tr>/i);
      const fiiRow = section.match(/FIIs[^\n]*[\s\S]*?<\/tr>/i);
      const diiRow = section.match(/DIIs[^\n]*[\s\S]*?<\/tr>/i);
      const publicRow = section.match(/Public[^\n]*[\s\S]*?<\/tr>/i);

      if (promoterRow) {
        const trend = parseHoldingTrend(promoterRow[0]);
        if (trend) {
          result.promoter = trend.current;
          result.promoterChange = trend.change;
        }
      }
      if (fiiRow) {
        const trend = parseHoldingTrend(fiiRow[0]);
        if (trend) {
          result.fii = trend.current;
          result.fiiChange = trend.change;
        }
      }
      if (diiRow) {
        const trend = parseHoldingTrend(diiRow[0]);
        if (trend) {
          result.dii = trend.current;
          result.diiChange = trend.change;
        }
      }
      if (publicRow) {
        const trend = parseHoldingTrend(publicRow[0]);
        if (trend) {
          result.public = trend.current;
          result.publicChange = trend.change;
        }
      }
    }

    return result;
  }

  protected parseProsAndCons(html: string): { pros: string[]; cons: string[] } {
    const result = { pros: [] as string[], cons: [] as string[] };

    const prosMatch = html.match(
      /<section[^>]*class="[^"]*pros[^"]*"[^>]*>[\s\S]*?<ul>([\s\S]*?)<\/ul>/i,
    );
    if (prosMatch) {
      const prosItems = prosMatch[1].match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
      result.pros = prosItems
        .map((item) => item.replace(/<[^>]*>/g, "").trim())
        .filter((p) => p.length > 0)
        .slice(0, 5);
    }

    const consMatch = html.match(
      /<section[^>]*class="[^"]*cons[^"]*"[^>]*>[\s\S]*?<ul>([\s\S]*?)<\/ul>/i,
    );
    if (consMatch) {
      const consItems = consMatch[1].match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
      result.cons = consItems
        .map((item) => item.replace(/<[^>]*>/g, "").trim())
        .filter((c) => c.length > 0)
        .slice(0, 5);
    }

    return result;
  }

  protected parseHistoricalPE(html: string): { year: string; pe: number }[] {
    const historicalPE: { year: string; pe: number }[] = [];

    try {
      const annualSection = html.match(/id="profit-loss"[\s\S]*?<\/section>/i);
      if (annualSection) {
        const headerMatch = annualSection[0].match(/<thead>[\s\S]*?<\/thead>/i);
        const years: string[] = [];

        if (headerMatch) {
          const yearMatches =
            headerMatch[0].match(/(?:Mar|FY)\s*(\d{2,4})/gi) || [];
          for (const ym of yearMatches) {
            const yearNum = ym.match(/\d+/);
            if (yearNum) {
              let year = yearNum[0];
              if (year.length === 2) {
                year = (parseInt(year) > 50 ? "19" : "20") + year;
              }
              years.push(year);
            }
          }
        }

        const epsRowMatch = annualSection[0].match(/EPS[^\n]*?<\/tr>/i);
        if (epsRowMatch && years.length > 0) {
          epsRowMatch[0]
            .match(/>([\d.]+)</g)
            ?.map((v) => parseFloat(v.replace(/[><]/g, "")))
            .filter((n) => !isNaN(n) && n > 0);
        }
      }

      const chartDataMatch = html.match(/var\s+pe_data\s*=\s*(\[[\s\S]*?\]);/i);
      if (chartDataMatch) {
        try {
          const peData = JSON.parse(chartDataMatch[1]);
          for (const item of peData) {
            if (item.x && item.y) {
              historicalPE.push({
                year: String(item.x).slice(0, 4),
                pe: parseFloat(item.y),
              });
            }
          }
        } catch (e) {
          // JSON parse failed
        }
      }
    } catch (error) {
      console.log("Historical PE parsing error (non-critical):", error);
    }

    return historicalPE;
  }
}
