import SwiftUI

struct SkillsView: View {
    @Environment(ULTRONClient.self) private var client
    @State private var skills: [Skill] = []
    @State private var errorMessage: String?
    @State private var isLoading = true
    @State private var installingName: String?

    var body: some View {
        List {
            if isLoading {
                ProgressView()
            } else if let errorMessage {
                Text(errorMessage).foregroundStyle(.secondary)
            } else if skills.isEmpty {
                ContentUnavailableView("Aucun skill", systemImage: "hammer")
            } else {
                Section("Locaux") {
                    ForEach(skills.filter { $0.source == "local" }) { skill in
                        row(for: skill)
                    }
                }
                Section("Hub") {
                    ForEach(skills.filter { $0.source == "hub" }) { skill in
                        row(for: skill)
                    }
                }
            }
        }
        .navigationTitle("Skills")
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder
    private func row(for skill: Skill) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(skill.name).font(.subheadline.weight(.medium))
                Spacer()
                if skill.source == "hub" {
                    Button {
                        Task { await install(skill) }
                    } label: {
                        if installingName == skill.name {
                            ProgressView()
                        } else {
                            Text("Installer")
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(installingName != nil)
                }
            }
            Text(skill.description)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func load() async {
        isLoading = skills.isEmpty
        do {
            skills = try await client.skills()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func install(_ skill: Skill) async {
        installingName = skill.name
        do {
            _ = try await client.installSkill(skill.name)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
        installingName = nil
    }
}
