import SwiftUI
import WebKit

struct WebView: UIViewRepresentable {
    let htmlFile: String // without .html extension

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.bounces = true
        webView.allowsBackForwardNavigationGestures = false
        loadHTML(into: webView)
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        // no-op
    }

    private func loadHTML(into webView: WKWebView) {
        // Try loading bundled report.html and inject viewport before first layout
        guard let url = Bundle.main.url(forResource: htmlFile, withExtension: "html") else {
            let html = """
            <html><head><meta name='viewport' content='width=device-width, initial-scale=1'>
            <style>body{font-family:-apple-system,sans-serif;padding:16px;color:#444}</style></head>
            <body><h3>report.html not found</h3><p>Add report.html to the app bundle.</p></body></html>
            """
            webView.loadHTMLString(html, baseURL: nil)
            return
        }

        if let data = try? Data(contentsOf: url), var html = String(data: data, encoding: .utf8) {
            if !html.lowercased().contains("name='viewport'") && !html.lowercased().contains("name=\"viewport\"") {
                // inject viewport meta into <head>
                if let range = html.range(of: "<head>", options: .caseInsensitive) {
                    let injection = "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover\">"
                    html.replaceSubrange(range, with: "<head>\n\(injection)\n")
                } else {
                    // no explicit head; prepend
                    let injection = "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover\">"
                    html = "<head>\n\(injection)\n</head>\n" + html
                }
            }
            webView.loadHTMLString(html, baseURL: url.deletingLastPathComponent())
        } else {
            // Fallback to file URL load
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
    }
}
