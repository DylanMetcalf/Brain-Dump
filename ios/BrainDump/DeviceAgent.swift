import Foundation
import EventKit
import Contacts
import AVFoundation
import Speech
import UserNotifications
import UIKit
import WidgetKit
#if canImport(AlarmKit)
import AlarmKit
#endif

/// The phone's side of Brain Dump. Brain Dump decides; this carries out plain operations in
/// the phone's own apps (Calendar, Reminders, alarms), reads each result back to verify it,
/// and reports what really happened. It also shares the calendar so Brain Dump can find and
/// manage her real events. Contacts are looked up here and never uploaded wholesale.
@MainActor
final class DeviceAgent {
    static let shared = DeviceAgent()
    let store = EKEventStore()
    private var running = false

    private init() {
        NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.calendarChanged() }
        }
    }

    // MARK: Capabilities (device permissions, reported to the orchestrator)

    static var alarmKitAvailable: Bool {
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) { return true }
        #endif
        return false
    }

    func capabilities() async -> [String: Any] {
        var features = ["voice-input", "app-intents", "widgets", "eventkit", "contacts", "share-sheet", "speech-synthesis"]
        if #available(iOS 18.0, *) { features.append("control-widgets") }
        if Self.alarmKitAvailable { features.append("alarmkit") }
        return [
            "shell": "ios",
            "platform": UIDevice.current.userInterfaceIdiom == .pad ? "ipados" : "ios",
            "osVersion": UIDevice.current.systemVersion,
            "appVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0",
            "standalone": true,
            "permissions": await permissions(),
            "features": features,
        ]
    }

    func permissions() async -> [String: String] {
        var p: [String: String] = [:]
        p["calendar"] = Self.ek(EKEventStore.authorizationStatus(for: .event))
        p["reminders"] = Self.ek(EKEventStore.authorizationStatus(for: .reminder))
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized: p["contacts"] = "granted"
        case .denied, .restricted: p["contacts"] = "denied"
        case .notDetermined: p["contacts"] = "prompt"
        default: p["contacts"] = "limited"
        }
        switch AVAudioApplication.shared.recordPermission {
        case .granted: p["microphone"] = "granted"
        case .denied: p["microphone"] = "denied"
        default: p["microphone"] = "prompt"
        }
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: p["speech"] = "granted"
        case .denied, .restricted: p["speech"] = "denied"
        default: p["speech"] = "prompt"
        }
        let n = await UNUserNotificationCenter.current().notificationSettings()
        switch n.authorizationStatus {
        case .authorized, .provisional, .ephemeral: p["notifications"] = "granted"
        case .denied: p["notifications"] = "denied"
        default: p["notifications"] = "prompt"
        }
        p["alarms"] = alarmPermission()
        return p
    }

    private static func ek(_ s: EKAuthorizationStatus) -> String {
        switch s {
        case .fullAccess: return "granted"
        case .writeOnly: return "limited"
        case .denied, .restricted: return "denied"
        case .notDetermined: return "prompt"
        default: return "granted"
        }
    }

    private func alarmPermission() -> String {
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            switch AlarmManager.shared.authorizationState {
            case .authorized: return "granted"
            case .denied: return "denied"
            default: return "prompt"
            }
        }
        #endif
        return "unsupported"
    }

    /// Ask the platform. Only ever called from something she tapped.
    func request(_ name: String) async -> String {
        switch name {
        case "calendar": _ = try? await store.requestFullAccessToEvents()
        case "reminders": _ = try? await store.requestFullAccessToReminders()
        case "contacts": _ = try? await CNContactStore().requestAccess(for: .contacts)
        case "microphone":
            _ = await AVAudioApplication.requestRecordPermission()
            if SFSpeechRecognizer.authorizationStatus() == .notDetermined { _ = await SpeechController.requestSpeechAuthorization() }
        case "speech": _ = await SpeechController.requestSpeechAuthorization()
        case "notifications": _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        case "alarms":
            #if canImport(AlarmKit)
            if #available(iOS 26.0, *) { _ = try? await AlarmManager.shared.requestAuthorization() }
            #endif
        default: break
        }
        let p = await permissions()
        if name == "microphone", p["speech"] == "denied" { return "denied" }
        return p[name] ?? "unsupported"
    }

    // MARK: Probes (a real read, for the setup test)

    func probe(_ name: String) async -> [String: Any] {
        switch name {
        case "calendar":
            guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { return ["ok": false, "error": "Calendar access is off."] }
            let now = Date()
            let events = store.events(matching: store.predicateForEvents(withStart: now, end: now.addingTimeInterval(7 * 86400), calendars: nil))
            return ["ok": true, "detail": events.isEmpty ? "Connected — your week looks clear." : "Connected — I can see \(events.count) event\(events.count == 1 ? "" : "s") this week."]
        case "reminders":
            guard EKEventStore.authorizationStatus(for: .reminder) == .fullAccess else { return ["ok": false, "error": "Reminders access is off."] }
            let lists = store.calendars(for: .reminder)
            return ["ok": true, "detail": "Connected — found \(lists.count) Reminders list\(lists.count == 1 ? "" : "s")."]
        case "contacts":
            guard CNContactStore.authorizationStatus(for: .contacts) == .authorized else { return ["ok": false, "error": "Contacts access is off."] }
            return ["ok": true, "detail": "Connected — looked up on your phone only."]
        case "alarms":
            return ["ok": alarmPermission() != "denied", "detail": Self.alarmKitAvailable ? "Real alarms and timers." : "Loud notifications (real alarms need iOS 26)."]
        default:
            return ["ok": true]
        }
    }

    // MARK: Carry out what Brain Dump decided

    /// Fetch the queue, do each operation, verify it, report results. Returns counts.
    @discardableResult
    func runOutbox() async -> [String: Int] {
        guard !running, BrainDumpAPI.token != nil else { return ["done": 0, "failed": 0] }
        running = true
        defer { running = false }
        guard let r = try? await BrainDumpAPI.call("/api/phone/outbox"), let items = r["items"] as? [[String: Any]], !items.isEmpty else {
            return ["done": 0, "failed": 0]
        }
        var results: [[String: Any]] = []
        for item in items { results.append(await perform(item)) }
        _ = try? await BrainDumpAPI.call("/api/phone/results", method: "POST", body: ["results": results])
        let failed = results.filter { ($0["ok"] as? Bool) != true }.count
        return ["done": results.count - failed, "failed": failed]
    }

    private func perform(_ item: [String: Any]) async -> [String: Any] {
        let key = item["key"] as? String ?? ""
        let type = item["type"] as? String ?? ""
        let title = item["title"] as? String ?? ""
        func fail(_ msg: String, needs: String? = nil) -> [String: Any] {
            var r: [String: Any] = ["key": key, "ok": false, "error": msg]
            if let needs { r["needs"] = needs }
            return r
        }
        func ok(_ nativeId: String? = nil) -> [String: Any] {
            var r: [String: Any] = ["key": key, "ok": true]
            if let nativeId { r["nativeId"] = nativeId }
            return r
        }
        let calendarOK = EKEventStore.authorizationStatus(for: .event) == .fullAccess || EKEventStore.authorizationStatus(for: .event) == .writeOnly
        let remindersOK = EKEventStore.authorizationStatus(for: .reminder) == .fullAccess

        switch type {
        case "event":
            guard calendarOK else { return fail("Calendar access is off.", needs: "calendar") }
            guard let start = Self.date(item["start"]), let end = Self.date(item["end"]) else { return fail("That event had no time.") }
            let ev = EKEvent(eventStore: store)
            ev.title = title
            ev.startDate = start
            ev.endDate = end
            ev.isAllDay = (item["allDay"] as? String) == "yes"
            ev.location = item["location"] as? String
            ev.notes = item["notes"] as? String
            ev.calendar = store.defaultCalendarForNewEvents
            do { try store.save(ev, span: .thisEvent, commit: true) } catch { return fail(error.localizedDescription) }
            guard let id = ev.eventIdentifier, store.event(withIdentifier: id) != nil else { return fail("The event didn’t stick.") }
            return ok(id)

        case "event_update":
            guard calendarOK else { return fail("Calendar access is off.", needs: "calendar") }
            guard let id = item["nativeId"] as? String, let ev = store.event(withIdentifier: id) else { return ok() } // gone on the phone already
            ev.title = title
            if let s = Self.date(item["start"]) { ev.startDate = s }
            if let e = Self.date(item["end"]) { ev.endDate = e }
            ev.location = item["location"] as? String ?? ev.location
            do { try store.save(ev, span: .thisEvent, commit: true) } catch { return fail(error.localizedDescription) }
            guard let back = store.event(withIdentifier: id), back.startDate == ev.startDate else { return fail("The change didn’t stick.") }
            return ok(id)

        case "event_cancel":
            guard calendarOK else { return fail("Calendar access is off.", needs: "calendar") }
            guard let id = item["nativeId"] as? String, let ev = store.event(withIdentifier: id) else { return ok() }
            do { try store.remove(ev, span: .thisEvent, commit: true) } catch { return fail(error.localizedDescription) }
            return store.event(withIdentifier: id) == nil ? ok() : fail("It’s still in your calendar.")

        case "reminder", "todo", "shopping":
            guard remindersOK else { return fail("Reminders access is off.", needs: "reminders") }
            let rem = EKReminder(eventStore: store)
            rem.title = title
            if type == "shopping", let listName = item["list"] as? String {
                rem.calendar = store.calendars(for: .reminder).first { $0.title.caseInsensitiveCompare(listName) == .orderedSame }
                    ?? store.calendars(for: .reminder).first { ["groceries", "shopping", "shopping list"].contains($0.title.lowercased()) }
                    ?? store.defaultCalendarForNewReminders()
            } else {
                rem.calendar = store.defaultCalendarForNewReminders()
            }
            if let due = Self.date(item["start"]) {
                rem.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due)
                rem.addAlarm(EKAlarm(absoluteDate: due))
            }
            do { try store.save(rem, commit: true) } catch { return fail(error.localizedDescription) }
            guard store.calendarItem(withIdentifier: rem.calendarItemIdentifier) is EKReminder else { return fail("The reminder didn’t stick.") }
            return ok(rem.calendarItemIdentifier)

        case "reminder_complete":
            guard remindersOK else { return fail("Reminders access is off.", needs: "reminders") }
            guard let id = item["nativeId"] as? String, let rem = store.calendarItem(withIdentifier: id) as? EKReminder else { return ok() }
            rem.isCompleted = true
            do { try store.save(rem, commit: true) } catch { return fail(error.localizedDescription) }
            return ok(id)

        case "alarm":
            guard let when = Self.date(item["start"]) else { return fail("That alarm had no time.") }
            return await scheduleAlarm(key: key, title: title, at: when, seconds: nil)

        case "timer":
            let minutes = Double(item["minutes"] as? String ?? "") ?? 0
            guard minutes > 0 else { return fail("That timer had no length.") }
            return await scheduleAlarm(key: key, title: title, at: Date().addingTimeInterval(minutes * 60), seconds: minutes * 60)

        case "note":
            // Apple gives apps no way to write into Notes; the note is kept in Brain Dump
            // (and can be shared to Notes from there). Nothing failed.
            return ok()

        default:
            return ok()
        }
    }

    /// A real alarm/timer with AlarmKit (iOS 26+); otherwise a time-sensitive notification with sound.
    private func scheduleAlarm(key: String, title: String, at date: Date, seconds: Double?) async -> [String: Any] {
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            if AlarmManager.shared.authorizationState == .notDetermined { _ = try? await AlarmManager.shared.requestAuthorization() }
            if AlarmManager.shared.authorizationState == .authorized {
                do {
                    let id = try await AlarmScheduler.schedule(title: title, at: date, countdown: seconds)
                    return ["key": key, "ok": true, "nativeId": "alarm:\(id.uuidString)"]
                } catch {
                    // fall through to a notification so she still gets it
                }
            }
        }
        #endif
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        if status == .notDetermined { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) }
        guard await UNUserNotificationCenter.current().notificationSettings().authorizationStatus == .authorized else {
            return ["key": key, "ok": false, "error": "Notifications are off, so I can’t ring.", "needs": "notifications"]
        }
        let content = UNMutableNotificationContent()
        content.title = seconds == nil ? "Alarm" : "Time’s up"
        content.body = title
        content.sound = .defaultCritical
        content.interruptionLevel = .timeSensitive
        let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let id = "bd-\(key)"
        do {
            try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)))
        } catch {
            return ["key": key, "ok": false, "error": error.localizedDescription]
        }
        let pending = await UNUserNotificationCenter.current().pendingNotificationRequests()
        return pending.contains { $0.identifier == id } ? ["key": key, "ok": true, "nativeId": "notif:\(id)"] : ["key": key, "ok": false, "error": "The alarm didn’t stick."]
    }

    // MARK: Share the calendar (so "I can't make yoga" finds her real yoga)

    private var syncTask: Task<Void, Never>?

    private func calendarChanged() {
        syncTask?.cancel()
        syncTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if !Task.isCancelled { _ = await syncCalendar() }
        }
    }

    @discardableResult
    func syncCalendar() async -> [String: Any] {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess, BrainDumpAPI.token != nil else { return ["count": 0] }
        let from = Date().addingTimeInterval(-86400)
        let to = Date().addingTimeInterval(45 * 86400)
        let events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: nil))
        let iso = ISO8601DateFormatter()
        // Titles and times only: notes and attendees stay on the phone.
        let list: [[String: Any]] = events.compactMap { e in
            guard let id = e.eventIdentifier else { return nil }
            var d: [String: Any] = ["nativeId": id, "title": e.title ?? "", "start": iso.string(from: e.startDate), "end": iso.string(from: e.endDate), "allDay": e.isAllDay, "calendar": e.calendar?.title ?? ""]
            if let l = e.location, !l.isEmpty { d["location"] = l }
            return d
        }
        _ = try? await BrainDumpAPI.call("/api/device/calendar", method: "POST", body: ["from": iso.string(from: from), "to": iso.string(from: to), "events": list])
        return ["count": list.count]
    }

    // MARK: Contacts (looked up here; only what's needed is shared)

    func findContact(_ name: String) -> [[String: Any]] {
        guard CNContactStore.authorizationStatus(for: .contacts) == .authorized else { return [] }
        let keys = [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey, CNContactPhoneNumbersKey, CNContactEmailAddressesKey] as [CNKeyDescriptor]
        let found = (try? CNContactStore().unifiedContacts(matching: CNContact.predicateForContacts(matchingName: name), keysToFetch: keys)) ?? []
        return found.prefix(5).map { c in
            [
                "name": [c.givenName, c.familyName].filter { !$0.isEmpty }.joined(separator: " "),
                "phones": c.phoneNumbers.map { $0.value.stringValue },
                "emails": c.emailAddresses.map { $0.value as String },
            ]
        }
    }

    // MARK: Widget

    func refreshWidget() async {
        guard let o = try? await BrainDumpAPI.call("/api/overview") else { return }
        let upcoming = (o["upcoming"] as? [[String: Any]]) ?? []
        let first = upcoming.first
        let needs = ((o["needsMe"] as? [String: Any])?["items"] as? [Any])?.count ?? 0
        Shared.save(.init(next: first.flatMap { f in [f["title"] as? String, f["when"] as? String].compactMap { $0 }.joined(separator: " · ") },
                          nextTime: (first?["start"] as? String).flatMap { ISO8601DateFormatter.withFractions.date(from: $0) },
                          needs: needs, updated: Date()))
        WidgetCenter.shared.reloadAllTimelines()
    }

    // MARK: Helpers

    static func date(_ v: Any?) -> Date? {
        guard let s = v as? String, !s.isEmpty else { return nil }
        return ISO8601DateFormatter().date(from: s) ?? ISO8601DateFormatter.withFractions.date(from: s)
    }
}

