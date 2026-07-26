import ActivityKit
import SwiftUI
import WidgetKit

private typealias TaskState = ULTRONTaskActivityAttributes.ContentState

struct ULTRONLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ULTRONTaskActivityAttributes.self) { context in
            LockScreenView(title: context.attributes.title, state: context.state)
                .activityBackgroundTint(.black)
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    StatusIndicator(state: state)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ElapsedLabel(state: state)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    TranscriptList(state: state)
                }
            } compactLeading: {
                StatusIndicator(state: state)
            } compactTrailing: {
                ElapsedLabel(state: state)
            } minimal: {
                // Only shown when another app's activity shares the island. With
                // no running indicator left, falling through to StatusIndicator
                // would render this presentation blank, so the counter stands in.
                if state.status == .running {
                    ElapsedLabel(state: state)
                } else {
                    StatusIndicator(state: state)
                }
            }
            .widgetURL(URL(string: "ultron://chat/\(context.attributes.chatId)"))
            .keylineTint(accent(for: state.status))
        }
    }
}

/// Left side of the Dynamic Island: nothing while the agent works, then a green
/// check or a red cross once the turn lands. A running turn is carried by the
/// elapsed counter on the right alone — an indicator here read as noise on
/// device.
private struct StatusIndicator: View {
    let state: TaskState

    var body: some View {
        switch state.status {
        case .running:
            EmptyView()
        case .waitingForApproval:
            Image(systemName: "hand.raised.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.orange)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.green)
        case .failed:
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.red)
        }
    }
}

/// Right side of the compact island: how long the turn has been running. Counts
/// up on its own, so it keeps moving even while the app is suspended and no
/// update can reach the activity. Deliberately blank once the turn is over —
/// the status icon alone carries the outcome.
private struct ElapsedLabel: View {
    let state: TaskState

    var body: some View {
        if state.status == .running {
            // Never call fixedSize() here: a timer Text has no fixed content, so
            // its "ideal" width is the worst case (a full 59:59:59), which blows
            // the compact island out to full width and pushes the label out of
            // the visible area. Bound the width instead, and right-align inside
            // that box — centring was what left a gap before the island's edge.
            Text(timerInterval: state.startedDate...state.startedDate.addingTimeInterval(3600), countsDown: false)
                .font(.caption2.weight(.semibold).monospacedDigit())
                .foregroundStyle(.blue)
                .lineLimit(1)
                .frame(maxWidth: 44, alignment: .trailing)
        }
    }
}

/// What a long press reveals: the tail of the conversation, each line marked as
/// an assistant message or a tool call.
private struct TranscriptList: View {
    let state: TaskState

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if state.entries.isEmpty {
                Text("Traitement en cours")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(state.entries.suffix(4)) { entry in
                    EntryRow(entry: entry, isLatest: entry.id == state.entries.last?.id)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 2)
    }
}

private struct EntryRow: View {
    let entry: TaskState.Entry
    let isLatest: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 12)
            Text(entry.text)
                .font(.caption2)
                .foregroundStyle(isLatest ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                .lineLimit(isLatest ? 2 : 1)
                .multilineTextAlignment(.leading)
        }
    }

    private var icon: String {
        switch entry.kind {
        case .message: return "text.alignleft"
        case .tool: return "wrench.and.screwdriver.fill"
        case .status: return "exclamationmark.circle.fill"
        }
    }

    private var tint: Color {
        switch entry.kind {
        case .message: return .blue
        case .tool: return .orange
        case .status: return .yellow
        }
    }
}

private struct LockScreenView: View {
    let title: String
    let state: TaskState

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Collapses to nothing while running, rather than reserving an empty
            // gutter where the indicator used to be.
            StatusIndicator(state: state)
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    ElapsedLabel(state: state)
                }
                TranscriptList(state: state)
            }
        }
        .padding(14)
    }
}

private func accent(for status: TaskState.Status) -> Color {
    switch status {
    case .running: return .blue
    case .waitingForApproval: return .orange
    case .completed: return .green
    case .failed: return .red
    }
}

@main
struct ULTRONLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        ULTRONLiveActivity()
    }
}
