import SwiftUI

struct ServerSettingsView: View {
    @Environment(ULTRONClient.self) private var client
    @Environment(\.dismiss) private var dismiss

    @State private var urlText: String = ""
    @State private var status: TestStatus = .idle

    enum TestStatus: Equatable {
        case idle, testing, ok(String), failed(String)
    }

    var body: some View {
        Form {
            Section("Serveur ULTRON") {
                TextField("http://100.x.x.x:4173", text: $urlText)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                Button("Tester la connexion") {
                    Task { await testConnection() }
                }
                .disabled(urlText.isEmpty || status == .testing)

                statusView
            }

            Section {
                Text("L'adresse est celle du serveur web ULTRON joignable via Tailscale (ex. adresse du Jetson). Aucune authentification n'est requise: Tailscale est le seul périmètre de sécurité.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Réglages")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Enregistrer") {
                    client.serverURLString = urlText
                    dismiss()
                }
                .disabled(urlText.isEmpty)
            }
        }
        .onAppear { urlText = client.serverURLString }
    }

    @ViewBuilder
    private var statusView: some View {
        switch status {
        case .idle:
            EmptyView()
        case .testing:
            HStack { ProgressView(); Text("Connexion...") }
        case .ok(let model):
            Label("Connecté — modèle actif: \(model)", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed(let message):
            Label(message, systemImage: "xmark.octagon.fill")
                .foregroundStyle(.red)
        }
    }

    private func testConnection() async {
        status = .testing
        let previous = client.serverURLString
        client.serverURLString = urlText
        do {
            let health = try await client.health()
            status = .ok(health.model)
        } catch {
            status = .failed(error.localizedDescription)
            client.serverURLString = previous
        }
    }
}
