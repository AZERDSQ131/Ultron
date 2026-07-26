import SwiftUI
import UniformTypeIdentifiers

struct MenuView: View {
    @Environment(ULTRONClient.self) private var client

    @State private var chats: [Chat] = []
    @State private var projects: [Project] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var searchQuery = ""
    @State private var showSettings = false
    @State private var showCreateProject = false
    @State private var expandedFolders: Set<String> = []
    // Explicit fallback alongside drag & drop below — pick a chat's project
    // from a list instead of dragging it, for anyone who finds (or whose
    // device finds) the drag gesture finicky to land precisely on a row.
    @State private var addingToProjectChat: Chat?
    @State private var dropTargetProjectId: String?

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

            Section {
                ForEach(projects) { project in
                    NavigationLink(value: NavigationTarget.project(project.id)) {
                        HStack {
                            ZStack {
                                Circle().fill(Color(hex: project.color).opacity(dropTargetProjectId == project.id ? 0.4 : 0.18)).frame(width: 28, height: 28)
                                Text(project.icon).font(.footnote)
                            }
                            Text(project.name).foregroundStyle(.primary)
                        }
                    }
                    .listRowBackground(dropTargetProjectId == project.id ? Color(hex: project.color).opacity(0.12) : nil)
                    .onDrop(of: [.plainText], isTargeted: Binding(
                        get: { dropTargetProjectId == project.id },
                        set: { isTargeted in dropTargetProjectId = isTargeted ? project.id : (dropTargetProjectId == project.id ? nil : dropTargetProjectId) }
                    )) { providers in
                        guard let provider = providers.first else { return false }
                        _ = provider.loadObject(ofClass: NSString.self) { reading, _ in
                            guard let chatId = reading as? String else { return }
                            Task { @MainActor in await moveChat(chatId, toProject: project.id) }
                        }
                        return true
                    }
                }
                Button {
                    showCreateProject = true
                } label: {
                    Label("Nouveau projet", systemImage: "plus.circle")
                }
            } header: {
                Text("Projets")
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
        .sheet(isPresented: $showCreateProject) {
            ProjectEditorSheet { name, icon, color in
                Task { await createProject(name: name, icon: icon, color: color) }
            }
        }
        .confirmationDialog(
            "Ajouter à un projet",
            isPresented: Binding(get: { addingToProjectChat != nil }, set: { if !$0 { addingToProjectChat = nil } }),
            titleVisibility: .visible,
            presenting: addingToProjectChat
        ) { chat in
            if projects.isEmpty {
                Button("Créer un projet") { showCreateProject = true }
            } else {
                ForEach(projects) { project in
                    Button("\(project.icon) \(project.name)") {
                        Task { await moveChat(chat.id, toProject: project.id) }
                    }
                }
            }
            Button("Annuler", role: .cancel) {}
        }
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder
    private func chatRow(_ chat: Chat) -> some View {
        NavigationLink(value: NavigationTarget.chat(chat.id)) {
            ChatListRow(chat: chat)
        }
        // .onDrag/.onDrop (NSItemProvider) rather than the newer
        // .draggable/.dropDestination (Transferable) — the latter never
        // initiated a drag at all on a List row wrapped in a NavigationLink,
        // even with the NavigationLink hidden behind the row content; this
        // older pair is the combination actually proven to coexist with
        // List's own tap/scroll gesture recognizers.
        .onDrag { NSItemProvider(object: chat.id as NSString) }
        .swipeActions(edge: .trailing) {
            Button {
                addingToProjectChat = chat
            } label: {
                Label("Ajouter", systemImage: "plus")
            }
            .tint(.blue)
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
        case .project(let id):
            ProjectView(projectId: id, onChange: { await load() })
        }
    }

    // Chats already filed under a project are only shown inside that
    // project's own view (ProjectView), not duplicated in the flat
    // recent/folder lists here.
    private var visibleChats: [Chat] {
        let unfiled = chats.filter { $0.projectId == nil }
        guard !searchQuery.isEmpty else { return unfiled }
        return unfiled.filter { $0.title.localizedCaseInsensitiveContains(searchQuery) }
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
            projects = try await client.listProjects()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func createProject(name: String, icon: String, color: String) async {
        do {
            _ = try await client.createProject(name: name, icon: icon, color: color)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func moveChat(_ chatId: String, toProject projectId: String) async {
        do {
            try await client.setChatProject(chatId, projectId: projectId)
            await load()
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
    case project(String)
    case finance
    case health
    case tokens
    case skills
    case memory
    case schedules
}
