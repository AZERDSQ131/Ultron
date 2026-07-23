import SwiftUI

struct RootView: View {
    @Environment(ULTRONClient.self) private var client
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            if client.serverURLString.isEmpty {
                onboarding
            } else {
                MenuView()
            }
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack { ServerSettingsView() }
        }
        .onAppear {
            if client.serverURLString.isEmpty { showSettings = true }
        }
    }

    private var onboarding: some View {
        VStack(spacing: 16) {
            Image(systemName: "bolt.horizontal.circle")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("ULTRON")
                .font(.largeTitle.bold())
            Text("Configure l'adresse de ton serveur ULTRON pour commencer.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button("Configurer le serveur") { showSettings = true }
                .buttonStyle(.borderedProminent)
        }
    }
}
