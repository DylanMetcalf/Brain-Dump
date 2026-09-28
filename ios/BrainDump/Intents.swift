import AppIntents
import Foundation

// Brain Dump's capabilities, declared to iOS. Once the app is installed they appear in Siri,
// Spotlight, the Shortcuts app, the Action Button and Control Centre on their own — nothing
// to build. Each one is a thin entry point: the intelligence stays in Brain Dump.

/// "Hey Siri, brain dump" → "What's on your mind?" → anything, however it comes out.
struct CaptureThoughtIntent: AppIntent {
    static var title: LocalizedStringResource = "Capture Thought"
    static var description = IntentDescription("Tell Brain Dump anything. It sorts it out and handles it.")

    @Parameter(title: "Thought", requestValueDialog: "What’s on your mind?")
    var text: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let reply = try await BrainDumpAPI.say(text)
        return .result(dialog: "\(reply)")
    }
}

/// A question rather than a thought ("When's my dentist?").
struct AskBrainDumpIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask Brain Dump"
    static var description = IntentDescription("Ask Brain Dump a question about your plans, reminders or anything you’ve told it.")

    @Parameter(title: "Question", requestValueDialog: "What would you like to know?")
    var question: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let reply = try await BrainDumpAPI.say(question)
        return .result(dialog: "\(reply)")
    }
}

struct WhatsNextIntent: AppIntent {
    static var title: LocalizedStringResource = "What’s Next?"
    static var description = IntentDescription("Hear what’s coming up next.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let o = try await BrainDumpAPI.call("/api/overview")
        let upcoming = (o["upcoming"] as? [[String: Any]]) ?? []
        guard !upcoming.isEmpty else { return .result(dialog: "Nothing coming up in the next week.") }
        let lines = upcoming.prefix(3).map { "\($0["title"] as? String ?? "Something") \($0["when"] as? String ?? "")" }
        return .result(dialog: "\(lines.joined(separator: ". Then "))")
    }
}

struct WhatNeedsMeIntent: AppIntent {
    static var title: LocalizedStringResource = "What Needs Me?"
    static var description = IntentDescription("Only the things genuinely waiting on you.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let o = try await BrainDumpAPI.call("/api/overview")
        let text = ((o["needsMe"] as? [String: Any])?["text"] as? String) ?? "Nothing needs you right now."
        return .result(dialog: "\(text)")
    }
}

