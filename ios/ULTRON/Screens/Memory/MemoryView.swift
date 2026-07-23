import SwiftUI

struct MemoryView: View {
    @Environment(ULTRONClient.self) private var client
    @State private var observations: [UserModelObservation] = []
    @State private var errorMessage: String?
    @State private var isLoading = true
    @State private var showClearConfirm = false

    var body: some View {
        List {
            if isLoading {
                ProgressView()
            } else if let errorMessage {
                Text(errorMessage).foregroundStyle(.secondary)
            } else if observations.isEmpty {
                ContentUnavailableView(
                    "Aucune observation",
                    systemImage: "brain.head.profile",
                    description: Text("ULTRON apprend passivement au fil des conversations.")
                )
            } else {
                ForEach(observations) { observation in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(observation.kind.capitalized)
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Capsule().fill(Color.purple.opacity(0.15)))
                                .foregroundStyle(.purple)
                            Spacer()
                        }
                        Text(observation.content)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { await forget(observation) }
                        } label: {
                            Label("Oublier", systemImage: "trash")
                        }
                    }
                }
            }
        }
        .navigationTitle("Memory")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Tout effacer", role: .destructive) { showClearConfirm = true }
                    .disabled(observations.isEmpty)
            }
        }
        .confirmationDialog("Effacer toutes les observations ?", isPresented: $showClearConfirm, titleVisibility: .visible) {
            Button("Effacer", role: .destructive) { Task { await clearAll() } }
        }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        isLoading = observations.isEmpty
        do {
            observations = try await client.memoryObservations().observations
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func forget(_ observation: UserModelObservation) async {
        do {
            try await client.forgetMemory(observation.id)
            observations.removeAll { $0.id == observation.id }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func clearAll() async {
        do {
            try await client.clearMemory()
            observations.removeAll()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
