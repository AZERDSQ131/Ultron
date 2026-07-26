import SwiftUI

struct ModelPickerSheet: View {
    @Environment(ULTRONClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    let onPicked: (_ provider: String, _ model: String) -> Void

    @State private var groups: [ModelGroup] = []
    @State private var current = ""
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showOpenAILogin = false

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.secondary)
                }
                ForEach(groups, id: \.provider) { group in
                    Section(group.provider.uppercased()) {
                        if group.provider == "openai" && group.models.isEmpty {
                            Button {
                                showOpenAILogin = true
                            } label: {
                                Label("Se connecter à ChatGPT…", systemImage: "bubble.left.and.bubble.right")
                            }
                        }
                        ForEach(group.models) { model in
                            Button {
                                onPicked(group.provider, model.id)
                                dismiss()
                            } label: {
                                HStack {
                        Text(model.id)
                        if group.provider == "nvidia" {
                            Text(model.availability == "free" ? "Free" : model.availability == "partner" ? "Partner" : model.availability == "downloadable" ? "Download" : "Unknown")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                                    Spacer()
                                    if model.id == current {
                                        Image(systemName: "checkmark").foregroundStyle(.tint)
                                    }
                                }
                            }
                            .foregroundStyle(.primary)
                        }
                    }
                }
            }
            .overlay { if isLoading { ProgressView() } }
            .navigationTitle("Modèle")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fermer") { dismiss() }
                }
            }
            .sheet(isPresented: $showOpenAILogin) {
                OpenAILoginSheet {
                    Task {
                        if let response = try? await client.groupedModels() {
                            groups = response.groups
                            current = response.current
                        }
                    }
                }
            }
            .task {
                do {
                    let response = try await client.groupedModels()
                    groups = response.groups
                    current = response.current
                } catch {
                    errorMessage = error.localizedDescription
                }
                isLoading = false
            }
        }
    }
}

struct TaskModePickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var selected: String
    let onPicked: (String) -> Void

    // Values are the wire `TaskMode` (graph.ts) — "deep_research", not
    // "research": the shorthand only exists in the CLI and web /task commands.
    private let modes: [(value: String, label: String, icon: String, detail: String)] = [
        ("none", "Aucun", "circle", "Réponse directe, sans planification imposée"),
        ("todo", "To-Do", "checklist", "Tâche à plusieurs étapes — tient une liste de sous-tâches"),
        ("plan", "Plan", "list.bullet.clipboard", "Tâche complexe — propose un plan et attend ton accord"),
        ("goal", "Objectif", "target", "Tâche autonome — continue jusqu'à ce que l'objectif soit atteint"),
        ("deep_research", "Deep Research", "text.magnifyingglass", "Question de fond — découpe en sous-questions, lit les sources, puis rédige un rapport cité"),
    ]

    var body: some View {
        NavigationStack {
            List(modes, id: \.value) { mode in
                Button {
                    selected = mode.value
                    onPicked(mode.value)
                    dismiss()
                } label: {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 3) {
                            Label(mode.label, systemImage: mode.icon)
                            Text(mode.detail)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 8)
                        if selected == mode.value {
                            Image(systemName: "checkmark").foregroundStyle(.tint)
                        }
                    }
                }
                .foregroundStyle(.primary)
            }
            .navigationTitle("Mode de tâche")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fermer") { dismiss() }
                }
            }
        }
    }
}

struct ThinkingModePickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var selected: String
    let profile: ReasoningProfile?
    let onPicked: (String) -> Void

    private var modes: [(value: String, label: String, icon: String)] {
        (profile?.options ?? ["off"]).map { mode in
            (mode, mode == "off" ? "Désactivé" : mode.capitalized, mode == "off" ? "brain.head.profile.fill" : "brain")
        }
    }

    var body: some View {
        NavigationStack {
            List(modes, id: \.value) { mode in
                Button {
                    selected = mode.value
                    onPicked(mode.value)
                    dismiss()
                } label: {
                    HStack {
                        Label(mode.label, systemImage: mode.icon)
                        Spacer()
                        if selected == mode.value {
                            Image(systemName: "checkmark").foregroundStyle(.tint)
                        }
                    }
                }
                .foregroundStyle(.primary)
            }
            .navigationTitle("Raisonnement")
            .safeAreaInset(edge: .bottom) {
                if let note = profile?.note { Text(note).font(.footnote).foregroundStyle(.secondary).padding() }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fermer") { dismiss() }
                }
            }
        }
    }
}

struct PermissionPickerSheet: View {
    @Environment(ULTRONClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    let chatId: String
    @Binding var selected: String

    private let modes: [(value: String, label: String, detail: String)] = [
        ("bypass", "Bypass", "Aucune confirmation manuelle"),
        ("accept_edit", "Accept edit", "Confirmation pour les éditions"),
        ("manual", "Manuel", "Confirmation pour tout outil destructif"),
    ]

    var body: some View {
        NavigationStack {
            List(modes, id: \.value) { mode in
                Button {
                    Task {
                        do {
                            let chat = try await client.setSecurityMode(chatId, mode: mode.value)
                            selected = chat.securityMode
                            dismiss()
                        } catch {
                            // Silent failure acceptable here: the sheet stays open, user can retry.
                        }
                    }
                } label: {
                    VStack(alignment: .leading) {
                        HStack {
                            Text(mode.label)
                            Spacer()
                            if selected == mode.value {
                                Image(systemName: "checkmark").foregroundStyle(.tint)
                            }
                        }
                        Text(mode.detail).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .foregroundStyle(.primary)
            }
            .navigationTitle("Permission")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fermer") { dismiss() }
                }
            }
        }
    }
}
