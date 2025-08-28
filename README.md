**概要**
- ポートフォリオCSVを読み込み、現在価格で評価額を計算し、メール通知します。
- 価格取得は Alpha Vantage API を使用します（無料枠は分間5件/日500件）。

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
- 設定ファイルを作成:
  - `cp config.json config.json`（既にある場合は編集のみ）
  - `config.json` を編集（SMTPや宛先、Alpha Vantage APIキーを設定）
- ポートフォリオCSVを作成:
  - 既存の `portfolio.csv` を編集
  - ヘッダは `symbol,shares`（任意で `currency` を追加）
  - 例: `AAPL,10,USD` / `7203.T,5,JPY`
- 機密情報は環境変数でも上書き可能:
  - `PN_ALPHA_VANTAGE_KEY` … Alpha Vantage APIキー
  - `PN_EMAIL_USERNAME` … SMTPユーザー名
  - `PN_EMAIL_PASSWORD` … SMTPパスワード（例: Gmailのアプリパスワード）

**実行**
- 標準出力のみ（メール送信なし）:
  - `python3 portfolio_notify.py --no-email`
- 通常実行（メール送信あり）:
  - `python3 portfolio_notify.py --config config.json --portfolio portfolio.csv`

**混在ポートフォリオ（米国株+日本株）**
- `portfolio.csv` に `currency` 列を追加すると、銘柄ごとに通貨を指定できます（`USD` または `JPY`）。
- レポートは以下の列順で表示します:
  - `SYMBOL`, `SHARES`, `USD_PRICE`, `USD_VALUE`, `JPY_PRICE`, `JPY_VALUE`
- 為替レートは Alpha Vantage の `CURRENCY_EXCHANGE_RATE` を使用（USD→JPYを1回取得）。
- 注意: 現状サポート通貨は USD/JPY のみです。

**メール設定のヒント**
- Gmailの場合:
  - `smtp_host`: `smtp.gmail.com`
  - `smtp_port`: `465`
  - 2段階認証を有効化し、アプリパスワードを発行して `password` に設定

**価格プロバイダ**
- 既定は `yfinance`（APIキー不要）。`config.json` の `price_provider.type` を `"yfinance"` にするか、未指定なら自動で `yfinance` を使用します。
- Alpha Vantageを使う場合は `price_provider.type` を `"alpha_vantage"` にし、APIキーを設定してください（レート制限あり）。

**自動実行（cronの例）**
- 毎営業日 16:30 に実行してメール送信:
  - `crontab -e`
  - 例: `30 16 * * 1-5 PN_ALPHA_VANTAGE_KEY=... PN_EMAIL_USERNAME=... PN_EMAIL_PASSWORD=... /usr/bin/python3 /path/to/portfolio_notify.py --config /path/to/config.json --portfolio /path/to/portfolio.csv`

**制限・拡張**
- 現在は通貨換算を行わず、各銘柄のクォート通貨で集計します（USD等）。
- メール送信はSMTPに対応。別のプロバイダを希望の場合は相談ください。

**iPhoneでアプリ風に使う（Mac不要・PWA）**
- このリポジトリは `report.html` をPWA対応済みです（`manifest.webmanifest`, `service-worker.js` 追加）。
- GitHub Pages等でHTTPS配信すると、iPhoneのSafariからホーム画面に追加してアプリ風に利用できます。
- 手順:
  - リポジトリをGitHubへプッシュ → Settings > Pages でデプロイ（Branch: `main`, Folder: `/`）。
  - iPhoneのSafariで `https://<yourname>.github.io/<repo>/report.html` を開く。
  - 共有メニュー > 「ホーム画面に追加」。
- オフライン: HTTPS配信時にservice workerが有効になり、`report.html` はオフラインでも開けます。追加でキャッシュしたいファイルがあれば `service-worker.js` の `PRECACHE_URLS` に追記してください。
- アイコン: iOSのホームアイコンをカスタムしたい場合は `icons/apple-touch-icon.png` を用意し、`report.html` の `apple-touch-icon` リンク先に置いてください（未設定でも動作します）。
- 自動更新: ページ表示時・復帰時にYahoo Financeの公開エンドポイントから最新株価（および `USDJPY=X`）を取得し、表の `USD_PRICE/JPY_PRICE/…_VALUE` を更新します。ネットワークやCORSで失敗した場合、右上の「更新」ボタンから再試行できます。
  - CORS対策: Yahooがブロックされた場合は自動で Stooq（`stooq.com`）にフォールバックします（USは `*.us`、東証は `.T`→`*.jp` で取得、為替は `usdjpy`）。一部銘柄は取得できない可能性があります。
# stock
