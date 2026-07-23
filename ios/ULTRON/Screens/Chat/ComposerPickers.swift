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

    private let modes: [(value: String, label: String, icon: String)] = [
        ("none", "Aucun", "circle"),
        ("todo", "To-Do", "checklist"),
        ("plan", "Plan", "list.bullet.clipboard"),
    ]

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
            .navigationTitle("Mode de tâche")
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
