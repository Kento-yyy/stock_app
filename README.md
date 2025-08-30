# stock

このリポジトリは静的なポートフォリオレポートを提供する Web アプリです。`report.html` をブラウザで開くと、Yahoo Finance または Stooq から最新株価や USD/JPY 為替レートを取得し、表を更新します。PWA 対応のため、ホーム画面に追加してオフラインでも利用できます。

## ファイル構成
- `report.html` — メインのページ
- `service-worker.js` — オフライン用の Service Worker
- `manifest.webmanifest` — PWA 用マニフェスト
- `proxy/worker.js` — Cloudflare Workers 用プロキシ API (任意)

## 使い方
1. GitHub Pages など任意の静的ホスティングに本リポジトリを配置します。
2. `report.html` をブラウザで開くだけで最新価格が表示されます。
3. CORS 回避が必要な場合は Cloudflare Workers に `proxy/worker.js` をデプロイし、`report.html?api=https://your-subdomain.workers.dev/quote` のように `api` クエリで指定します。

## PWA とオフライン
- HTTPS で配信すると Service Worker が有効になり、`report.html` をオフラインでも表示できます。
- ホーム画面に追加することでアプリ風に利用できます。
