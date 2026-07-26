import SwiftUI

/// A project's conversations — the drop target chats land in from
/// MenuView's drag & drop, plus a dedicated "new chat in this project"
/// entry point and a way to take a chat back out.
struct ProjectView: View {
    let projectId: String
    var onChange: () async -> Void

    @Environment(ULTRONClient.self) private var client
    @Environment(\.dismiss) private var dismiss

    @State private var project: Project?
    @State private var chats: [Chat] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showEdit = false
    @State private var pendingChatId: String?

    var body: some View {
        List {
            if let errorMessage {
                Text(errorMessage).foregroundStyle(.secondary).font(.footnote)
            } else if !isLoading && chats.isEmpty {
                Text("Aucune conversation dans ce projet. Glisse-en une ici, ou démarre-en une nouvelle.")
                    .foregroundStyle(.secondary)
            }
            ForEach(chats) { chat in
                NavigationLink(value: NavigationTarget.chat(chat.id)) {
                    ChatListRow(chat: chat)
                }
                .swipeActions(edge: .trailing) {
                    Button {
                        Task { await removeFromProject(chat) }
                    } label: {
                        Label("Sortir du projet", systemImage: "folder.badge.minus")
                    }
                    .tint(.orange)
                }
            }
        }
        .navigationTitle(project?.name ?? "Projet")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await createChatInProject() }
                } label: {
                    Image(systemName: "plus")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showEdit = true
                } label: {
                    Image(systemName: "pencil")
                }
            }
            ToolbarItem(placement: .destructiveAction) {
                Button(role: .destructive) {
                    Task { await deleteProject() }
                } label: {
                    Image(systemName: "trash")
                }
            }
        }
        .sheet(isPresented: $showEdit) {
            if let project {
                ProjectEditorSheet(existing: project) { name, icon, color in
                    Task { await updateProject(name: name, icon: icon, color: color) }
                }
            }
        }
        .navigationDestination(item: $pendingChatId) { id in
            ChatView(chatId: id)
        }
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let allProjects = try await client.listProjects()
            project = allProjects.first { $0.id == projectId }
            let allChats = try await client.listChats()
            chats = allChats.filter { $0.projectId == projectId }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func createChatInProject() async {
        do {
            let chat = try await client.createChat()
            try await client.setChatProject(chat.id, projectId: projectId)
            await load()
            await onChange()
            pendingChatId = chat.id
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func removeFromProject(_ chat: Chat) async {
        do {
            try await client.setChatProject(chat.id, projectId: nil)
            await load()
            await onChange()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func updateProject(name: String, icon: String, color: String) async {
        do {
            _ = try await client.updateProject(projectId, name: name, icon: icon, color: color)
            await load()
            await onChange()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func deleteProject() async {
        do {
            try await client.deleteProject(projectId)
            await onChange()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
