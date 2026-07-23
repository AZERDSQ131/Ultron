import SwiftUI
import UIKit

/// Device-code ChatGPT OAuth login (see src/core/llm/openaiAuth.ts's header
/// comment for the verified flow) — shows the code + a tappable link, polls
/// the server until the user approves in a browser on any device.
struct OpenAILoginSheet: View {
    @Environment(ULTRONClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    let onConnected: () -> Void

    private enum LoginState {
        case starting, waiting(url: String, code: String), success, failure(String)
    }

    @State private var state: LoginState = .starting

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                switch state {
                case .starting:
                    ProgressView("Démarrage…")
                case .waiting(let url, let code):
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(.tint)
                    Text("Connecte-toi avec ton compte ChatGPT")
                        .font(.headline)
                    VStack(spacing: 8) {
                        Text(code)
                            .font(.system(.largeTitle, design: .monospaced).weight(.bold))
                            .padding(.horizontal, 20)
                            .padding(.vertical, 10)
                            .background(RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemBackground)))
                        Button {
                            if let link = URL(string: url) { UIApplication.shared.open(link) }
                        } label: {
                            Label(url, systemImage: "arrow.up.right.square")
                        }
                    }
                    ProgressView("En attente de l'approbation…")
                        .padding(.top, 8)
                case .success:
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(.green)
                    Text("Connecté à ChatGPT")
                        .font(.headline)
                case .failure(let message):
                    Image(systemName: "xmark.octagon.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(.red)
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                Spacer()
            }
            .padding()
            .navigationTitle("OpenAI")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fermer") { dismiss() }
                }
            }
            .task { await start() }
        }
    }

    private func start() async {
        do {
            let start = try await client.openAILoginStart()
            state = .waiting(url: start.verificationUrl, code: start.userCode)
            await poll(loginId: start.loginId)
        } catch {
            state = .failure(error.localizedDescription)
        }
    }

    private func poll(loginId: String) async {
        while true {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard let status = try? await client.openAILoginStatus(loginId: loginId) else { continue }
            if status.status == "complete" {
                state = .success
                onConnected()
                return
            }
            if status.status == "error" {
                state = .failure(status.error ?? "Connexion échouée.")
                return
            }
        }
    }
}
