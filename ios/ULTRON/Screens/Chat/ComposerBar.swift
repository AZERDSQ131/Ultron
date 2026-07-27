import SwiftUI
import PhotosUI

/// An image already uploaded and waiting to be attached to the next message —
/// shown as a thumbnail above the input rather than folded into the text
/// field immediately, so several can be queued up before sending.
struct PendingAttachment: Identifiable {
    let id = UUID()
    let path: String
    let thumbnail: Image
}

struct ComposerBar: View {
    @Binding var text: String
    let modelLabel: String
    let thinkingModeLabel: String
    let taskModeLabel: String
    let permissionLabel: String
    let verbose: Bool
    let isSending: Bool
    @Binding var photoItems: [PhotosPickerItem]
    let pendingAttachments: [PendingAttachment]
    let onRemoveAttachment: (PendingAttachment) -> Void
    let isRecording: Bool
    let onSend: () -> Void
    let onStop: () -> Void
    let onTapModel: () -> Void
    let onTapThinkingMode: () -> Void
    let onTapTaskMode: () -> Void
    let onTapPermission: () -> Void
    let onToggleVerbose: () -> Void
    let onToggleRecording: () -> Void

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

            if !pendingAttachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(pendingAttachments) { attachment in
                            ZStack(alignment: .topTrailing) {
                                attachment.thumbnail
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 60, height: 60)
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                Button {
                                    Haptics.tap()
                                    onRemoveAttachment(attachment)
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.callout)
                                        .symbolRenderingMode(.palette)
                                        .foregroundStyle(.white, .black.opacity(0.55))
                                }
                                .offset(x: 5, y: -5)
                            }
                        }
                    }
                    .padding(.horizontal, 2)
                }
            }

            HStack(alignment: .bottom, spacing: 8) {
                PhotosPicker(selection: $photoItems, matching: .images) {
                    Image(systemName: "plus")
                        .font(.body.weight(.semibold))
                        .frame(width: 34, height: 34)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.primary)
                .simultaneousGesture(TapGesture().onEnded { Haptics.tap() })

                TextField("Écris à ULTRON...", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(.white.opacity(0.22)))

                Button {
                    Haptics.tap()
                    onToggleRecording()
                } label: {
                    Image(systemName: isRecording ? "waveform" : "mic.fill")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(isRecording ? .red : .primary)
                        .frame(width: 34, height: 34)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isRecording ? "Arrêter la dictée" : "Dicter un message")

                Button {
                    Haptics.tap()
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
                        .background(isSending ? Color.red : Color.accentColor, in: Circle())
                }
                .disabled(!isSending && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && pendingAttachments.isEmpty)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) { Rectangle().fill(.white.opacity(0.18)).frame(height: 0.5) }
    }

    private func pillButton(_ label: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button {
            Haptics.tap()
            action()
        } label: {
            Label(label, systemImage: systemImage)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.thinMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(.white.opacity(0.18)))
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
