import SwiftUI

struct MenuView: View {
    @Environment(ULTRONClient.self) private var client

    @State private var chats: [Chat] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var searchQuery = ""
    @State private var showSettings = false
    @State private var expandedFolders: Set<String> = []

    private static let modules: [ModuleItem] = [
        .init(title: "Finance", icon: "dollarsign.circle.fill", tint: .green, destination: .finance),
        .init(title: "Santé", icon: "heart.fill", tint: .red, destination: .health),
        .init(title: "Tokens", icon: "chart.bar.fill", tint: .blue, destination: .tokens),
        .init(title: "Skills", icon: "hammer.fill", tint: .orange, destination: .skills),
        .init(title: "Memory", icon: "brain.head.profile", tint: .purple, destination: .memory),
        .init(title: "Crons", icon: "clock.badge.checkmark", tint: .orange, destination: .schedules),
    ]

    var body: some View {
        List {
            Section {
                ForEach(Self.modules) { module in
                    NavigationLink(value: module.destination) {
                        Label(module.title, systemImage: module.icon)
                            .foregroundStyle(.primary)
                            .symbolRenderingMode(.hierarchical)
                    }
                    .listRowBackground(module.tint.opacity(0.08))
                }
            }

            Section("Conversations") {
                if isLoading && chats.isEmpty {
                    ProgressView()
                } else if let errorMessage {
                    Text(errorMessage).foregroundStyle(.secondary).font(.footnote)
                } else if visibleChats.isEmpty {
                    Text("Aucune conversation pour l'instant.")
                        .foregroundStyle(.secondary)
                }
                ForEach(recentChats) { chat in
                    chatRow(chat)
                }
            }

            ForEach(folderGroups, id: \.title) { group in
                Section {
                    DisclosureGroup(isExpanded: expandedBinding(for: group.title)) {
                        ForEach(group.chats) { chat in
                            chatRow(chat)
                        }
                    } label: {
                        Label(group.title, systemImage: "folder")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .searchable(text: $searchQuery, prompt: "Rechercher")
        .navigationTitle("ULTRON")
        .navigationDestination(for: NavigationTarget.self) { target in
            destinationView(for: target)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await createChat() }
                } label: {
                    Image(systemName: "plus")
                }
            }
            ToolbarItem(placement: .topBarLeading) {
                Button { showSettings = true } label: {
                    Image(systemName: "gearshape")
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack { ServerSettingsView() }
        }
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder
    private func chatRow(_ chat: Chat) -> some View {
        NavigationLink(value: NavigationTarget.chat(chat.id)) {
            ChatListRow(chat: chat)
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                Task { await delete(chat) }
            } label: {
                Label("Supprimer", systemImage: "trash")
            }
            Button {
                Task { await archive(chat) }
            } label: {
                Label("Archiver", systemImage: "archivebox")
            }
            .tint(.orange)
        }
    }

    private func expandedBinding(for title: String) -> Binding<Bool> {
        Binding(
            get: { expandedFolders.contains(title) },
            set: { isExpanded in
                if isExpanded { expandedFolders.insert(title) } else { expandedFolders.remove(title) }
            }
        )
    }

    @ViewBuilder
    private func destinationView(for target: NavigationTarget) -> some View {
        switch target {
        case .chat(let id):
            ChatView(chatId: id)
        case .finance:
            FinanceView()
        case .health:
            HealthView()
        case .tokens:
            TokensView()
        case .skills:
            SkillsView()
        case .memory:
            MemoryView()
        case .schedules:
            SchedulesView()
        }
    }

    private var visibleChats: [Chat] {
        guard !searchQuery.isEmpty else { return chats }
        return chats.filter { $0.title.localizedCaseInsensitiveContains(searchQuery) }
    }

    private struct ChatGroup { let title: String; let chats: [Chat] }

    /// Recent chats (today/yesterday) render flat, classic-style, at the top.
    /// Anything older is bucketed into two collapsible folders shown below
    /// them: "Semaine dernière" (2-7 days) and "Ancien" (everything past
    /// that, folding what used to be a separate "Dernier mois" bucket in).
    private var recentChats: [Chat] {
        let calendar = Calendar.current
        return visibleChats
            .sorted(by: { date($0) > date($1) })
            .filter { calendar.isDateInToday(date($0)) || calendar.isDateInYesterday(date($0)) }
    }

    private var folderGroups: [ChatGroup] {
        let calendar = Calendar.current
        let now = Date()
        var week: [Chat] = [], older: [Chat] = []
        for chat in visibleChats.sorted(by: { date($0) > date($1) }) {
            let d = date(chat)
            guard !calendar.isDateInToday(d), !calendar.isDateInYesterday(d) else { continue }
            let days = calendar.dateComponents([.day], from: d, to: now).day ?? .max
            if days <= 7 {
                week.append(chat)
            } else {
                older.append(chat)
            }
        }
        var groups: [ChatGroup] = []
        if !week.isEmpty { groups.append(.init(title: "Semaine dernière", chats: week)) }
        if !older.isEmpty { groups.append(.init(title: "Ancien", chats: older)) }
        return groups
    }

    private func date(_ chat: Chat) -> Date {
        Date(serverTimestamp: chat.updatedAt) ?? .distantPast
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            chats = try await client.listChats()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func createChat() async {
        do {
            _ = try await client.createChat()
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete(_ chat: Chat) async {
        do {
            try await client.deleteChat(chat.id)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func archive(_ chat: Chat) async {
        do {
            _ = try await client.archiveChat(chat.id)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct ModuleItem: Identifiable {
    let title: String
    let icon: String
    let tint: Color
    let destination: NavigationTarget
    var id: String { title }
}

enum NavigationTarget: Hashable {
    case chat(String)
    case finance
    case health
    case tokens
    case skills
    case memory
    case schedules
}
