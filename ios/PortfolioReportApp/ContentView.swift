import SwiftUI

struct ContentView: View {
    var body: some View {
        NavigationStack {
            WebView(htmlFile: "report")
                .navigationTitle("Portfolio")
                .navigationBarTitleDisplayMode(.inline)
        }
    }
}

#Preview {
    ContentView()
}

