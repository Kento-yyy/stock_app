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
- 自動更新: ページ表示時・復帰時にYahoo Financeの公開エンドポイントから最新株価および `USDJPY=X` を取得し、表の `USD_PRICE/JPY_PRICE/…_VALUE` を更新します。ネットワークやCORSで失敗した場合、右上の「更新」ボタンから再試行できます。
  - CORS対策: Yahooがブロックされた場合は自動で Stooq（`stooq.com`）にフォールバックします（USは `*.us`、東証は `.T`→`*.jp` で取得、為替は `usdjpy`）。一部銘柄は取得できない可能性があります。

### CORSで失敗する場合の確実策（Cloudflare Workers 代理API）

1. Cloudflareのアカウントを作成し、Workers（無料枠）で新規Workerを作成。
2. `proxy/worker.js` の内容をCloudflare Workersに貼り付けてデプロイ。
   - エンドポイントは例: `https://your-subdomain.workers.dev/quote`（GET, `?symbols=AAPL,8306.T,USDJPY=X`）
3. `report.html` にクエリでAPIを指定してアクセス:
   - 例: `https://<yourname>.github.io/<repo>/report.html?api=https://your-subdomain.workers.dev/quote`
   - またはページ内で `localStorage.PF_API_BASE = 'https://your-subdomain.workers.dev/quote'` を一度設定。

この代理APIはCORSヘッダを付け、Yahoo→Stooqの順に取得してJSONを返します。レスポンスは60秒程度キャッシュされます。

**代理APIのレスポンスについて（DoD/MoM/YoY対応）**
- `quotes[SYMBOL]` には下記の代表フィールドが含まれます:
  - `regularMarketPrice`: 現在値（元通貨）
  - `currency`: 通貨コード（`USD`/`JPY` など）
  - `prevClose`: 前日終値（元通貨）
  - `prevClose30d`/`prevClose365d`: 約30日前/365日前の基準終値（元通貨）
  - `jpy`: 現在値のJPY換算（`.T` はそのまま、その他は現在のUSDJPYで近似換算）
  - `prevJpy`/`prevJpy30d`/`prevJpy365d`: 上記基準値のJPY換算（近似）
  - 変化率（小数、例: `0.045` は +4.5%）
    - `usdDoD` / `usdMoM` / `usdYoY`
    - `jpyDoD` / `jpyMoM` / `jpyYoY`

注意: USD資産のJPY側の基準値は「現在の為替」で近似換算しているため、過去時点の為替を厳密に反映した変化率ではありません（比率は換算係数が同じためUSD/JPYとも同一になります）。

# stock

このリポジトリは静的なポートフォリオレポートを提供する Web アプリです。`report.html` をブラウザで開くと、Yahoo Finance または Stooq から最新株価や USD/JPY 為替レートを取得し、表を更新します。PWA 対応のため、ホーム画面に追加してオフラインでも利用できます。

## ファイル構成
- `report.html` — メインのページ
- `service-worker.js` — オフライン用の Service Worker
- `manifest.webmanifest` — PWA 用マニフェスト
- `proxy/worker.js` — Cloudflare Workers 用プロキシ API (任意)
- `portfolio.html` — API から取得したポートフォリオを表示する簡易ページ


## 使い方
1. GitHub Pages など任意の静的ホスティングに本リポジトリを配置します。
2. `report.html` をブラウザで開くだけで最新価格が表示されます。
3. CORS 回避が必要な場合は Cloudflare Workers に `proxy/worker.js` をデプロイし、`report.html?api=https://your-subdomain.workers.dev/quote` のように `api` クエリで指定します。

## PWA とオフライン
- HTTPS で配信すると Service Worker が有効になり、`report.html` をオフラインでも表示できます。
- ホーム画面に追加することでアプリ風に利用できます。

