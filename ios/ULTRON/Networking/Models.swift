import Foundation

// Mirrors src/core/memory/chats.ts's Chat interface.
struct Chat: Codable, Identifiable, Equatable {
    let id: String
    var title: String
    let createdAt: String
    var updatedAt: String
    let agentId: String?
    let scheduleId: String?
    var securityMode: String
    let archivedAt: String?
    var exportPath: String?
    // "cli" | "telegram" — which interface this conversation originated
    // from, computed server-side (ChatRegistry.getOrigin). Only present on
    // GET /api/chats today.
    let origin: String?
}

// Mirrors graph.ts's ChatMessage shape returned by GET /api/chats/:id/messages.
struct ChatMessage: Codable, Identifiable, Equatable {
    let role: String // "human" | "ai" | "tool_call" | "tool_result"
    let content: String
    let name: String?

    var id: String { UUID().uuidString }
}

struct TodoItem: Codable, Identifiable, Equatable {
    let index: Int
    var content: String
    var status: String // "pending" | "in_progress" | "completed"

    var id: Int { index }
}

// Raw args from an approval_required SSE event (graph.ts's PendingToolCall).
struct PendingToolCall: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let args: JSONValue
}

struct ModelInfo: Codable, Identifiable, Equatable {
    let id: String
    let provider: String?
    let contextLength: Int?

    enum CodingKeys: String, CodingKey {
        case id, provider
        case contextLength = "contextLength"
    }
}

struct ModelGroup: Codable, Equatable {
    let provider: String
    let models: [ModelInfo]
}

struct Tool: Codable, Identifiable, Equatable {
    let name: String
    let scope: String // "read" | "destructive"
    let description: String

    var id: String { name }
}

struct Skill: Codable, Identifiable, Equatable {
    let name: String
    let description: String
    let source: String // "local" | "hub"

    var id: String { name + source }
}

struct UserModelObservation: Codable, Identifiable, Equatable {
    let id: Int
    let kind: String // "preference" | "fact" | "pattern"
    let content: String
    let chatId: String?
    let createdAt: String
}

// MARK: - Turn stream events (mirrors streamGraphTurn's SSE vocabulary)

struct TurnDoneStats: Codable, Equatable {
    let elapsedSeconds: Double
    let generatedTokens: Int
    let inputTokens: Int
    let stats: String
    let contextTokens: Int
    let maxTokens: Int
}

enum TurnEvent {
    case text(String)
    case toolCall(name: String, summary: String)
    case toolResult(name: String, content: String)
    case approvalRequired([PendingToolCall])
    case done(TurnDoneStats)
    case goal(status: String, reason: String)
    case aborted
    case error(String)
}

// MARK: - Finance

struct FinanceAccount: Codable, Identifiable, Equatable {
    let id: String
    var name: String
    var type: String
    var currency: String
    var balance: Double?
}

struct FinanceTransaction: Codable, Identifiable, Equatable {
    let id: String
    let accountId: String
    let description: String
    let amount: Double
    let date: String
    let category: String?
}

struct NetWorthPoint: Codable, Equatable {
    let date: String
    let netWorth: Double
}

struct CategorySpend: Codable, Identifiable, Equatable {
    let category: String
    let amount: Double
    var id: String { category }
}

struct CashFlowPoint: Codable, Identifiable, Equatable {
    let month: String
    let income: Double
    let expenses: Double
    var id: String { month }
}

struct MonthSummary: Codable, Equatable {
    let income: Double
    let expenses: Double
    let net: Double
}

struct FinanceSummary: Codable, Equatable {
    let hasData: Bool
    let netWorth: Double?
    let accounts: [FinanceAccount]?
    let netWorthHistory: [NetWorthPoint]?
    let transactions: [FinanceTransaction]?
    let monthSummary: MonthSummary?
    let spendingByCategory: [CategorySpend]?
    let monthlyCashFlow: [CashFlowPoint]?
}

// MARK: - Health

struct DaySummary: Codable, Identifiable, Equatable {
    let date: String
    let recoveryScore: Double?
    let activityScore: Double?
    var id: String { date }
}

struct HealthSummary: Codable, Equatable {
    let hasData: Bool
    let days: [DaySummary]?
    let sleepDebt: Double?
    let anomalies: [String]?
    let latestScores: JSONValue?
    let bioAge: Double?
}

// MARK: - Usage

struct UsageByKind: Codable, Identifiable, Equatable {
    let kind: String
    let inputTokens: Int
    let outputTokens: Int
    let estimatedCost: Double
    var id: String { kind }
}

struct UsageSummary: Codable, Equatable {
    let hasData: Bool
    let totalInputTokens: Int?
    let totalOutputTokens: Int?
    let totalEstimatedCost: Double?
    let byKind: [UsageByKind]?
}

// MARK: - Generic JSON passthrough (for raw tool-call args / flexible payloads)

enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    /// Pretty-printed JSON text, for rendering raw tool-call args in the approval card.
    var prettyPrinted: String {
        guard let data = try? JSONEncoder().encode(self),
              let object = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: pretty, encoding: .utf8)
        else {
            return String(describing: self)
        }
        return text
    }
}
