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
            if chat.scheduleId != nil {
                Text("⏰").font(.caption)
            }
        }
    }

    private var relativeTime: String {
        guard let date = ISO8601DateFormatter().date(from: chat.updatedAt) else { return "" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
