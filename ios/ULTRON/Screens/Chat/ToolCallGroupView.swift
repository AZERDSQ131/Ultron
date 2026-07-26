import SwiftUI

struct ScopeBadge: View {
    let scope: String?

    var body: some View {
        if let scope {
            Text(scope == "destructive" ? "destructive" : "read")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(color.opacity(0.15)))
                .foregroundStyle(color)
        }
    }

    private var color: Color {
        scope == "destructive" ? .red : .blue
    }
}

struct ToolCallGroupView: View {
    let calls: [ToolCallEntry]
    /// Supplied when sub-agent conversations can be opened from here. A plain
    /// closure rather than a NavigationLink: the link had to sit inside this
    /// DisclosureGroup's collapsed content and relied on a navigationDestination
    /// registered by a parent — several independent ways to end up with
    /// something that renders but never responds. The caller now decides how to
    /// present it.
    var onObserveSubAgent: ((SubAgentRoute) -> Void)?

    @State private var expanded = false

    private var subAgentCalls: [ToolCallEntry] {
        calls.filter { $0.subAgentChatId != nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            DisclosureGroup(isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(calls) { call in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                ScopeBadge(scope: call.scope)
                                Text(call.name).font(.subheadline.weight(.semibold))
                            }
                            Text(call.summary)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            if let result = call.result {
                                Text(result)
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(8)
                                    .padding(8)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(.secondarySystemBackground)))
                            }
                        }
                    }
                }
                .padding(.top, 6)
            } label: {
                Label("A utilisé \(calls.count) outil\(calls.count > 1 ? "s" : "")", systemImage: "wrench.and.screwdriver")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            // Outside the DisclosureGroup on purpose: the sub-agent's own
            // conversation is the interesting thing here, so reaching it must not
            // require expanding the tool block first.
            if let onObserveSubAgent, !subAgentCalls.isEmpty {
                ForEach(subAgentCalls) { call in
                    Button {
                        guard let chatId = call.subAgentChatId else { return }
                        onObserveSubAgent(SubAgentRoute(chatId: chatId, title: subAgentTitle(call)))
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "person.2.badge.gearshape")
                            Text("Observer « \(subAgentTitle(call)) »")
                                .lineLimit(1)
                            Spacer(minLength: 4)
                            Image(systemName: "chevron.right").font(.caption2)
                        }
                        .font(.caption.weight(.medium))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .frame(maxWidth: .infinity)
                        .background(Color.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                        .foregroundStyle(.blue)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// A spawn_agent result reads `Sub-agent "<label>" finished.` on the line
    /// after the marker — use that label when present, since `summary` is the
    /// entire task text and far too long for a button.
    private func subAgentTitle(_ call: ToolCallEntry) -> String {
        if let result = call.result,
           let quoted = result.split(separator: "\n").first(where: { $0.contains("\"") }),
           let start = quoted.firstIndex(of: "\""),
           let end = quoted.lastIndex(of: "\""),
           start < end {
            let label = quoted[quoted.index(after: start)..<end]
            if !label.isEmpty { return String(label) }
        }
        let summary = call.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        return summary.isEmpty ? "Sous-agent" : String(summary.prefix(40))
    }
}
