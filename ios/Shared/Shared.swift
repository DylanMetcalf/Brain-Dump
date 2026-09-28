import Foundation
import AppIntents

/// Things the app, its Siri actions and the widget share.
enum Shared {
    /// Set per build from BD_APP_GROUP (Info.plist BDAppGroup), so each Apple account can use its own.
    static let group = (Bundle.main.object(forInfoDictionaryKey: "BDAppGroup") as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "group.app.braindump"
    static var defaults: UserDefaults { UserDefaults(suiteName: group) ?? .standard }
    static let talkURL = URL(string: "braindump://talk")!
    static let chatURL = URL(string: "braindump://chat")!

    /// What the widget shows. Written by the app after it talks to Brain Dump; no token is shared.
    struct Snapshot: Codable {
        var next: String?
        var nextTime: Date?
        var needs: Int
        var updated: Date
    }

    static func save(_ s: Snapshot) {
        if let data = try? JSONEncoder().encode(s) { defaults.set(data, forKey: "snapshot") }
    }

    static func snapshot() -> Snapshot? {
        guard let data = defaults.data(forKey: "snapshot") else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }

    /// Set by an intent that opens the app ("talk" or "chat"); the app picks it up when it becomes active.
    static var pendingRoute: String? {
        get { defaults.string(forKey: "pendingRoute") }
        set { defaults.set(newValue, forKey: "pendingRoute") }
    }
}

extension Notification.Name {
    static let brainDumpOpenRoute = Notification.Name("BrainDumpOpenRoute")
}

/// "Start Brain Dump": opens Brain Dump listening. Used by Siri, Shortcuts, the Action Button,
/// the Lock Screen / Control Centre control and the widget.
struct StartBrainDumpIntent: AppIntent {
    static var title: LocalizedStringResource = "Start Brain Dump"
    static var description = IntentDescription("Open Brain Dump and start listening.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        Shared.pendingRoute = "talk"
        NotificationCenter.default.post(name: .brainDumpOpenRoute, object: "talk")
        return .result()
    }
}

/// "Start Conversation": opens the chat.
struct StartConversationIntent: AppIntent {
    static var title: LocalizedStringResource = "Start Conversation"
    static var description = IntentDescription("Open the Brain Dump chat.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        Shared.pendingRoute = "chat"
        NotificationCenter.default.post(name: .brainDumpOpenRoute, object: "chat")
        return .result()
    }
}
