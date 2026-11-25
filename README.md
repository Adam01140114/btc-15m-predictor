# BTC 15-Minute Predictor

Predicts whether Bitcoin will be up or down at the end of each 15-minute Polymarket "Bitcoin Up or Down" window, and checks whether betting on that prediction beats the price Polymarket charges.

**Live app:** https://adam01140114.github.io/btc-15m-predictor/

## Bottom line

| Question | Answer |
|---|---|
| Can it predict the 15-minute direction better than 50%? | **Yes: 54.2%.** Tested on 7,124 real Polymarket windows (Sep 11 – Nov 24, 2026) never used to build it. On its confident calls (≥5% edge), it's right 57%. |
| Does that make money on Polymarket? | **Not at the prices you can actually get.** Market makers price the same information in within ~10–20 seconds of each window opening. Betting at the first price recorded after the open lost 0.4% per bet (11–20 s) and 7.3% (21–30 s) after the 2.5% taker fee. |
| What would have to be true to profit? | Your venue's price must lag the model, mostly in the first seconds after the open. That wasn't true on the global Polymarket book. **Polymarket US has its own order book and might differ.** The trade log in the app is built to measure exactly that. |

This is research on past data, not financial advice. Expect to lose the fee on most bets unless your own logged trades show otherwise.

## How it predicts

A logistic regression on 30 features of the last day of 1-minute Binance candles, retrained monthly on the previous 24 months. Two effects do most of the work, and both held in every year from 2019 to 2026:

- **Mean reversion.** When BTC has risen over the last 10 minutes to 4 hours (relative to its recent average and range), the next 15 minutes lean slightly down, and vice versa.
- **The "head start".** Polymarket settles on Chainlink's 60-second average price, comparing the window's end against its start. If the price rose during the minute before the window opened, the current price is already above the "price to beat", so Up starts slightly ahead.

## Results

Walk-forward means each month was predicted by a model trained only on earlier data.

| Test | Windows | Accuracy |
|---|---|---|
| Development, Jan 2021 – Aug 2026 (walk-forward) | 198,565 | 54.1% (every year 53.7–54.7%) |
| Confident calls only (≥5% edge), development | 75,257 | 57.1% |
| **Held-out Polymarket windows vs official results** | 7,124 | **54.2%** |
| Binance-based result vs Polymarket's official result | 7,124 | 97.0% agree |

Against Polymarket prices (taker fee 0.05 × p × (1−p), plus a 0.5¢ spread, betting only when the model beats the cost by ≥ 2¢):

| When you buy | Bets | Win rate | Avg cost | Return per bet |
|---|---|---|---|---|
| Price recorded 11–20 s after the open | 915 | 49.8% | 50.0¢ | −0.4% |
| Price recorded 21–30 s after the open | 632 | 45.3% | 48.8¢ | −7.3% |
| 5 min into the window | 1,136 | 64.8% | 66.8¢ | −3.0% |
| 10 min into the window | 1,050 | 69.1% | 70.9¢ | −2.5% |
| 1 min *before* the open (separate pre-open model) | 1,421 | 53.6% | 52.0¢ | +3.2% (not statistically reliable) |

The tempting "+9% per bet at the open" seen when using the last price recorded before the open is an artifact. Those prices are up to a minute old, and you couldn't actually have traded at them with the information the model uses.

## The web app (`web/`)

A single page that works on a phone. It pulls live 1-minute candles from Binance's public data mirror and Polymarket's global order book.

- **Current window:** the call (Up/Down and probability) for the window that just opened, and a countdown.
- **Polymarket check:** live price of each side, the most a share is worth after the fee, and a Buy/Pass verdict. This only shows during the first 20 seconds of a window, because after that the market has caught up.
- **Track record:** the model's accuracy over the last 24 hours, recomputed from live data.
- **My trades:** log each real bet (side, price, shares). It fills in Polymarket's official result once the window settles and totals your profit or loss. Export to CSV. Trades are stored only in that browser.

Run it locally by serving the `web/` folder with any static server, then open `index.html`. For example: `npx serve web`.

The live site is served from the `gh-pages` branch, which holds just the `web/` folder. After changing anything in `web/` (including a retrained `model.json`), commit to `main` and then publish:

```bash
git subtree push --prefix web origin gh-pages
```

## Reproduce the research

```bash
node src/download_binance.mjs 2019-01     # 1-minute BTCUSDT candles (~4.2M) from data.binance.vision
node src/collect_polymarket.mjs 75        # past Polymarket 15-min markets: outcomes, fees, price history
node --max-old-space-size=8192 src/research.mjs 0              # base rates, single features, walk-forward model
node --max-old-space-size=8192 src/evaluate_polymarket.mjs 0   # model vs official outcomes and market prices
node --max-old-space-size=8192 src/fresh_prices.mjs 0          # same, using only prices recorded after the decision
node --max-old-space-size=8192 src/test_parity.mjs             # live app features == training features
node --max-old-space-size=8192 src/export_model.mjs            # retrain on the last 24 months → web/model.json
```

Pass `-1` (one minute before the open) or `5` / `10` (minutes into the window) to `research`, `evaluate_polymarket` and `fresh_prices` to test other entry times. Plain Node.js 18+, no packages.

## Polymarket facts used (checked Nov 25, 2026)

- **Settlement:** Chainlink BTC/USD 60-second TWAP stream. Up wins if the final price is ≥ the price at the window start (ties go to Up).
- **Fees:** taker-only, fee per share = 0.05 × p × (1 − p), so 1.25¢ at a 50¢ price. It was 0.01 until about late October 2026. Limit (maker) orders pay no fee.
- **Windows:** every :00/:15/:30/:45. Minimum order is 5 shares; tick size 0.1¢.
- **Polymarket US:** has its own order book and app. Its fees for these markets weren't confirmed.