extension ISO8601DateFormatter {
    static let withFractions: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

#if canImport(AlarmKit)
import SwiftUI

@available(iOS 26.0, *)
struct BrainDumpAlarmMetadata: AlarmMetadata {}

@available(iOS 26.0, *)
enum AlarmScheduler {
    /// A real alarm (fixed time) or timer (countdown) that rings like the Clock app's.
    static func schedule(title: String, at date: Date, countdown: Double?) async throws -> UUID {
        let stop = AlarmButton(text: "Stop", textColor: .white, systemImageName: "stop.circle")
        let alert = AlarmPresentation.Alert(title: LocalizedStringResource(stringLiteral: title.isEmpty ? "Brain Dump" : title), stopButton: stop)
        let attributes = AlarmAttributes<BrainDumpAlarmMetadata>(presentation: AlarmPresentation(alert: alert), tintColor: Color(red: 0.42, green: 0.455, blue: 0.84))
        let id = UUID()
        let configuration: AlarmManager.AlarmConfiguration<BrainDumpAlarmMetadata>
        if let countdown {
            configuration = .timer(duration: countdown, attributes: attributes)
        } else {
            configuration = .alarm(schedule: .fixed(date), attributes: attributes)
        }
        _ = try await AlarmManager.shared.schedule(id: id, configuration: configuration)
        return id
    }
}
#endif
