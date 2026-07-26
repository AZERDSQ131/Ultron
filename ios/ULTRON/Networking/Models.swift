import Foundation

// Mirrors src/core/memory/chats.ts's Chat interface.
struct Chat: Codable, Identifiable, Equatable {
    let id: String
    var title: String
    let createdAt: String
    var updatedAt: String
    let scheduleId: String?
    var securityMode: String
    let archivedAt: String?
    var exportPath: String?
    // "cli" | "app" — which interface this conversation originated
    // from, computed server-side (ChatRegistry.getOrigin). Only present on
    // GET /api/chats today.
    let origin: String?
    // The project folder this chat is filed under, if any (chats.project_id
    // server-side). nil for chats not assigned to a project.
    var projectId: String?
}

// Mirrors src/core/memory/projects.ts's Project interface.
struct Project: Codable, Identifiable, Equatable {
    let id: String
    var name: String
    var icon: String
    var color: String
    let createdAt: String
}

struct Schedule: Codable, Identifiable, Equatable {
    let id: String
    var name: String
    var instruction: String
    var cron: String
    var timezone: String
    var enabled: Bool
    let nextRunAt: String?
    let lastRunAt: String?
    let lastRunChatId: String?
    let createdAt: String
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
    let availability: String?

    enum CodingKeys: String, CodingKey {
        case id, provider
        case contextLength = "contextLength", availability
    }
}

struct ReasoningProfile: Codable, Equatable {
    let provider: String
    let model: String
    let supported: Bool
    let options: [String]
    let defaultMode: String?
    let note: String
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
    /// When that balance was last recorded — snapshots are upserted once per day.
    var balanceDate: String?
}

struct FinanceTransaction: Codable, Identifiable, Equatable {
    /// `finance_transactions.id` is an INTEGER PRIMARY KEY, so the server sends a
    /// number here. Typing it as String failed the whole FinanceSummary decode
    /// the moment a single transaction existed.
    let id: Int
    let accountId: String
    let description: String
    let amount: Double
    let date: String
    let category: String?

    var isExpense: Bool { amount < 0 }
    var day: Date? { Date(healthDate: date) }
}

struct NetWorthPoint: Codable, Identifiable, Equatable {
    let date: String
    let netWorth: Double

    var id: String { date }
    var day: Date? { Date(healthDate: date) }
}

struct CategorySpend: Codable, Identifiable, Equatable {
    let category: String
    let amount: Double
    /// How many transactions make up that total.
    let count: Int
    var id: String { category }

    enum CodingKeys: String, CodingKey {
        case category
        case amount = "total"
        case count
    }
}

struct CashFlowPoint: Codable, Identifiable, Equatable {
    /// `YYYY-MM`.
    let month: String
    let income: Double
    let expenses: Double
    let net: Double

    var id: String { month }
    var monthStart: Date? { Date(healthDate: "\(month)-01") }
}

struct MonthSummary: Codable, Equatable {
    let income: Double
    let expenses: Double
    let savings: Double
    /// Null when there was no income to divide by.
    let savingsRatePct: Double?
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

/// One day of the health export. Every metric is `Double?` on purpose: the
/// server hands back whatever the export contained, nulls included, and typing
/// counts as `Int` would make the whole payload fail to decode the first time
/// one arrives as a float.
struct HealthDay: Codable, Identifiable, Equatable {
    let date: String
    let steps: Double?
    let activeEnergyKcal: Double?
    let distanceKm: Double?
    let exerciseMinutes: Double?
    let flightsClimbed: Double?
    let workoutCount: Double?
    let restingHR: Double?
    let walkingHR: Double?
    let sleepDurationSec: Double?
    let sleepAsleepSec: Double?
    let hrvAvg: Double?
    let respiratoryRateAvg: Double?
    let recovery: Double?
    let activity: Double?

    var id: String { date }
    var day: Date? { Date(healthDate: date) }

    /// Time actually asleep over time in bed.
    var sleepEfficiencyPct: Double? {
        guard let sleepAsleepSec, let sleepDurationSec, sleepDurationSec > 0 else { return nil }
        return sleepAsleepSec / sleepDurationSec * 100
    }

    var hasAnyMetric: Bool {
        [steps, activeEnergyKcal, restingHR, hrvAvg, sleepDurationSec].contains { $0 != nil }
    }
}

struct HealthLatestScores: Codable, Equatable {
    let date: String
    let recovery: Double
    let activity: Double
}

/// All-time bests plus the current streak. Each record is absent rather than
/// null when no day in the history carries that metric.
struct HealthRecords: Codable, Equatable {
    struct DatedValue: Codable, Equatable {
        let date: String
        let value: Double
    }

    struct SleepNight: Codable, Equatable {
        let date: String
        let durationSec: Double
    }

