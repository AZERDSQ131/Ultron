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
    // A spawn_agent call, rendered as its own clean widget rather than
    // folded into a generic toolGroup — it's the one tool call the user is
    // meant to look inside of, not just glance at, so it gets a dedicated
    // "Voir" button instead of living behind a disclosure toggle.
    case subAgent(id: String, chatId: String, title: String, task: String, finished: Bool)
    case approval(id: String, calls: [PendingToolCall])

    var id: String {
        switch self {
        case .human(let id, _): return id
        case .assistant(let id, _, _): return id
        case .toolGroup(let id, _): return id
        case .subAgent(let id, _, _, _, _): return id
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
}

/// A spawn_agent result starts with `[ultron:subagent chat=<id>]` — see
/// parseSubAgentMarker in src/core/tools/agents.ts. Parsed from the result
/// text rather than carried in a separate field so replayed history links
/// too, which is the case that matters: you look at what a sub-agent did
/// after the fact.
func parseSubAgentMarker(_ content: String) -> String? {
    let prefix = "[ultron:subagent chat="
    let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix(prefix), let end = trimmed.firstIndex(of: "]") else { return nil }
    let id = trimmed[trimmed.index(trimmed.startIndex, offsetBy: prefix.count)..<end]
    return id.isEmpty ? nil : String(id)
}

/// A spawn_agent result reads `Sub-agent "<label>" finished.` on the line
/// after the marker — use that label when present, since the raw task text
/// can run long and isn't meant for a title.
func parseSubAgentTitle(from result: String, fallback: String) -> String {
    if let quoted = result.split(separator: "\n").first(where: { $0.contains("\"") }),
       let start = quoted.firstIndex(of: "\""),
       let end = quoted.lastIndex(of: "\""),
       start < end {
        let label = quoted[quoted.index(after: start)..<end]
        if !label.isEmpty { return String(label) }
    }
    let trimmed = fallback.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "Sous-agent" : String(trimmed.prefix(60))
}

/// Route for observing a sub-agent's conversation. A dedicated type rather than
/// pushing a bare String, which would collide with any other string destination.
struct SubAgentRoute: Hashable, Identifiable {
    let chatId: String
    let title: String

    var id: String { chatId }
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
        // Task text for a spawn_agent tool_call row, held until its
        // tool_result (with the marker carrying the real chat id) arrives —
        // a still-open one (no matching tool_result yet) is simply dropped
        // here; mergeRunningSubAgents fills that gap from the server's own
        // live tracking, which is the only place the child id actually exists
        // before the call returns.
        var pendingSubAgentTask: String?

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
                if message.name == "spawn_agent" {
                    pendingSubAgentTask = message.content
                } else {
                    pendingCalls.append(ToolCallEntry(
                        name: message.name ?? "tool",
                        summary: message.content,
                        scope: toolScopes[message.name ?? ""]
                    ))
                }
            case "tool_result":
                if message.name == "spawn_agent" {
                    if let chatId = parseSubAgentMarker(message.content) {
                        flushToolGroup()
                        items.append(.subAgent(
                            id: chatId,
                            chatId: chatId,
                            title: parseSubAgentTitle(from: message.content, fallback: pendingSubAgentTask ?? ""),
                            task: pendingSubAgentTask ?? "",
                            finished: true
                        ))
                    }
                    pendingSubAgentTask = nil
                } else if let index = pendingCalls.lastIndex(where: { $0.name == message.name && $0.result == nil }) {
                    pendingCalls[index].result = message.content
                }
            default:
                break
            }
        }
        flushToolGroup()
    }

    /// Adds a running widget for any sub-agent the server still tracks as
    /// in-flight (GET .../messages' runningSubAgents) that loadHistory
    /// couldn't already show as finished — the reconnect-after-reopening and
    /// nested-grandchild-observation cases, where there's no live SSE
    /// subAgentStarted event to rely on.
    func mergeRunningSubAgents(_ running: [RunningSubAgent]) {
        for entry in running where !items.contains(where: { $0.id == entry.chatId }) {
            items.append(.subAgent(id: entry.chatId, chatId: entry.chatId, title: entry.title, task: entry.task, finished: false))
        }
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

    /// spawn_agent is deliberately excluded from the generic tool group here —
    /// it gets its own widget (addSubAgentStarted/markSubAgentFinished)
    /// instead. Its tool_call/tool_result pair also always arrives together,
    /// right when the sub-agent's entire run finishes, so by then the widget
    /// is already showing from the earlier subAgentStarted event.
    func addToolCall(name: String, summary: String) {
        guard name != "spawn_agent" else { return }
        pendingLiveCalls.append(ToolCallEntry(name: name, summary: summary, scope: toolScopes[name]))
        flushLiveToolGroup(replacing: true)
    }

    func addToolResult(name: String, content: String) {
        guard name != "spawn_agent" else { return }
        if let index = pendingLiveCalls.lastIndex(where: { $0.name == name && $0.result == nil }) {
            pendingLiveCalls[index].result = content
        }
        flushLiveToolGroup(replacing: true)
    }

    func addSubAgentStarted(chatId: String, title: String, task: String) {
        items.append(.subAgent(id: chatId, chatId: chatId, title: title, task: task, finished: false))
    }

    func markSubAgentFinished(chatId: String) {
        guard let index = items.firstIndex(where: { $0.id == chatId }),
              case .subAgent(let id, let cid, let title, let task, _) = items[index] else { return }
        items[index] = .subAgent(id: id, chatId: cid, title: title, task: task, finished: true)
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
