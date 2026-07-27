import SwiftUI

/// Dedicated card for a spawn_agent call — deliberately not rendered as a
/// generic tool (no disclosure to expand, nothing to accidentally collapse):
/// the sub-agent's own conversation is the point, so it gets an icon, its
/// task, a running/done status, and a single "Voir" button that is the only
/// tappable region in the card.
struct SubAgentWidgetView: View {
    let title: String
    let task: String
    let finished: Bool
    let onView: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().fill(Color.purple.opacity(0.15)).frame(width: 34, height: 34)
                Image(systemName: "person.2.badge.gearshape")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.purple)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                HStack(spacing: 4) {
                    if !finished {
                        ProgressView().controlSize(.mini)
                    }
                    Text(finished ? "Sous-agent terminé" : "Sous-agent en cours…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 8)

            Button(action: onView) {
                Text("Voir")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color.purple.opacity(0.15), in: Capsule())
                    .foregroundStyle(.purple)
            }
            .buttonStyle(.plain)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}
