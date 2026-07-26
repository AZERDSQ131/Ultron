import SwiftUI

/// Create or rename a project — name, an emoji icon, and a color, the same
/// three things Apple's own "Smart List"/folder creation sheets ask for.
struct ProjectEditorSheet: View {
    var existing: Project?
    let onSave: (_ name: String, _ icon: String, _ color: String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var icon: String
    @State private var color: Color

    private static let icons = ["📁", "🚀", "💼", "🧠", "🎨", "🛠️", "📚", "💡", "🏠", "💰", "🩺", "🎮", "✈️", "🍳", "🎵", "📈"]
    private static let colors = ["#FF3B30", "#FF9500", "#FFCC00", "#34C759", "#00C7BE", "#30B0C7", "#007AFF", "#5856D6", "#AF52DE", "#FF2D55", "#8E8E93"]

    init(existing: Project? = nil, onSave: @escaping (_ name: String, _ icon: String, _ color: String) -> Void) {
        self.existing = existing
        self.onSave = onSave
        _name = State(initialValue: existing?.name ?? "")
        _icon = State(initialValue: existing?.icon ?? "📁")
        _color = State(initialValue: Color(hex: existing?.color ?? "#007AFF"))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        ZStack {
                            Circle().fill(color.opacity(0.18)).frame(width: 44, height: 44)
                            Text(icon).font(.title2)
                        }
                        TextField("Nom du projet", text: $name)
                            .font(.body)
                    }
                }

                Section("Icône") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 8), spacing: 10) {
                        ForEach(Self.icons, id: \.self) { candidate in
                            Button {
                                icon = candidate
                            } label: {
                                Text(candidate)
                                    .font(.title3)
                                    .frame(width: 32, height: 32)
                                    .background(
                                        Circle().fill(icon == candidate ? color.opacity(0.25) : Color.clear)
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 4)
                }

                Section("Couleur") {
                    HStack(spacing: 12) {
                        ForEach(Self.colors, id: \.self) { hex in
                            let swatch = Color(hex: hex)
                            Button {
                                color = swatch
                            } label: {
                                Circle()
                                    .fill(swatch)
                                    .frame(width: 28, height: 28)
                                    .overlay(
                                        Circle().stroke(Color.primary, lineWidth: color.hexString == hex ? 2 : 0)
                                            .padding(-3)
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                        Spacer()
                        ColorPicker("", selection: $color, supportsOpacity: false)
                            .labelsHidden()
                    }
                    .padding(.vertical, 4)
                }
            }
            .navigationTitle(existing == nil ? "Nouveau projet" : "Modifier le projet")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Annuler") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Enregistrer") {
                        onSave(name.trimmingCharacters(in: .whitespacesAndNewlines), icon, color.hexString)
                        dismiss()
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
