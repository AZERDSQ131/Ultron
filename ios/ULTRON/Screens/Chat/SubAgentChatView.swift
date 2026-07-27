import SwiftUI

/// Read-only view of a sub-agent's conversation, opened from the spawn_agent
/// tool call that created it.
///
/// Observation only, deliberately: a sub-agent works from the single assignment
/// it was handed and nothing is listening on the other end, so a composer here
/// would silently do nothing. If the run is still going, this shows how far it
/// has got and refreshes on pull.
struct SubAgentChatView: View {
    let route: SubAgentRoute

    @Environment(ULTRONClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    @State private var timeline = ChatTimelineBuilder()
    @State private var isRunning = false
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var task: String?
    @State private var nested: SubAgentRoute?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                header

                if isLoading && timeline.items.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 30)
                } else if let errorMessage {
                    ContentUnavailableView("Chargement impossible", systemImage: "exclamationmark.triangle", description: Text(errorMessage))
                } else if timeline.items.isEmpty {
                    ContentUnavailableView(
                        "Rien à observer pour l'instant",
                        systemImage: "hourglass",
                        description: Text("Ce sous-agent n'a encore rien produit.")
                    )
                    .padding(.top, 30)
                } else {
                    ForEach(timeline.items.filter(isVisible)) { item in
                        row(for: item)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
        .navigationTitle(route.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Haptics.tap()
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                }
            }
        }
        .sheet(item: $nested) { child in
            NavigationStack { SubAgentChatView(route: child) }
        }
        .refreshable { await load() }
        .task { await pollWhileRunning() }
    }

    /// Nobody drives this conversation from here, so "live" has to mean
    /// polling rather than an SSE stream tied to a turn this device started.
    /// Keeps reloading on a short interval as long as the sub-agent is still
    /// running, then stops — mirroring the terminal state a real stream
    /// would deliver once.
    private func pollWhileRunning() async {
        await load()
        while isRunning && !Task.isCancelled {
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled else { return }
            await load()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: isRunning ? "circle.dotted" : "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(isRunning ? .orange : .green)
                Text(isRunning ? "Sous-agent en cours" : "Sous-agent terminé")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Text("lecture seule")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if let task, !task.isEmpty {
                Text(task)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
    }

    /// The spawn prompt is scaffolding ULTRON wrote, not something the user
    /// said — showing it as a user bubble would be misleading. The assignment
    /// itself is in the header instead.
    private func isVisible(_ item: ChatTimelineItem) -> Bool {
        switch item {
        case .human: return false
        case .assistant(_, let text, _):
            // Between tool calls the model sometimes emits an assistant turn
            // whose visible content is empty or a bare `""` (a stringified
            // empty JSON value) — same filter as ChatView's isVisible.
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return !trimmed.isEmpty && trimmed != "\"\"" && trimmed != "\""
        case .toolGroup, .subAgent, .approval: return true
        }
    }

    @ViewBuilder
    private func row(for item: ChatTimelineItem) -> some View {
        switch item {
        case .human(_, let text):
            HumanBubble(text: text)
        case .assistant(_, let text, _):
            AssistantMessageView(text: text)
        case .toolGroup(_, let calls):
            ToolCallGroupView(calls: calls)
        case .subAgent(_, let chatId, let title, let subTask, let finished):
            // A sub-agent can spawn its own, so keep the chain walkable.
            SubAgentWidgetView(title: title, task: subTask, finished: finished) {
                nested = SubAgentRoute(chatId: chatId, title: title)
            }
        case .approval(_, let calls):
            // Observation only, so an approval can't be acted on from here.
            ToolCallGroupView(calls: calls.map { ToolCallEntry(name: $0.name, summary: "en attente d'approbation") })
        }
    }

    private func load() async {
        do {
            let response = try await client.messages(for: route.chatId)
            let fresh = ChatTimelineBuilder()
            fresh.loadHistory(response.messages)
            fresh.mergeRunningSubAgents(response.runningSubAgents)
            if let tools = try? await client.tools() { fresh.setToolScopes(tools) }
            timeline = fresh
            isRunning = response.running
            task = try? await subAgentTask()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func subAgentTask() async throws -> String? {
        try await client.listChats().first { $0.id == route.chatId }?.subagentTask
    }
}