struct WhatDidYouHandleIntent: AppIntent {
    static var title: LocalizedStringResource = "What Did You Handle?"
    static var description = IntentDescription("What Brain Dump has done for you today, verified.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let o = try await BrainDumpAPI.call("/api/overview")
        let text = (o["handledToday"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Nothing yet today."
        return .result(dialog: "\(text)")
    }
}

struct AddReminderIntent: AppIntent {
    static var title: LocalizedStringResource = "Add Reminder"
    static var description = IntentDescription("Add a reminder through Brain Dump (it also goes into Reminders).")

    @Parameter(title: "Reminder", requestValueDialog: "What should I remind you about?")
    var text: String

    @Parameter(title: "When")
    var when: Date?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        var body: [String: Any] = ["text": text]
        if let when {
            let d = DateFormatter()
            d.dateFormat = "yyyy-MM-dd"
            let t = DateFormatter()
            t.dateFormat = "HH:mm"
            body["date"] = d.string(from: when)
            body["time"] = t.string(from: when)
        }
        let r = try await BrainDumpAPI.call("/api/create/reminder", method: "POST", body: body)
        await DeviceAgent.shared.runOutbox()
        return .result(dialog: "\(r["message"] as? String ?? "Added.")")
    }
}

struct CheckCalendarIntent: AppIntent {
    static var title: LocalizedStringResource = "Check Calendar"
    static var description = IntentDescription("Ask Brain Dump what’s in your calendar.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        await DeviceAgent.shared.syncCalendar()
        let reply = try await BrainDumpAPI.say("What’s on this week?")
        return .result(dialog: "\(reply)")
    }
}

struct BrainDumpStatusIntent: AppIntent {
    static var title: LocalizedStringResource = "Brain Dump Status"
    static var description = IntentDescription("Check that everything Brain Dump is connected to is working.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        _ = try? await BrainDumpAPI.call("/api/device/caps", method: "POST", body: await DeviceAgent.shared.capabilities())
        let h = try await BrainDumpAPI.call("/api/health/integrations")
        let problems = (h["problems"] as? [[String: Any]]) ?? []
        if problems.isEmpty { return .result(dialog: "Everything’s working.") }
        let first = problems[0]
        let more = problems.count > 1 ? " And \(problems.count - 1) more in Brain Dump’s Health screen." : ""
        return .result(dialog: "\(first["message"] as? String ?? "Something needs you.")\(more)")
    }
}

/// Phrases Siri understands out of the box. Each must include the app's name.
struct BrainDumpShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: CaptureThoughtIntent(), phrases: [
            "\(.applicationName)",
            "Brain dump in \(.applicationName)",
            "Tell \(.applicationName) something",
            "Capture a thought in \(.applicationName)",
        ], shortTitle: "Capture Thought", systemImageName: "brain.head.profile")
        AppShortcut(intent: StartBrainDumpIntent(), phrases: [
            "Start \(.applicationName)",
            "Talk to \(.applicationName)",
        ], shortTitle: "Start Brain Dump", systemImageName: "mic")
        AppShortcut(intent: WhatsNextIntent(), phrases: [
            "What’s next in \(.applicationName)",
            "Ask \(.applicationName) what’s next",
        ], shortTitle: "What’s Next", systemImageName: "calendar")
        AppShortcut(intent: WhatNeedsMeIntent(), phrases: [
            "What needs me in \(.applicationName)",
            "Ask \(.applicationName) what needs me",
        ], shortTitle: "What Needs Me", systemImageName: "exclamationmark.circle")
        AppShortcut(intent: WhatDidYouHandleIntent(), phrases: [
            "What did \(.applicationName) handle",
            "What has \(.applicationName) done today",
        ], shortTitle: "What You Handled", systemImageName: "checkmark.circle")
        AppShortcut(intent: AddReminderIntent(), phrases: [
            "Add a reminder in \(.applicationName)",
            "Remind me with \(.applicationName)",
        ], shortTitle: "Add Reminder", systemImageName: "bell")
        AppShortcut(intent: AskBrainDumpIntent(), phrases: [
            "Ask \(.applicationName) a question",
        ], shortTitle: "Ask Brain Dump", systemImageName: "questionmark.bubble")
        AppShortcut(intent: CheckCalendarIntent(), phrases: [
            "Check my calendar in \(.applicationName)",
        ], shortTitle: "Check Calendar", systemImageName: "calendar.badge.clock")
        AppShortcut(intent: StartConversationIntent(), phrases: [
            "Chat with \(.applicationName)",
        ], shortTitle: "Start Conversation", systemImageName: "bubble.left.and.bubble.right")
        AppShortcut(intent: BrainDumpStatusIntent(), phrases: [
            "\(.applicationName) status",
        ], shortTitle: "Status", systemImageName: "heart.text.square")
    }

    /// For Settings → Advanced: what Siri and Shortcuts can do with Brain Dump.
    static let catalogue: [[String: String]] = [
        ["title": "Capture Thought", "phrase": "“Hey Siri, brain dump in Brain Dump”"],
        ["title": "Start Brain Dump", "phrase": "“Hey Siri, talk to Brain Dump”"],
        ["title": "What’s Next?", "phrase": "“Hey Siri, what’s next in Brain Dump”"],
        ["title": "What Needs Me?", "phrase": "“Hey Siri, what needs me in Brain Dump”"],
        ["title": "What Did You Handle?", "phrase": "“Hey Siri, what did Brain Dump handle”"],
        ["title": "Add Reminder", "phrase": "“Hey Siri, add a reminder in Brain Dump”"],
        ["title": "Ask Brain Dump", "phrase": "“Hey Siri, ask Brain Dump a question”"],
        ["title": "Check Calendar", "phrase": "“Hey Siri, check my calendar in Brain Dump”"],
        ["title": "Start Conversation", "phrase": "“Hey Siri, chat with Brain Dump”"],
        ["title": "Brain Dump Status", "phrase": "“Hey Siri, Brain Dump status”"],
    ]
}
