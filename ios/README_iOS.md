## iOS版（SwiftUI + WKWebView）

以下の手順で、このリポジトリの `report.html` と同じ見た目のiPhoneアプリを動かせます。

### セットアップ手順

1. Xcodeを開き、`File > New > Project...` から iOS の `App` を選択して新規作成。
   - Product Name: `PortfolioReportApp`
   - Interface: `SwiftUI`
   - Language: `Swift`
2. プロジェクト作成後、Xcodeのナビゲータで自動生成された `PortfolioReportApp.swift` と `ContentView.swift` を削除し、
   このリポジトリ内の `ios/PortfolioReportApp/PortfolioReportApp.swift` と `ios/PortfolioReportApp/ContentView.swift`、`ios/PortfolioReportApp/WebView.swift` をドラッグ＆ドロップで追加（"Copy items if needed" にチェック、ターゲットに追加）。
3. 同様に、リポジトリ直下の `report.html` をプロジェクトにドラッグ＆ドロップしてバンドルに含めます（"Copy items if needed" にチェック、ターゲットに追加）。
4. シミュレータまたは実機で実行します。

これでアプリ内の `WKWebView` が `report.html` を読み込み、ブラウザと同等の見た目・並べ替え動作（HTML内のJavaScript）を再現します。

### 備考

- 画面スケーリング: アプリ側でビューポートメタを初回描画前に注入するため、モバイルで見やすい縮尺になります。
- 外部リソース: `report.html` が外部CSS/JSに依存している場合は、それらも同様にプロジェクトへ追加し、相対パスで参照されるようにしてください。
- レイアウト: HTMLが横スクロールテーブルを含むため、`WKWebView` で自然に横スクロールできます。

### ネイティブUI化する場合の方針（オプション）

- データ読み込み: `portfolio.csv` や計算済みのJSONを読み込み、モデルをSwiftで定義。
- UI: `ScrollView` + `LazyVStack`（または `Grid`）でテーブル風のレイアウトを作成。
- 並べ替え: ヘッダータップで昇順/降順をトグルし、`@State` で並べ替えキーを保持。
- フォーマット: 通貨・パーセンテージ表示をFormatterで統一。

必要であれば、このネイティブ実装もこちらで続けて実装します。希望の並べ替えルールや強調色などを教えてください。
