**概要**
- Cloudflare D1 データベースに保存したポートフォリオを API 経由で取得し、現在価格で評価額を計算します。
- 価格取得は Alpha Vantage API または yfinance を使用できます（既定は yfinance）。

**ファイル構成**
- `portfolio_notify.py`: メインスクリプト
- `config.example.json`: 設定のサンプル
- `portfolio.example.csv`: ポートフォリオCSVのサンプル

**前提**
- Python 3.8+
- 依存ライブラリ:
  - `yfinance`（推奨・デフォルト）: `pip install yfinance`
  - `requests`（Alpha Vantageを使う場合のみ）

**セットアップ**
- 設定ファイルを作成/編集:
  - `config.json` を編集（価格プロバイダ等を設定）
- Cloudflare D1 にポートフォリオDBを作成:
  - `schema.sql` を用いて `holdings` テーブルを作成
  - `symbol,shares,currency` を登録
- 機密情報は環境変数でも上書き可能:
  - `PN_ALPHA_VANTAGE_KEY` … Alpha Vantage APIキー

**秘密情報の秘匿（.env推奨）**
- このリポジトリは `.env` を自動読み込みします（外部ライブラリ不要）。
- 手順:
  1) `.env.example` を `.env` にコピーし、必要な値を記入
  2) `config.json` からパスワード等の秘匿情報を空にする（`.env` が優先されます）
  3) `.env` は Git 追跡除外済み（`.gitignore`）
- 利用する主なキー:
  - （任意）`PN_ALPHA_VANTAGE_KEY`

**実行**
- 標準出力に結果表示:
  - `python3 portfolio_notify.py --config config.json --portfolio-url https://<worker>/api/portfolio`

**CSV → DB 反映（同期）**
- `portfolio.csv` の内容を D1（`/api/portfolio`）へ反映する補助スクリプトを追加しました。
  - 事前に Cloudflare Workers を `wrangler dev` でローカル起動するか、デプロイ済みのURLを指定してください。
  - 例（ローカル dev に反映、DBをCSVで置き換え）:
    - `python3 scripts/sync_portfolio_csv.py --csv portfolio.csv --api http://127.0.0.1:8787/api/portfolio --mode replace`
  - 例（本番Workerに upsert のみ）:
    - `python3 scripts/sync_portfolio_csv.py --csv portfolio.csv --api https://<your-worker>.workers.dev/api/portfolio --mode upsert`
  - 先に差分だけ見たい場合:
    - `python3 scripts/sync_portfolio_csv.py --csv portfolio.csv --api http://127.0.0.1:8787/api/portfolio --mode replace --dry-run`

  - Workerのデプロイもこのコマンドから実行可能（`--deploy`）:
    - `python3 scripts/sync_portfolio_csv.py \
        --deploy --worker tight-truth-243e \
        --csv portfolio.csv \
        --api https://tight-truth-243e.<your-account>.workers.dev/api/portfolio \
        --mode replace`
    - 内部で `wrangler deploy --name tight-truth-243e` を `proxy/` ディレクトリで実行します。

注意（Fundamentalsについて）
- Fundamentals（純利益・発行済株式数など）のAPI自動取得やDB更新機能は廃止しました。
- データの追加や更新は Cloudflare D1 を直接操作して行ってください。


**混在ポートフォリオ（米国株+日本株）**
- DB の `currency` 列で銘柄ごとに通貨を指定できます（`USD` または `JPY`）。
- レポートは以下の列順で表示します:
  - `SYMBOL`, `SHARES`, `USD_PRICE`, `USD_VALUE`, `JPY_PRICE`, `JPY_VALUE`
- 為替レートは Alpha Vantage の `CURRENCY_EXCHANGE_RATE` を使用（USD→JPYを1回取得）。
- 注意: 現状サポート通貨は USD/JPY のみです。


**価格プロバイダ**
- 既定は `yfinance`（APIキー不要）。`config.json` の `price_provider.type` を `"yfinance"` にするか、未指定なら自動で `yfinance` を使用します。
- Alpha Vantageを使う場合は `price_provider.type` を `"alpha_vantage"` にし、APIキーを設定してください（レート制限あり）。

**自動実行（cronの例）**
- 毎営業日 16:30 に実行して標準出力/HTML保存:
  - `crontab -e`
  - 例: `30 16 * * 1-5 PN_ALPHA_VANTAGE_KEY=... /usr/bin/python3 /path/to/portfolio_notify.py --config /path/to/config.json --portfolio-url https://<worker>/api/portfolio --save-html /path/to/report.html`

**制限・拡張**
- 現在は通貨換算を行わず、各銘柄のクォート通貨で集計します（USD等）。


