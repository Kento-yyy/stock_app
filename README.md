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

The page automatically pulls portfolio, price, and currency data from the worker API and displays it grouped by domestic (ticker ending with `.T`) and US stocks. For each group a **sub‑total** is shown in both USD and JPY, followed by an overall total that can be toggled between USD and JPY.
