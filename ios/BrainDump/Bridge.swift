import Foundation
import WebKit
import UIKit
import AppIntents

/// The page asks; the phone answers. Every method here is something the page can't do on
/// its own: permissions, Calendar/Reminders/alarms, Contacts, speech, App Intents.
@MainActor
final class Bridge: NSObject, WKScriptMessageHandler {
    weak var web: WKWebView?

    override init() {
        super.init()
        SpeechController.shared.emit = { [weak self] name, data in self?.emit(name, data) }
    }

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let id = body["id"] as? Int, let method = body["method"] as? String else { return }
        let args = body["args"] as? [String: Any] ?? [:]
        Task { @MainActor in
            do {
                let result = try await handle(method, args)
                reply(id, ok: true, result)
            } catch {
                reply(id, ok: false, error.localizedDescription)
            }
        }
    }

    private func handle(_ method: String, _ args: [String: Any]) async throws -> Any {
        let agent = DeviceAgent.shared
        switch method {
        case "capabilities": return await agent.capabilities()
        case "requestPermission": return await agent.request(args["name"] as? String ?? "")
        case "openSettings":
            if let url = URL(string: UIApplication.openSettingsURLString) { await UIApplication.shared.open(url) }
            return true
        case "setSession":
            BrainDumpAPI.setSession(token: args["token"] as? String ?? "", server: args["server"] as? String ?? "")
            Task { await agent.refreshWidget() }
            return true
        case "runOutbox":
            let r = await agent.runOutbox()
            Task { await agent.refreshWidget() }
            return r
        case "syncCalendar": return await agent.syncCalendar()
        case "probe": return await agent.probe(args["name"] as? String ?? "")
        case "findContact": return agent.findContact(args["name"] as? String ?? "")
        case "registerShortcuts":
            BrainDumpShortcuts.updateAppShortcutParameters()
            return true
        case "intents":
            return BrainDumpShortcuts.catalogue
        case "startListening":
            try await SpeechController.shared.start(lang: args["lang"] as? String ?? (Locale.preferredLanguages.first ?? "en-GB"))
            return true
        case "stopListening":
            SpeechController.shared.stop(discard: args["discard"] as? Bool ?? false)
            return true
        case "speak":
            await SpeechController.shared.speak(args["text"] as? String ?? "")
            return true
        case "stopSpeaking":
            SpeechController.shared.stopSpeaking()
            return true
        case "share":
            share(args["text"] as? String ?? "")
            return true
        default:
            throw NSError(domain: "BrainDump", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unknown request \(method)."])
        }
    }

    private func reply(_ id: Int, ok: Bool, _ value: Any) {
        let json = Self.json(value)
        web?.evaluateJavaScript("window.__bdNativeReply && window.__bdNativeReply(\(id), \(ok), \(json))")
    }

    func emit(_ name: String, _ data: [String: Any]) {
        web?.evaluateJavaScript("window.__bdNativeEvent && window.__bdNativeEvent(\(Self.json(name)), \(Self.json(data)))")
    }

    private static func json(_ v: Any) -> String {
        if let data = try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed]), let s = String(data: data, encoding: .utf8) { return s }
        return "null"
    }

    private func share(_ text: String) {
        guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first?.rootViewController else { return }
        root.present(UIActivityViewController(activityItems: [text], applicationActivities: nil), animated: true)
    }
}
