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
