import SwiftUI

struct MenuView: View {
    @Environment(ULTRONClient.self) private var client

    @State private var chats: [Chat] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var searchQuery = ""
    @State private var showSettings = false

    private static let modules: [ModuleItem] = [
        .init(title: "Finance", icon: "dollarsign.circle.fill", tint: .green, destination: .finance),
        .init(title: "Santé", icon: "heart.fill", tint: .red, destination: .health),
        .init(title: "Tokens", icon: "chart.bar.fill", tint: .blue, destination: .tokens),
        .init(title: "Skills", icon: "hammer.fill", tint: .orange, destination: .skills),
        .init(title: "Memory", icon: "brain.head.profile", tint: .purple, destination: .memory),
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
                ForEach(groupedChats, id: \.title) { group in
                    Section(group.title) {
                        ForEach(group.chats) { chat in
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
        }
    }

    private var visibleChats: [Chat] {
        // Parity with the web sidebar: agent-owned chats live in a separate
        // Agents panel, not this main list — see chatList.js's !chat.agentId filter.
        let base = chats.filter { $0.agentId == nil }
        guard !searchQuery.isEmpty else { return base }
        return base.filter { $0.title.localizedCaseInsensitiveContains(searchQuery) }
    }

    private struct ChatGroup { let title: String; let chats: [Chat] }

    private var groupedChats: [ChatGroup] {
        let calendar = Calendar.current
        let now = Date()
        let formatter = ISO8601DateFormatter()

        func date(_ chat: Chat) -> Date {
            formatter.date(from: chat.updatedAt) ?? .distantPast
        }

        var today: [Chat] = [], yesterday: [Chat] = [], week: [Chat] = [], older: [Chat] = []
        for chat in visibleChats.sorted(by: { date($0) > date($1) }) {
            let d = date(chat)
            if calendar.isDateInToday(d) {
                today.append(chat)
            } else if calendar.isDateInYesterday(d) {
                yesterday.append(chat)
            } else if let days = calendar.dateComponents([.day], from: d, to: now).day, days <= 7 {
                week.append(chat)
            } else {
                older.append(chat)
            }
        }

        var groups: [ChatGroup] = []
        if !today.isEmpty { groups.append(.init(title: "Aujourd'hui", chats: today)) }
        if !yesterday.isEmpty { groups.append(.init(title: "Hier", chats: yesterday)) }
        if !week.isEmpty { groups.append(.init(title: "7 derniers jours", chats: week)) }
        if !older.isEmpty { groups.append(.init(title: "Plus ancien", chats: older)) }
        return groups
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
}
