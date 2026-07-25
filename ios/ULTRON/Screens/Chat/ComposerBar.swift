import SwiftUI

struct ComposerBar: View {
    @Binding var text: String
    let modelLabel: String
    let thinkingModeLabel: String
    let taskModeLabel: String
    let permissionLabel: String
    let verbose: Bool
    let isSending: Bool
    let onSend: () -> Void
    let onStop: () -> Void
    let onTapModel: () -> Void
    let onTapThinkingMode: () -> Void
    let onTapTaskMode: () -> Void
    let onTapPermission: () -> Void
    let onToggleVerbose: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                pillButton(modelLabel, systemImage: "cpu", action: onTapModel)
                pillButton(thinkingModeLabel, systemImage: "brain.head.profile", action: onTapThinkingMode)
                pillButton(taskModeLabel, systemImage: "checklist", action: onTapTaskMode)
                pillButton(permissionLabel, systemImage: "lock.shield", action: onTapPermission)
                pillButton(verbose ? "Stats" : "", systemImage: "gauge.with.dots.needle.33percent", action: onToggleVerbose)
                Spacer()
            }
            .scrollableIfNeeded()

            HStack(alignment: .bottom, spacing: 8) {
                TextField("Écris à ULTRON...", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Color(.secondarySystemBackground)))

                Button {
                    if isSending {
                        onStop()
                    } else {
                        onSend()
                    }
                } label: {
                    Image(systemName: isSending ? "stop.fill" : "arrow.up")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(isSending ? Color.red : Color.accentColor))
                }
                .disabled(!isSending && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func pillButton(_ label: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(label, systemImage: systemImage)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Capsule().fill(Color(.secondarySystemBackground)))
        }
        .foregroundStyle(.primary)
    }
}

private extension View {
    @ViewBuilder
    func scrollableIfNeeded() -> some View {
        ScrollView(.horizontal, showsIndicators: false) { self }
    }
}
