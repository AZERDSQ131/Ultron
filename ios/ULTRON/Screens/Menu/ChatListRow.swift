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
            Text(origin == "telegram" ? "Telegram" : "CLI")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill((origin == "telegram" ? Color.blue : Color.gray).opacity(0.15)))
                .foregroundStyle(origin == "telegram" ? .blue : .secondary)
        }
    }

    private var relativeTime: String {
        guard let date = ISO8601DateFormatter().date(from: chat.updatedAt) else { return "" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
