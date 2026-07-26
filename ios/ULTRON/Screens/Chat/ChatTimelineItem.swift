import Foundation

/// A rendered unit in the conversation timeline. Turns raw ChatMessage rows
/// (human/ai/tool_call/tool_result) plus live streaming state into groups
/// suitable for display: consecutive tool_call/tool_result pairs collapse
/// into one ToolGroup, mirroring thread.js's beginToolGroup on the web.
enum ChatTimelineItem: Identifiable {
    case human(id: String, text: String)
    // stats: the "model | X in | Y out | Zs | $coût" line from /verbose's
    // TurnDoneStats, attached to the specific assistant turn it describes
    // rather than kept as one shared value — see ChatTimelineBuilder.setStats.
    case assistant(id: String, text: String, stats: String? = nil)
    case toolGroup(id: String, calls: [ToolCallEntry])
    case approval(id: String, calls: [PendingToolCall])

    var id: String {
        switch self {
        case .human(let id, _): return id
        case .assistant(let id, _, _): return id
        case .toolGroup(let id, _): return id
        case .approval(let id, _): return id
        }
    }
}

struct ToolCallEntry: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let summary: String
    var result: String?
    var scope: String? // filled in from GET /api/tools when available

    /// A spawn_agent result starts with `[ultron:subagent chat=<id>]` — see
    /// parseSubAgentMarker in src/core/tools/agents.ts. Parsed from the result
    /// text rather than carried in a separate field so replayed history links
    /// too, which is the case that matters: you look at what a sub-agent did
    /// after the fact.
    var subAgentChatId: String? {
        guard let result else { return nil }
        let prefix = "[ultron:subagent chat="
        let trimmed = result.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(prefix), let end = trimmed.firstIndex(of: "]") else { return nil }
        let id = trimmed[trimmed.index(trimmed.startIndex, offsetBy: prefix.count)..<end]
        return id.isEmpty ? nil : String(id)
    }
}

/// Route for observing a sub-agent's conversation. A dedicated type rather than
/// pushing a bare String, which would collide with any other string destination.
struct SubAgentRoute: Hashable {
    let chatId: String
    let title: String
}

@MainActor
@Observable
final class ChatTimelineBuilder {
    private(set) var items: [ChatTimelineItem] = []
    private var toolScopes: [String: String] = [:]

    func setToolScopes(_ tools: [Tool]) {
        toolScopes = Dictionary(uniqueKeysWithValues: tools.map { ($0.name, $0.scope) })
    }

    func loadHistory(_ messages: [ChatMessage]) {
        items.removeAll()
        var pendingCalls: [ToolCallEntry] = []

        func flushToolGroup() {
            guard !pendingCalls.isEmpty else { return }
            items.append(.toolGroup(id: UUID().uuidString, calls: pendingCalls))
            pendingCalls.removeAll()
        }

        for message in messages {
            switch message.role {
            case "human":
                flushToolGroup()
                items.append(.human(id: UUID().uuidString, text: message.content))
            case "ai":
                flushToolGroup()
                items.append(.assistant(id: UUID().uuidString, text: message.content))
            case "tool_call":
                pendingCalls.append(ToolCallEntry(
                    name: message.name ?? "tool",
                    summary: message.content,
                    scope: toolScopes[message.name ?? ""]
                ))
            case "tool_result":
                if let index = pendingCalls.lastIndex(where: { $0.name == message.name && $0.result == nil }) {
                    pendingCalls[index].result = message.content
                }
            default:
                break
            }
        }
        flushToolGroup()
    }

    // MARK: - Live streaming mutation

    private var streamingAssistantId: String?
    private var pendingLiveCalls: [ToolCallEntry] = []

    func beginAssistantTurn() {
        let id = UUID().uuidString
        streamingAssistantId = id
        items.append(.assistant(id: id, text: ""))
    }

    func appendText(_ delta: String) {
        guard let id = streamingAssistantId,
              let index = items.firstIndex(where: { $0.id == id }),
              case .assistant(_, let text, let stats) = items[index] else { return }
        items[index] = .assistant(id: id, text: text + delta, stats: stats)
    }

    /// Attaches a /verbose stats line to the assistant turn currently
    /// streaming, so it renders directly under that message in the scroll
    /// view instead of a single detached line pinned near the composer.
    func setStats(_ stats: String) {
        guard let id = streamingAssistantId,
              let index = items.firstIndex(where: { $0.id == id }),
              case .assistant(_, let text, _) = items[index] else { return }
        items[index] = .assistant(id: id, text: text, stats: stats)
    }

    func addToolCall(name: String, summary: String) {
        pendingLiveCalls.append(ToolCallEntry(name: name, summary: summary, scope: toolScopes[name]))
        flushLiveToolGroup(replacing: true)
    }

    func addToolResult(name: String, content: String) {
        if let index = pendingLiveCalls.lastIndex(where: { $0.name == name && $0.result == nil }) {
            pendingLiveCalls[index].result = content
        }
        flushLiveToolGroup(replacing: true)
    }

    private var liveToolGroupId: String?

    private func flushLiveToolGroup(replacing: Bool) {
        guard !pendingLiveCalls.isEmpty else { return }
        if let id = liveToolGroupId, let index = items.firstIndex(where: { $0.id == id }) {
            items[index] = .toolGroup(id: id, calls: pendingLiveCalls)
        } else {
            let id = UUID().uuidString
            liveToolGroupId = id
            items.append(.toolGroup(id: id, calls: pendingLiveCalls))
        }
    }

    func addApproval(_ calls: [PendingToolCall]) {
        items.append(.approval(id: UUID().uuidString, calls: calls))
    }

    func removeApproval(id: String) {
        items.removeAll { $0.id == id }
    }

    func endTurn() {
        streamingAssistantId = nil
        pendingLiveCalls.removeAll()
        liveToolGroupId = nil
    }

    func addHumanMessage(_ text: String) {
        items.append(.human(id: UUID().uuidString, text: text))
    }
}