**iPhoneでアプリ風に使う（Mac不要・PWA）**
- このリポジトリは `report.html` をPWA対応済みです（`manifest.webmanifest`, `service-worker.js` 追加）。
- GitHub Pages等でHTTPS配信すると、iPhoneのSafariからホーム画面に追加してアプリ風に利用できます。
- 手順:
  - リポジトリをGitHubへプッシュ → Settings > Pages でデプロイ（Branch: `main`, Folder: `/`）。
  - iPhoneのSafariで `https://<yourname>.github.io/<repo>/report.html` を開く。
  - 共有メニュー > 「ホーム画面に追加」。
- オフライン: HTTPS配信時にservice workerが有効になり、`report.html` はオフラインでも開けます。追加でキャッシュしたいファイルがあれば `service-worker.js` の `PRECACHE_URLS` に追記してください。
- アイコン: iOSのホームアイコンをカスタムしたい場合は `icons/apple-touch-icon.png` を用意し、`report.html` の `apple-touch-icon` リンク先に置いてください（未設定でも動作します）。
- 自動更新: ページ表示時・復帰時に Yahoo Finance の公開エンドポイントから最新株価および `USDJPY=X` を取得し、表を更新します。ネットワークや CORS の都合で失敗する場合は、右上の「更新」ボタンから再試行するか、下記の Cloudflare Workers API を利用してください（Yahoo のみ対応）。

### Cloudflare Workers API（D1 + Yahoo, CORS回避）

Yahoo のみを使用する D1 連携 API を用意しています。CORS 回避とベースライン埋め（前日/1ヶ月/1年）に対応します。

セットアップ
- `proxy/wrangler.toml` の D1 バインド `binding = "DB"` を自分の DB に合わせる。
- スキーマ適用: `wrangler d1 execute <db-name> --file ./schema.sql --remote`
- デプロイ: `cd proxy && wrangler deploy`
- 15分ごと自動更新（cron）は wrangler.toml の `[triggers] crons = ["*/15 * * * *"]` で有効。

API エンドポイント（例: `https://<your-worker>.workers.dev`）
- `GET /api/portfolio`: 保有銘柄の一覧を返す。
- `POST /api/portfolio` JSON: `{symbol, shares, currency, company_name?}` を upsert。
- `DELETE /api/portfolio?symbol=XXXX`: 保有銘柄を削除。
- `GET /api/quotes_new`: 価格・通貨・更新時刻に加え、`price_1d/1m/1y` と各 `_at` を返す（null にならないよう補完）。
- `POST /api/quotes/refresh`:
  - Yahoo Finance から現在値とベースラインを更新（自動で `USDJPY=X` も含む）。
  - オプション: `?symbols=AAPL,7203.T` で対象銘柄を指定、`&dry=1` で書き込まずサンプル返却。
- `GET /api/portfolio_with_prices`: holdings × quotes_new を結合し、JPY換算も含めて返す。
- `GET /api/debug/yahoo?symbols=...`: Yahoo 到達性の簡易チェック。

備考
- 取得は Yahoo のみ。Stooq フォールバックは廃止しました。
- Worker のリクエストは Firefox の UA、`Accept-Language: ja,...`、`Referer: https://finance.yahoo.com/` を付加します。
- ベースラインは Yahoo Chart API（日足2年）から推定し、欠損時も `price/last` で補完します。

# stock

このリポジトリは静的なポートフォリオレポートを提供する Web アプリです。`report.html` をブラウザで開くと、Yahoo Finance から最新株価や USD/JPY 為替レートを取得し、表を更新します。CORS 回避やベースラインの堅牢化が必要な場合は上記の Cloudflare Workers API を利用できます。PWA 対応のため、ホーム画面に追加してオフラインでも利用できます。

## ファイル構成
- `report.html` — メインのページ
- `report_db.html` — DBから読み込むポートフォリオ（アクセス時に現在価格を更新）
- `service-worker.js` — オフライン用の Service Worker
- `manifest.webmanifest` — PWA 用マニフェスト
- `proxy/worker.js` — Cloudflare Workers 用プロキシ API (任意)
- `portfolio.html` — API から取得したポートフォリオを表示する簡易ページ


## 使い方
1. GitHub Pages など任意の静的ホスティングに本リポジトリを配置します。
2. `report.html` をブラウザで開くだけで最新価格が表示されます。
3. CORS 回避や D1 連携を使う場合は Cloudflare Workers に `proxy/worker.js` をデプロイし、`report_db.html?api=https://<your-worker>.workers.dev` のように `api` クエリで指定します。

## PWA とオフライン
- HTTPS で配信すると Service Worker が有効になり、`report.html` をオフラインでも表示できます。
- ホーム画面に追加することでアプリ風に利用できます。
