import SwiftUI
import WebKit
import UIKit

/// Brain Dump's screens (the same ones as the web app), with a bridge to the phone.
struct BrainWebView: UIViewRepresentable {
    @ObservedObject var model: AppModel

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default()
        let controller = WKUserContentController()
        let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        controller.addUserScript(WKUserScript(source: "window.BrainDumpNative = { version: '\(appVersion)' };", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(WeakHandler(model.bridge), name: "brainDump")
        config.userContentController = controller

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.isOpaque = false
        web.backgroundColor = UIColor(named: "LaunchBackground")
        if #available(iOS 16.4, *) { web.isInspectable = true }
        model.attach(web)
        web.load(URLRequest(url: BrainDumpAPI.server))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        /// Brain Dump pages stay inside; WhatsApp, calls, Messages, Mail, Spotify, Maps… open their own apps.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.allow) }
            let ours = url.host == BrainDumpAPI.server.host || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data"
            // Google sign-in happens inside, then comes back to Brain Dump.
            let signIn = url.host?.hasSuffix("accounts.google.com") == true
            if ours || signIn { return decisionHandler(.allow) }
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url { UIApplication.shared.open(url) }
            return nil
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showOffline(webView) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showOffline(webView) }

        private func showOffline(_ web: WKWebView) {
            let html = """
            <meta name=viewport content="width=device-width,initial-scale=1"><body style="font:17px -apple-system;padding:40px 24px;color:#121513;background:#fff">
            <h2>Can’t reach Brain Dump</h2><p style="color:#6a716b">Check your connection. I’ll try again when you tap below.</p>
            <p><a href="\(BrainDumpAPI.server.absoluteString)" style="color:#4d6a47;font-weight:600">Try again</a></p></body>
            """
            web.loadHTMLString(html, baseURL: BrainDumpAPI.server)
        }
    }
}

/// Avoids a retain cycle between WKUserContentController and the bridge.
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: (NSObject & WKScriptMessageHandler)?
    init(_ target: NSObject & WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(c, didReceive: message)
    }
}
