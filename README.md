# Portfolio Analyzer - VS Code Extension

A comprehensive equity research and portfolio analysis extension for VS Code with multi-broker support.

## Features

- 📊 **Real-time Portfolio Dashboard** - View all your holdings with live prices
- 📈 **Fundamental Analysis** - 10-category scoring system for each stock
- 🎯 **Investment Verdicts** - Clear buy/hold/sell recommendations
- 🔄 **Auto-refresh** - Prices update automatically during market hours
- 🔌 **Multi-broker Support** - Currently supports IndMoney, more coming soon

## Supported Brokers

| Broker | Status |
|--------|--------|
| IndMoney (INDstocks) | ✅ Supported |
| Zerodha (Kite) | 🔜 Coming Soon |
| Groww | 🔜 Coming Soon |
| Upstox | 🔜 Coming Soon |

## Installation

1. Download the `.vsix` file
2. In VS Code, press `Ctrl+Shift+P` and run "Extensions: Install from VSIX..."
3. Select the downloaded file

## Configuration

### Setting up IndMoney

1. Click the Portfolio Analyzer icon in the Activity Bar
2. Click "Configure Broker" or the ⚙️ icon
3. Select "IndMoney"
4. Enter your access token

### Getting IndMoney Access Token

1. Log in to IndMoney web app
2. Open browser Developer Tools (F12)
3. Go to Network tab
4. Find any API request to `api.indstocks.com`
5. Copy the `Authorization` header value

## Scoring Methodology

The extension uses a weighted 10-point scoring system:

| Category | Weight | What It Measures |
|----------|--------|------------------|
| Revenue Growth | 15% | 3Y & 5Y Sales CAGR |
| Profit Growth | 15% | 3Y & 5Y Profit CAGR |
| Balance Sheet | 10% | Debt/Equity ratio |
| Cash Flow | 10% | Profit consistency |
| Management | 10% | Promoter holding % |
| Industry | 10% | Sector growth potential |
| Moat | 10% | ROCE + ROE average |
| Valuation | 10% | PE vs Industry, P/B |
| Capital Allocation | 5% | ROE + Dividend yield |
| Risk Level | 5% | Beta (volatility) |

### Verdict Thresholds

- 🚀 **STRONG BUY** (≥8.0) - Exceptional fundamentals
- 📈 **BUY** (≥7.0) - Good quality, favorable outlook
- 📊 **HOLD** (≥6.0) - Average, monitor closely
- ⚠️ **WEAK HOLD** (≥5.0) - Concerns exist, consider reducing
- 📉 **SELL** (<5.0) - Poor fundamentals, exit recommended

## Usage

1. Open the Portfolio Analyzer view from the Activity Bar
2. Your holdings are automatically fetched and analyzed
3. Click on any stock to expand detailed analysis
4. Use the refresh button to update prices
5. Switch to "Methodology" tab to understand scoring

## Data Sources

- **Holdings & Prices**: Your broker API (IndMoney)
- **Fundamentals**: Tickertape API (PE, PB, ROE, Beta, etc.)
- **Growth Metrics**: Screener.in (Revenue/Profit CAGR, ROCE)

## Privacy

- All credentials are stored locally in VS Code settings
- No data is sent to third-party servers (except broker/data APIs)
- API calls are made directly from your machine

## Contributing

To add support for a new broker:

1. Create a new provider in `src/providers/`
2. Implement the `IPortfolioProvider` interface
3. Register in `ProviderManager.ts`
4. Add configuration options in `package.json`

## License

MIT
