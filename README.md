# Stock Portfolio Worker

This repository contains a Cloudflare Workers application that stores and serves
stock portfolio data in a D1 database. The original front‑end UI has been removed.

## API Endpoints

All routes are prefixed with `/api`.

| Method | Path | Description |
|--------|------|-------------|
| GET    | /portfolio | List holdings |
| POST   | /portfolio | Add or update a holding (`{symbol, shares, currency, company_name?}`) |
| DELETE | /portfolio?symbol=XYZ | Delete a holding |
| GET    | /quotes_new | Get latest prices and reference values |
| POST   | /quotes/refresh | Refresh current prices (optionally `?symbols=A,B` or `&dry=1`) |
| GET    | /portfolio_with_prices | Join holdings with quotes |
| GET    | /usdjpy | Current USD↔JPY rate |

## Setup & Usage

1. **Deploy the worker** (if not already deployed):
   ```bash
   cd proxy && wrangler deploy
   ```
2. **Serve the front‑end locally** (or host it anywhere). The page expects the API to be reachable at the same origin, so when running locally you can serve the `frontend` folder with a simple static server:
   ```bash
   npx http-server frontend -p 8080
   ```
3. **Open** `http://localhost:8080` in your browser.

### Maintaining `portfolio.csv`

Edit the root‐level `portfolio.csv` when you need to adjust holdings. The file now has four columns and should look like:

```
symbol,shares,currency,company_name
ARM,14,USD,Arm Holdings plc
...
```

Run `python3 scripts/sync_portfolio_csv.py --mode replace` after saving to push the latest shares, currency, and company names to `/api/portfolio`, which persists them in D1.

The page automatically pulls portfolio, price, and currency data from the worker API and displays it grouped by domestic (ticker ending with `.T`) and US stocks. Each table shows ticker, shares, native price, the USD↔JPY rate (for foreign holdings), 1D/1M/1Y changes, and the value in the selected currency. For each group a **sub-total** is shown in both USD and JPY, followed by an overall total that can be toggled between USD and JPY.

## D1 Database Operations Summary

The Cloudflare Workers API exposes a small set of endpoints that allow you to read and write the data stored in the D1 database. Below is a quick reference for each operation, including the HTTP method, path, required/optional parameters, and what the endpoint does.

| Operation | Method & Path | Parameters / Body | Effect |
|-----------|---------------|-------------------|--------|
| **Add or update a holding** | `POST /api/portfolio` | JSON body: `{symbol, shares, currency, company_name?}` | Creates the row if it doesn’t exist; otherwise updates the existing record. |
| **Delete a holding** | `DELETE /api/portfolio?symbol=XYZ` | Query string `symbol` | Removes that ticker from the `holdings` table. |
| **Retrieve all holdings** | `GET /api/portfolio` | – | Returns an array of all rows in the `holdings` table. |
| **Refresh price data (all or specific tickers)** | `POST /api/quotes/refresh` | Optional query: `symbols=AAPL,7203.T&dry=1` | Pulls latest Yahoo prices for the specified symbols; if no symbols are provided it refreshes all holdings. The `dry=1` flag performs a dry‑run without writing to the DB. |
| **Retrieve all price data** | `GET /api/quotes_new` | – | Returns an array of all rows in the `quotes_new` table (latest prices and reference values). |
| **Retrieve combined portfolio + prices** | `GET /api/portfolio_with_prices` | – | Joins `holdings` with `quotes_new`, returning each holding enriched with current price, currency, and JPY conversion. |
| **Get USD↔JPY rate** | `GET /api/usdjpy` | – | Returns the latest USD‑to‑JPY exchange rate stored in the `usdjpy` table. |

### Automatic Refresh
The worker is configured with a cron trigger (`*/15 * * * *`). Every 15 minutes it automatically runs `POST /api/quotes/refresh` for all tickers in `holdings`. No manual action is required.

**Note:** Whenever the front‑end or any new feature is added, remember to update **README.md** with usage instructions and commit that change alongside the code. This keeps documentation in sync with the repository state.

### Direct SQL (Admin / Debug)
For one‑off queries or administrative edits you can use Wrangler’s D1 execute command:

```bash
wrangler d1 execute <db-name> --remote
# Example queries
SELECT * FROM holdings;
UPDATE holdings SET shares = 100 WHERE symbol='AAPL';
```

## `quotes_new` Table Schema
The **quotes_new** table holds the most recent price data for each ticker, along with a few reference values used by the front‑end. The schema is:

| Column | Type | Notes |
|--------|------|-------|
| `symbol` | `TEXT PRIMARY KEY` | Ticker symbol (e.g., `AAPL`, `7203.T`). |
| `price_usd` | `REAL NOT NULL` | Latest price in USD. |
| `price_jpy` | `REAL NOT NULL` | Latest price converted to JPY using the current exchange rate. |
| `last_updated` | `INTEGER NOT NULL` | Unix timestamp of when the price was last refreshed. |
| `currency` | `TEXT NOT NULL` | Currency code for the source data (usually `USD`). |
| `company_name` | `TEXT` | Human‑readable company name, if available from Yahoo Finance. |
| `reference_value_usd` | `REAL` | Optional reference value in USD used for comparison or historical calculations. |
| `reference_value_jpy` | `REAL` | Optional reference value in JPY corresponding to the above. |

The worker writes to this table whenever a price refresh is performed, and reads from it when constructing portfolio views.
