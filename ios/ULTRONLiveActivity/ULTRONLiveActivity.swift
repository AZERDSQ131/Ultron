import ActivityKit
import SwiftUI
import WidgetKit

struct ULTRONLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ULTRONTaskActivityAttributes.self) { context in
            lockScreenView(context: context)
                .activityBackgroundTint(.black)
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: icon(for: context.state.status))
                        .foregroundStyle(color(for: context.state.status))
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(shortStatus(context.state.status))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(color(for: context.state.status))
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(context.state.latestAction)
                            .font(.subheadline.weight(.medium))
                            .lineLimit(2)
                        ForEach(context.state.actions.suffix(4)) { action in
                            Text(action.label)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                Image(systemName: icon(for: context.state.status))
                    .foregroundStyle(color(for: context.state.status))
            } compactTrailing: {
                Text(shortStatus(context.state.status))
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(color(for: context.state.status))
            } minimal: {
                Image(systemName: icon(for: context.state.status))
                    .foregroundStyle(color(for: context.state.status))
            }
            .widgetURL(URL(string: "ultron://chat/\(context.attributes.chatId)"))
            .keylineTint(color(for: context.state.status))
        }
    }

    @ViewBuilder
    private func lockScreenView(context: ActivityViewContext<ULTRONTaskActivityAttributes>) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon(for: context.state.status))
                .font(.title2)
                .foregroundStyle(color(for: context.state.status))
            VStack(alignment: .leading, spacing: 4) {
                Text(context.attributes.title).font(.headline).lineLimit(1)
                Text(context.state.latestAction).font(.subheadline).lineLimit(2)
            }
            Spacer()
            Text(shortStatus(context.state.status)).font(.caption.weight(.semibold))
        }
        .padding()
    }

    private func icon(for status: ULTRONTaskActivityAttributes.ContentState.Status) -> String {
        switch status {
        case .running: return "ellipsis"
        case .completed: return "checkmark.circle.fill"
        case .failed: return "xmark.circle.fill"
        case .waitingForApproval: return "hand.raised.fill"
        }
    }

    private func shortStatus(_ status: ULTRONTaskActivityAttributes.ContentState.Status) -> String {
        switch status {
        case .running: return "…"
        case .completed: return "OK"
        case .failed: return "!"
        case .waitingForApproval: return "?"
        }
    }

    private func color(for status: ULTRONTaskActivityAttributes.ContentState.Status) -> Color {
        switch status {
        case .running: return .white
        case .completed: return .green
        case .failed: return .red
        case .waitingForApproval: return .orange
        }
    }
}

@main
struct ULTRONLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        ULTRONLiveActivity()
    }
}
