import SwiftUI

struct ChatListRow: View {
    let chat: Chat

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(chat.title.isEmpty ? "Sans titre" : chat.title)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Text(relativeTime)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            originBadge
            if chat.scheduleId != nil {
                Text("⏰").font(.caption)
            }
        }
    }

    @ViewBuilder
    private var originBadge: some View {
        if let origin = chat.origin {
            Text(label(for: origin))
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(color(for: origin).opacity(0.15)))
                .foregroundStyle(color(for: origin))
        }
    }

    private func label(for origin: String) -> String {
        switch origin {
        case "telegram": return "Telegram"
        case "app": return "App"
        default: return "CLI"
        }
    }

    private func color(for origin: String) -> Color {
        switch origin {
        case "telegram": return .blue
        case "app": return .purple
        default: return .secondary
        }
    }

    private var relativeTime: String {
        guard let date = ISO8601DateFormatter().date(from: chat.updatedAt) else { return "" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
