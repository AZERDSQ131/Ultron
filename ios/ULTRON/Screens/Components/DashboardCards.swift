import SwiftUI

/// Shared building blocks for the dashboard screens (Tokens, Santé, Finance).
/// They were written for Tokens first; pulled out here so the three read as one
/// design rather than three approximations of it.

/// A titled panel. Sits on `systemGroupedBackground`, so any screen using it has
/// to set that as its scroll background or the cards read as floating.
struct DashboardCard<Content: View>: View {
    let title: String
    let subtitle: String?
    @ViewBuilder var content: Content

    init(_ title: String, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .tracking(0.6)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }
}

/// One headline number with a label above and a supporting line below.
struct StatTile: View {
    let label: String
    let value: String
    var detail: String?
    let systemImage: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(.caption2)
                    .foregroundStyle(tint)
                Text(label)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Text(value)
                .font(.title3.weight(.semibold).monospacedDigit())
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            if let detail {
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }
}

/// A compact metric inside a card — smaller than `StatTile`, for grids of many
/// readings where each one doesn't deserve its own panel.
struct MetricCell: View {
    let label: String
    let value: String
    var systemImage: String?
    var tint: Color = .secondary

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.caption2)
                        .foregroundStyle(tint)
                }
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text(value)
                .font(.callout.weight(.medium).monospacedDigit())
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Two-column grid used by every dashboard's tile row.
let dashboardTwoColumns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

func dashboardPercent(_ share: Double) -> String {
    "\(Int((share * 100).rounded())) %"
}
