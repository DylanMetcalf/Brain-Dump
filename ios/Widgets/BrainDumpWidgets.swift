import WidgetKit
import SwiftUI
import AppIntents

/// The Brain Dump gradient: soft lavender → periwinkle → sky.
private let brandGradient = LinearGradient(
    colors: [Color(red: 0.60, green: 0.65, blue: 0.95), Color(red: 0.42, green: 0.455, blue: 0.84), Color(red: 0.35, green: 0.53, blue: 0.85)],
    startPoint: .topLeading, endPoint: .bottomTrailing)

struct TalkEntry: TimelineEntry {
    let date: Date
    let snapshot: Shared.Snapshot?
}

struct TalkProvider: TimelineProvider {
    func placeholder(in context: Context) -> TalkEntry { TalkEntry(date: Date(), snapshot: nil) }
    func getSnapshot(in context: Context, completion: @escaping (TalkEntry) -> Void) { completion(TalkEntry(date: Date(), snapshot: Shared.snapshot())) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<TalkEntry>) -> Void) {
        let entry = TalkEntry(date: Date(), snapshot: Shared.snapshot())
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(30 * 60))))
    }
}

struct TalkWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TalkEntry

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "mic.fill").font(.title2)
            }
            .widgetURL(Shared.talkURL)
        case .accessoryRectangular:
            VStack(alignment: .leading) {
                Label("Brain Dump", systemImage: "mic.fill").font(.headline)
                Text(entry.snapshot?.next ?? "Tap to talk").font(.caption).lineLimit(2)
            }
            .widgetURL(Shared.talkURL)
        default:
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Image(systemName: "sparkles").font(.title3.weight(.semibold))
                    Spacer()
                    if let n = entry.snapshot?.needs, n > 0 {
                        Text("\(n)").font(.caption.bold()).padding(.horizontal, 7).padding(.vertical, 2).background(.white.opacity(0.25), in: Capsule())
                    }
                }
                Spacer(minLength: 0)
                Text("What’s on your mind?").font(.headline).lineLimit(2)
                if family != .systemSmall || entry.snapshot?.next != nil {
                    Text(entry.snapshot?.next.map { "Next: \($0)" } ?? "Tap to talk").font(.caption).opacity(0.85).lineLimit(2)
                }
            }
            .foregroundStyle(.white)
            .widgetURL(Shared.talkURL)
        }
    }
}

struct TalkWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "app.braindump.talk", provider: TalkProvider()) { entry in
            TalkWidgetView(entry: entry)
                .containerBackground(brandGradient, for: .widget)
        }
        .configurationDisplayName("Talk to Brain Dump")
        .description("One tap to start talking, and what’s next.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}

/// Lock Screen / Control Centre / Action Button control.
struct TalkControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "app.braindump.talk-control") {
            ControlWidgetButton(action: StartBrainDumpIntent()) {
                Label("Brain Dump", systemImage: "mic.fill")
            }
        }
        .displayName("Talk to Brain Dump")
        .description("Start talking to Brain Dump.")
    }
}

@main
struct BrainDumpWidgetBundle: WidgetBundle {
    var body: some Widget {
        TalkWidget()
        TalkControl()
    }
}
