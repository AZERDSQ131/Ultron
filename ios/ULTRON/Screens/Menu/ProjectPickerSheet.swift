import SwiftUI

/// Picks a project to file a chat under — the swipe action's fallback for
/// drag & drop. A proper sheet rather than a confirmationDialog: the
/// dialog rendered anchored at the top of the screen instead of the
/// expected bottom action sheet in some contexts, and every other picker
/// in the app (model, thinking mode, task mode, permission) already uses
/// this same NavigationStack-in-a-sheet shape.
struct ProjectPickerSheet: View {
    let projects: [Project]
    let onPicked: (_ projectId: String) -> Void
    let onCreateNew: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if projects.isEmpty {
                    Text("Aucun projet pour l'instant.")
                        .foregroundStyle(.secondary)
                }
                ForEach(projects) { project in
                    Button {
                        onPicked(project.id)
                        dismiss()
                    } label: {
                        HStack {
                            ZStack {
                                Circle().fill(Color(hex: project.color).opacity(0.18)).frame(width: 28, height: 28)
                                Text(project.icon).font(.footnote)
                            }
                            Text(project.name).foregroundStyle(.primary)
                        }
                    }
                }
                Button {
                    onCreateNew()
                    dismiss()
                } label: {
                    Label("Nouveau projet", systemImage: "plus.circle")
                }
            }
            .navigationTitle("Ajouter à un projet")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Annuler") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
