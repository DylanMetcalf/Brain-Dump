import SwiftUI
import WebKit
import BackgroundTasks

@main
struct BrainDumpApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel.shared
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            BrainWebView(model: model)
                .ignoresSafeArea()
                .background(Color("LaunchBackground"))
                .onOpenURL { model.open(url: $0) }
                .onContinueUserActivity("app.braindump.talk") { _ in model.open(route: "talk") }
        }
        .onChange(of: phase) { _, p in
            if p == .active { model.becameActive() }
            if p == .background { Background.schedule() }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Background.register()
        // Siri, Spotlight and the Shortcuts app learn Brain Dump's actions from the app itself.
        BrainDumpShortcuts.updateAppShortcutParameters()
        return true
    }
}

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()
    let bridge = Bridge()
    private weak var web: WKWebView?

    init() {
        NotificationCenter.default.addObserver(forName: .brainDumpOpenRoute, object: nil, queue: .main) { note in
            Task { @MainActor in AppModel.shared.open(route: note.object as? String ?? "talk") }
        }
    }

    func attach(_ web: WKWebView) {
        self.web = web
        bridge.web = web
    }

    func open(url: URL) {
        guard url.scheme == "braindump" else { return }
        open(route: url.host ?? "talk")
    }

    /// Open a screen; "talk" also starts listening, as if she'd tapped the button.
    func open(route: String) {
        Shared.pendingRoute = nil
        let safe = ["talk", "chat", "home", "health", "setup"].contains(route) ? route : "talk"
        let js = safe == "talk"
            ? "location.hash = '#talk'; setTimeout(function(){ var o = document.getElementById('orb'); if (o && !o.classList.contains('listening')) o.click(); }, 500);"
            : "location.hash = '#\(safe)';"
        web?.evaluateJavaScript(js)
    }

    func becameActive() {
        if let r = Shared.pendingRoute { open(route: r) }
        Task {
            await DeviceAgent.shared.runOutbox()
            await DeviceAgent.shared.syncCalendar()
            await DeviceAgent.shared.refreshWidget()
        }
    }
}

/// Keeps the phone's apps in step even when Brain Dump isn't open (as often as iOS allows).
enum Background {
    static let id = "app.braindump.refresh"

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: id, using: nil) { task in
            guard let task = task as? BGAppRefreshTask else { return }
            schedule()
            let work = Task { @MainActor in
                await DeviceAgent.shared.runOutbox()
                await DeviceAgent.shared.syncCalendar()
                await DeviceAgent.shared.refreshWidget()
                task.setTaskCompleted(success: true)
            }
            task.expirationHandler = { work.cancel() }
        }
    }

    static func schedule() {
        let req = BGAppRefreshTaskRequest(identifier: id)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 20 * 60)
        try? BGTaskScheduler.shared.submit(req)
    }
}
