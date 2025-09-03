概要
- Cloudflare D1 に保存したポートフォリオを Cloudflare Workers API 経由で読み込み、`report_db.html` で最新価格と基準値（前日/1M/1Y）を表示します。
- 価格・基準値の取得は Yahoo のみを使用。Stooq などへのフォールバックは行いません。

ファイル構成（最小）
- `report_db.html` — メインUI（D1から保有と価格を読み込んで表示）
- `service-worker.js` — オフライン用 Service Worker（`report_db.html` をキャッシュ）
- `manifest.webmanifest` — PWA マニフェスト（start_url は `report_db.html`）
- `proxy/worker.js` — Cloudflare Workers API（D1連携・Yahoo取得・ベースライン補完）
- `proxy/wrangler.toml` — Worker の設定（D1 バインド、cron）
- `schema.sql` — D1 スキーマ（`holdings`, `quotes_new` など）
- `scripts/` — 補助スクリプト（CSV同期など）
  - `scripts/d1_backfill_company_names.py` — holdings.company_name の一括補完（D1直更新）
- `portfolio.csv` — サンプル/運用用CSV（任意）

セットアップ（Workers + D1）
- D1 バインド設定: `proxy/wrangler.toml` の `[[d1_databases]] binding = "DB"` を自分の DB に合わせる。
- スキーマ適用: `wrangler d1 execute <db-name> --file ./schema.sql --remote`
- デプロイ: `cd proxy && wrangler deploy`
- 自動更新: 15分ごと（`[triggers] crons = ["*/15 * * * *"]`）

API エンドポイント（例: `https://<your-worker>.workers.dev`）
- `GET /api/portfolio` — 保有一覧
- `POST /api/portfolio` — 追加/更新 `{symbol, shares, currency, company_name?}`
- `DELETE /api/portfolio?symbol=XXXX` — 削除
- `GET /api/quotes_new` — 価格・通貨・更新時刻、`price_1d/1m/1y` と各 `_at`（欠損は補完済み）
- `POST /api/quotes/refresh`（別名: `/api/quotes_new/refresh-current`, `/api/quotes/refresh-current`）
  - 現在値と基準値を Yahoo から更新。`?symbols=AAPL,7203.T` 指定や `&dry=1` ドライランに対応
- `GET /api/portfolio_with_prices` — holdings × quotes_new の結合（JPY換算含む）
- `GET /api/usdjpy` — `USDJPY=X` の行（JPY換算に使用）
- `GET /api/debug/yahoo?symbols=...` — Yahoo 到達性チェック

使い方（フロント）
- GitHub Pages などで静的ホスティング
- `report_db.html?api=https://<your-worker>.workers.dev` を開く
  - 初期表示時に `holdings`, `quotes_new`, `usdjpy` を取得して描画
 - 必要に応じて `更新` ボタンから `/api/quotes_new/refresh-current` をトリガー

CSV → DB（置き換えのみ）
- CSV の内容を D1 の holdings に反映（CSVに無い銘柄は削除）:
  - `python3 scripts/sync_portfolio_csv.py --csv portfolio.csv --api https://<your-worker>.workers.dev/api/portfolio`
  - 既定で置き換え動作（--mode replace）になります

company_name 一括補完（D1 直更新）
- 前提: `proxy/wrangler.toml` の `[[d1_databases]]` が自分のDB名（例: `stock-db`）になっていること、`wrangler login` 済みであること
- 実行（コピーしてOK）:
  1) 任意（フォールバック用）: `python3 -m pip install yfinance`
  2) 社名補完を実行: `python3 scripts/d1_backfill_company_names.py --db stock-db --proxy-dir proxy`
  3) 確認: `cd proxy && wrangler d1 execute stock-db --remote --command "SELECT symbol, company_name FROM holdings ORDER BY symbol" --json`

- オプション:
  - ドライラン: `python3 scripts/d1_backfill_company_names.py --db stock-db --proxy-dir proxy --dry-run`
  - 既存の社名も含めて上書き: `python3 scripts/d1_backfill_company_names.py --db stock-db --proxy-dir proxy --force`


実装メモ
- 取得は Yahoo のみ。Worker からのリクエストには Firefox UA / `Accept-Language: ja,...` / `Referer: https://finance.yahoo.com/` を付与
- ベースラインは Yahoo Chart API（日足2年）から推定し、欠損は `price`/直近終値で補完
- `report_db.html` は `/api/fundamentals` が無くても動作（取得失敗時は空で PER を非表示）
