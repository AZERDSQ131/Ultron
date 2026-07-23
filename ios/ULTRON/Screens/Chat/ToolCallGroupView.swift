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
    @State private var expanded = false

    var body: some View {
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
    }
}