    let bestSleepNight: SleepNight?
    let lowestRestingHR: DatedValue?
    let mostSteps: DatedValue?
    let currentActivityStreakDays: Int
}

struct HealthMeal: Codable, Identifiable, Equatable {
    let id: Int
    let date: String
    let timestamp: String
    let description: String
    let estimatedCalories: Double?
    let proteinG: Double?
    let carbsG: Double?
    let fatG: Double?
    let photoUrl: String?
}

struct HealthExercise: Codable, Identifiable, Equatable {
    let id: Int
    let date: String
    let timestamp: String
    let description: String
    let exerciseType: String?
    let durationMinutes: Double?
    let intensity: String?
    let estimatedCaloriesBurned: Double?
    let photoUrl: String?
}

extension Date {
    /// Health rows are keyed by a plain `YYYY-MM-DD` bucket, not a timestamp.
    init?(healthDate: String) {
        guard let date = Date.healthDayParser.date(from: healthDate) else { return nil }
        self = date
    }

    fileprivate static let healthDayParser: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .iso8601)
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

// These three were typed as plain scalars while the server has always sent
// objects (HealthAnomaly / HealthSleepDebt / BioAgeResult), which failed the
// whole HealthSummary decode — the screen showed "isn't in the correct format"
// and nothing else.

struct HealthAnomaly: Codable, Equatable, Identifiable {
    let metric: String
    /// "notable" or "significant" — see NOTABLE_Z / SIGNIFICANT_Z in trends.ts.
    let severity: String
    let message: String

    var id: String { "\(metric)-\(message)" }
    var isSignificant: Bool { severity == "significant" }
}

struct HealthSleepDebt: Codable, Equatable {
    let deficitHours: Double
    let daysCounted: Int
}

struct HealthBioAge: Codable, Equatable {
    let age: Double
    let explanation: [String]
}

struct HealthSummary: Codable, Equatable {
    let hasData: Bool
    let from: String?
    let to: String?
    let days: [HealthDay]?
    let records: HealthRecords?
    let sleepDebt: HealthSleepDebt?
    let anomalies: [HealthAnomaly]?
    let latestScores: HealthLatestScores?
    let bioAge: HealthBioAge?
    let meals: [HealthMeal]?
    let exercises: [HealthExercise]?
}

// MARK: - Usage

// Mirrors UsageSummary in src/core/memory/usage.ts. The endpoint has always
// returned every breakdown; this used to decode only the totals and byKind and
// silently drop the rest, which is why the Tokens screen had so little to show.

struct UsageTotals: Codable, Equatable {
    let requests: Int
    let inputTokens: Int
    let outputTokens: Int
    let costUsd: Double
    let elapsedMs: Int

    var totalTokens: Int { inputTokens + outputTokens }
}

/// One row of a provider / model / call-kind breakdown.
struct UsageBreakdownRow: Codable, Identifiable, Equatable {
    let key: String
    let requests: Int
    let inputTokens: Int
    let outputTokens: Int
    let costUsd: Double
    let elapsedMs: Int

    var id: String { key }
    var totalTokens: Int { inputTokens + outputTokens }
    var averageElapsedMs: Int { requests > 0 ? elapsedMs / requests : 0 }
}

struct UsageDay: Codable, Identifiable, Equatable {
    let date: String
    let requests: Int
    let inputTokens: Int
    let outputTokens: Int
    let costUsd: Double
    let elapsedMs: Int

    var id: String { date }
    var totalTokens: Int { inputTokens + outputTokens }

    /// `date` is a plain `YYYY-MM-DD` bucket, not a timestamp.
    var day: Date? { UsageDay.parser.date(from: date) }

    private static let parser: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .iso8601)
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

struct UsageRecord: Codable, Identifiable, Equatable {
    let id: Int
    let createdAt: String
    let provider: String
    let model: String
    let kind: String
    let chatId: String?
    let inputTokens: Int
    let outputTokens: Int
    let elapsedMs: Int
    let costUsd: Double

    var totalTokens: Int { inputTokens + outputTokens }
    var timestamp: Date? { Date(serverTimestamp: createdAt) }
}

extension Date {
    /// The server stamps every row with `new Date().toISOString()`, which carries
    /// milliseconds. A bare `ISO8601DateFormatter` is configured for
    /// `.withInternetDateTime` only and returns nil on those, so fractional
    /// seconds have to be opted into — with a plain fallback for any value that
    /// doesn't have them.
    init?(serverTimestamp: String) {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: serverTimestamp) {
            self = date
            return
        }
        guard let date = ISO8601DateFormatter().date(from: serverTimestamp) else { return nil }
        self = date
    }
}

struct UsageSummary: Codable, Equatable {
    let hasData: Bool
    let totals: UsageTotals?
    let byProvider: [UsageBreakdownRow]?
    let byModel: [UsageBreakdownRow]?
    let byKind: [UsageBreakdownRow]?
    let byDay: [UsageDay]?
    let recent: [UsageRecord]?
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
