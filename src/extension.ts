/**
 * StockLens - VS Code Extension
 * Sidebar for overview + separate panel for stock details
 */

import * as vscode from "vscode";
import { PortfolioSidebarProvider } from "./webview/PortfolioSidebarProvider";
import { WatchlistSidebarProvider } from "./webview/WatchlistSidebarProvider";
import { StockDetailPanel } from "./webview/StockDetailPanel";
import { ScoringInfoPanel } from "./webview/ScoringInfoPanel";
import { ProviderManager } from "./providers/ProviderManager";
import { AnalysisService, StockAnalysis } from "./services/AnalysisService";
import { StockSearchService } from "./services/StockSearchService";
import { WatchlistService } from "./services/WatchlistService";

let sidebarProvider: PortfolioSidebarProvider | undefined;
let watchlistSidebarProvider: WatchlistSidebarProvider | undefined;
let stockDetailPanels: Map<string, StockDetailPanel> = new Map();
let stockSearchService: StockSearchService;

export function activate(context: vscode.ExtensionContext) {
  console.log("StockLens extension is now active!");
  console.log("Extension path:", context.extensionPath);

  // Initialize services
  const providerManager = new ProviderManager(context);
  const analysisService = new AnalysisService();
  stockSearchService = new StockSearchService(context.extensionPath);

  // Create watchlist service first — shared by both sidebars
  const watchlistService = new WatchlistService(context);

  // Create the sidebar provider
  sidebarProvider = new PortfolioSidebarProvider(
    context.extensionUri,
    providerManager,
    analysisService,
    watchlistService,
    context,
  );

  // Register the portfolio dashboard sidebar
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "portfolioAnalyzer.dashboard",
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
  watchlistSidebarProvider = new WatchlistSidebarProvider(
    context.extensionUri,
    watchlistService,
    stockSearchService,
    context,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "portfolioAnalyzer.watchlist",
      watchlistSidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // New watchlist command (title bar button)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "portfolioAnalyzer.newWatchlist",
      async () => {
        if (watchlistSidebarProvider) {
          await watchlistSidebarProvider.createWatchlist();
        }
      },
    ),
  );

  // Refresh watchlist command (title bar button)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "portfolioAnalyzer.refreshWatchlist",
      async () => {
        if (watchlistSidebarProvider) {
          await watchlistSidebarProvider.refresh();
        }
      },
    ),
  );

  // Command to add the currently searched stock to a watchlist
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "portfolioAnalyzer.addToWatchlist",
      async (symbol: string, name: string, sector: string) => {
        if (watchlistSidebarProvider) {
          await watchlistSidebarProvider.addStockToWatchlist(symbol, name, sector);
        }
      },
    ),
  );

  // Register command to open stock detail panel
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "portfolioAnalyzer.openStockDetail",
      (stock: StockAnalysis) => {
        const existingPanel = stockDetailPanels.get(stock.symbol);
        if (existingPanel) {
          existingPanel.reveal();
          existingPanel.update(stock);
        } else {
          const panel = new StockDetailPanel(
            context.extensionUri,
            context,
            stock,
          );
          stockDetailPanels.set(stock.symbol, panel);
          panel.onDidDispose(() => {
            stockDetailPanels.delete(stock.symbol);
          });
        }
      },
    ),
  );

  // Register open dashboard command (focuses sidebar)
  context.subscriptions.push(
    vscode.commands.registerCommand("portfolioAnalyzer.openDashboard", () => {
      vscode.commands.executeCommand("portfolioAnalyzer.dashboard.focus");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "portfolioAnalyzer.refreshData",
      async () => {
        if (sidebarProvider) {
          await sidebarProvider.refresh();
          vscode.window.showInformationMessage("Portfolio data refreshed!");
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "portfolioAnalyzer.configureProvider",
      async () => {
        const providers = [
          {
            label: "IndMoney",
            description: "INDstocks API",
            value: "indmoney",
          },
          {
            label: "Zerodha",
            description: "Kite Connect API (Coming Soon)",
            value: "zerodha",
          },
          { label: "Groww", description: "Coming Soon", value: "groww" },
          { label: "Upstox", description: "Coming Soon", value: "upstox" },
        ];

        const selected = await vscode.window.showQuickPick(providers, {
          placeHolder: "Select your broker/trading platform",
        });

        if (selected) {
          await vscode.workspace
            .getConfiguration("portfolioAnalyzer")
            .update(
              "activeProvider",
              selected.value,
              vscode.ConfigurationTarget.Global,
            );

          if (selected.value === "indmoney") {
            const token = await vscode.window.showInputBox({
              prompt: "Enter your IndMoney access token",
              password: true,
              placeHolder: "eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9...",
            });

            if (token) {
              await vscode.workspace
                .getConfiguration("portfolioAnalyzer")
                .update(
                  "indmoney.accessToken",
                  token,
                  vscode.ConfigurationTarget.Global,
                );

              if (sidebarProvider) {
                await sidebarProvider.refresh();
              }
              vscode.window.showInformationMessage(
                "IndMoney configured successfully!",
              );
            }
          } else {
            vscode.window.showInformationMessage(
              `${selected.label} support coming soon!`,
            );
          }
        }
      },
    ),
  );

  // Register stock search command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "portfolioAnalyzer.searchStock",
      async () => {
        // Show QuickPick with search capability
        const quickPick = vscode.window.createQuickPick<
          vscode.QuickPickItem & { stockSymbol?: string }
        >();
        quickPick.placeholder =
          "Search Indian stocks (e.g., RELIANCE, TCS, INFY)";
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;

        let searchTimeout: NodeJS.Timeout | undefined;
        let currentResults: Map<string, string> = new Map();

        quickPick.onDidChangeValue((value) => {
          if (searchTimeout) {
            clearTimeout(searchTimeout);
          }

          // Debounce search
          searchTimeout = setTimeout(() => {
            if (value.length >= 1) {
              const results = stockSearchService.searchStocks(value, 15);
              const total = stockSearchService.searchStocks(value, 9999).length;
              currentResults.clear();

              quickPick.items = results.map((stock) => {
                const label = `$(symbol-class) ${stock.symbol}`;
                currentResults.set(label, stock.symbol);
                return {
                  label,
                  description: `🇮🇳 ${stock.name}`,
                  detail: `NSE/BSE · ${stock.sector}`,
                  stockSymbol: stock.symbol,
                };
              });

              quickPick.placeholder =
                total > 15
                  ? `Showing 15 of ${total} results — type more to narrow down`
                  : `${total} result${total === 1 ? "" : "s"} found`;
              quickPick.busy = false;
            } else {
              quickPick.items = [];
              currentResults.clear();
            }
          }, 100);
        });

        quickPick.onDidAccept(async () => {
          const selected = quickPick.selectedItems[0];
          if (selected) {
            const symbol = selected.stockSymbol || currentResults.get(selected.label);

            if (symbol) {
              quickPick.hide();

              // Show loading notification
              await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: `Analyzing ${symbol}...`,
                  cancellable: false,
                },
                async () => {
                  const timeout = new Promise<null>((_, reject) =>
                    (globalThis as any).setTimeout(
                      () => reject(new Error("timeout")),
                      30000,
                    ),
                  );
                  let analysis: any = null;
                  try {
                    analysis = await Promise.race([
                      stockSearchService.analyzeStock(symbol),
                      timeout,
                    ]);
                  } catch (err: any) {
                    const msg =
                      err?.message === "timeout"
                        ? `Timed out fetching data for ${symbol}. Check your internet connection and try again.`
                        : `Failed to analyze ${symbol}: ${err?.message || "unknown error"}`;
                    vscode.window.showErrorMessage(msg);
                    return;
                  }

                  if (analysis) {
                    // If this stock is already held, merge real position data
                    const held = sidebarProvider
                      ?.getPortfolioStocks()
                      .find(
                        (s) =>
                          s.symbol.toUpperCase() ===
                          analysis.symbol.toUpperCase(),
                      );
                    if (held) {
                      analysis.quantity = held.quantity;
                      analysis.avgPrice = held.avgPrice;
                      analysis.investedValue = held.investedValue;
                      analysis.currentValue = held.currentValue;
                      analysis.profitLoss = held.profitLoss;
                      analysis.profitLossPct = held.profitLossPct;
                    }

                    const existingPanel = stockDetailPanels.get(
                      analysis.symbol,
                    );
                    if (existingPanel) {
                      existingPanel.reveal();
                      existingPanel.update(analysis);
                    } else {
                      const panel = new StockDetailPanel(
                        context.extensionUri,
                        context,
                        analysis,
                      );
                      stockDetailPanels.set(analysis.symbol, panel);
                      panel.onDidDispose(() => {
                        stockDetailPanels.delete(analysis.symbol);
                      });
                    }
                  } else {
                    vscode.window.showErrorMessage(
                      `No data found for ${symbol}. The stock may be delisted or not supported.`,
                    );
                  }
                },
              );
            }
          }
        });

        quickPick.onDidHide(() => {
          if (searchTimeout) {
            clearTimeout(searchTimeout);
          }
          quickPick.dispose();
        });

        quickPick.show();
      },
    ),
  );

  // Register scoring info command
  context.subscriptions.push(
    vscode.commands.registerCommand("portfolioAnalyzer.showScoringInfo", () => {
      ScoringInfoPanel.createOrShow(context.extensionUri);
    }),
  );

}

export function deactivate() {
  // Clean up all stock detail panels
  stockDetailPanels.forEach((panel) => panel.dispose());
  stockDetailPanels.clear();
  console.log("StockLens extension deactivated");
}
