import SwiftUI

/// Mirrors thread.js's addApprovalBlock: raw args + scope badge per pending
/// call, with Approve/Deny per call. plan_propose gets no special numbered-
/// step rendering here yet (CLI/web-only nuance) — plain JSON is shown
/// instead, kept simple for v1.
struct ApprovalCardView: View {
    let calls: [PendingToolCall]
    let onDecide: (_ decisions: [String: Bool]) -> Void

    @State private var decisions: [String: Bool] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Confirmation requise", systemImage: "exclamationmark.shield.fill")
                .font(.headline)
                .foregroundStyle(.orange)

            ForEach(calls) { call in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(call.name).font(.subheadline.weight(.semibold))
                        Spacer()
                        Text("destructif")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(Color.red.opacity(0.15)))
                            .foregroundStyle(.red)
                    }
                    Text(call.args.prettyPrinted)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(6)

                    HStack {
                        Button {
                            decide(call.id, approve: false)
                        } label: {
                            Text("Refuser").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .tint(decisions[call.id] == false ? .red : .gray)

                        Button {
                            decide(call.id, approve: true)
                        } label: {
                            Text("Approuver").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(decisions[call.id] == true ? .green : .accentColor)
                    }
                }
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color(.secondarySystemBackground)))
            }

            if decisions.count == calls.count {
                Button("Confirmer") { onDecide(decisions) }
                    .buttonStyle(.borderedProminent)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).stroke(Color.orange.opacity(0.4), lineWidth: 1))
    }

    private func decide(_ id: String, approve: Bool) {
        decisions[id] = approve
    }
}
