import Foundation
import Observation

enum ULTRONError: LocalizedError {
    case noServerConfigured
    case badStatus(Int, String)
    case invalidURL

    var errorDescription: String? {
        switch self {
        case .noServerConfigured:
            return "Aucun serveur ULTRON configuré. Renseigne l'adresse dans Réglages."
        case .badStatus(let code, let body):
            return "Erreur serveur (\(code)): \(body)"
        case .invalidURL:
            return "URL de serveur invalide."
        }
    }
}

/// HTTP/SSE client for ULTRON's web server, mirroring src/interfaces/cli/remote.ts:
/// no auth beyond reaching the server over Tailscale, no local business logic —
/// the server is the single source of truth. MainActor-isolated: every call site
/// is a SwiftUI view already on the main actor, so this avoids Swift 6 strict-
/// concurrency "sending across isolation domains" errors without adding Sendable
/// ceremony to a client that's never used concurrently.
@MainActor
@Observable
final class ULTRONClient {
    var serverURLString: String {
        didSet { UserDefaults.standard.set(serverURLString, forKey: Self.defaultsKey) }
    }

    private static let defaultsKey = "ultron.serverURL"
    private let session: URLSession

    init() {
        self.serverURLString = UserDefaults.standard.string(forKey: Self.defaultsKey) ?? ""
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 3600
        self.session = URLSession(configuration: config)
    }

    var baseURL: URL? {
        guard !serverURLString.isEmpty else { return nil }
        var trimmed = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasSuffix("/") { trimmed.removeLast() }
        return URL(string: trimmed)
    }

    private func url(_ path: String) throws -> URL {
        guard let base = baseURL else { throw ULTRONError.noServerConfigured }
        guard let url = URL(string: path, relativeTo: base) else { throw ULTRONError.invalidURL }
        return url
    }

    // MARK: - Generic request helpers

    private func request<Body: Encodable, Response: Decodable>(
        _ method: String,
        _ path: String,
        body: Body
    ) async throws -> Response {
        var req = URLRequest(url: try url(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: req)
        try Self.checkStatus(response, data: data)
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private func requestNoBody<Response: Decodable>(_ method: String, _ path: String) async throws -> Response {
        var req = URLRequest(url: try url(path))
        req.httpMethod = method
        let (data, response) = try await session.data(for: req)
        try Self.checkStatus(response, data: data)
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private static func checkStatus(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw ULTRONError.badStatus(http.statusCode, text)
        }
    }

    // MARK: - Health / status

    struct HealthStatus: Codable { let status: String; let uptimeSeconds: Double; let model: String; let databaseReachable: Bool }
    func health() async throws -> HealthStatus { try await requestNoBody("GET", "/api/health") }

    // MARK: - Chats

    struct ChatsResponse: Codable { let chats: [Chat] }
    func listChats() async throws -> [Chat] {
        let response: ChatsResponse = try await requestNoBody("GET", "/api/chats")
        return response.chats
    }
    func listArchivedChats() async throws -> [Chat] {
        let response: ChatsResponse = try await requestNoBody("GET", "/api/chats/archived")
        return response.chats
    }

    struct CreateChatBody: Encodable { let title: String?; let agentId: String?; let origin: String }
    struct ChatResponse: Codable { let chat: Chat }
    func createChat(title: String? = nil) async throws -> Chat {
        let response: ChatResponse = try await request("POST", "/api/chats", body: CreateChatBody(title: title, agentId: nil, origin: "app"))
        return response.chat
    }

    struct RenameChatBody: Encodable { let title: String }
    func renameChat(_ id: String, title: String) async throws -> Chat {
        let response: ChatResponse = try await request("PATCH", "/api/chats/\(id)", body: RenameChatBody(title: title))
        return response.chat
    }

    struct DeletedResponse: Codable { let deleted: Bool }
    func deleteChat(_ id: String) async throws {
        let _: DeletedResponse = try await requestNoBody("DELETE", "/api/chats/\(id)")
    }

    struct ArchiveResponse: Codable { let archived: Chat; let fresh: Chat }
    func archiveChat(_ id: String) async throws -> ArchiveResponse {
        try await request("POST", "/api/chats/\(id)/archive", body: EmptyBody())
    }

    func resumeChat(_ id: String) async throws -> Chat {
        let response: ChatResponse = try await requestNoBody("POST", "/api/chats/\(id)/resume")
        return response.chat
    }

    struct MessagesResponse: Codable { let messages: [ChatMessage]; let running: Bool }
    func messages(for chatId: String) async throws -> MessagesResponse {
        try await requestNoBody("GET", "/api/chats/\(chatId)/messages")
    }

    struct SecurityModeBody: Encodable { let mode: String }
    func setSecurityMode(_ chatId: String, mode: String) async throws -> Chat {
        let response: ChatResponse = try await request("PATCH", "/api/chats/\(chatId)/security", body: SecurityModeBody(mode: mode))
        return response.chat
    }

    // MARK: - Todos

    struct TodosResponse: Codable { let items: [TodoItem] }
    func todos(for chatId: String) async throws -> [TodoItem] {
        let response: TodosResponse = try await requestNoBody("GET", "/api/chats/\(chatId)/todos")
        return response.items
    }

    // MARK: - Models / provider

    struct ModelsResponse: Codable { let current: String; let models: [ModelInfo] }
    func models() async throws -> ModelsResponse { try await requestNoBody("GET", "/api/models") }

    struct GroupedModelsResponse: Codable { let current: String; let currentProvider: String; let groups: [ModelGroup] }
    func groupedModels() async throws -> GroupedModelsResponse { try await requestNoBody("GET", "/api/models/grouped") }

    struct SetModelBody: Encodable { let model: String }
    struct SetModelResponse: Codable { let model: String }
    func setModel(_ model: String) async throws -> SetModelResponse {
        try await request("PATCH", "/api/model", body: SetModelBody(model: model))
    }

    struct ProviderResponse: Codable { let current: String; let providers: [String]; let configured: [String] }
    func provider() async throws -> ProviderResponse { try await requestNoBody("GET", "/api/provider") }

    struct SetProviderBody: Encodable { let provider: String }
    struct SetProviderResponse: Codable { let provider: String; let model: String }
    func setProvider(_ provider: String) async throws -> SetProviderResponse {
        try await request("PATCH", "/api/provider", body: SetProviderBody(provider: provider))
    }

    // MARK: - OpenAI ChatGPT device-code login

    struct OpenAILoginStartResponse: Codable { let loginId: String; let verificationUrl: String; let userCode: String }
    func openAILoginStart() async throws -> OpenAILoginStartResponse {
        try await request("POST", "/api/openai/login/start", body: EmptyBody())
    }

    struct OpenAILoginStatusResponse: Codable { let status: String; let error: String? }
    func openAILoginStatus(loginId: String) async throws -> OpenAILoginStatusResponse {
        try await requestNoBody("GET", "/api/openai/login/status?loginId=\(loginId)")
    }

    struct OpenAIStatusResponse: Codable { let authenticated: Bool; let accountEmail: String? }
    func openAIStatus() async throws -> OpenAIStatusResponse {
        try await requestNoBody("GET", "/api/openai/status")
    }

    // MARK: - Tools / Skills

    struct ToolsResponse: Codable { let tools: [Tool] }
    func tools() async throws -> [Tool] {
        let response: ToolsResponse = try await requestNoBody("GET", "/api/tools")
        return response.tools
    }

    struct SkillsResponse: Codable { let skills: [Skill] }
    func skills() async throws -> [Skill] {
        let response: SkillsResponse = try await requestNoBody("GET", "/api/skills")
        return response.skills
    }

    struct InstallSkillBody: Encodable { let name: String }
    struct InstallSkillResponse: Codable { let installed: Bool; let name: String }
    func installSkill(_ name: String) async throws -> InstallSkillResponse {
        try await request("POST", "/api/skills/install", body: InstallSkillBody(name: name))
    }

    // MARK: - Finance

    func financeSummary(days: Int = 30) async throws -> FinanceSummary {
        try await requestNoBody("GET", "/api/finance/summary?days=\(days)")
    }

    struct CreateAccountBody: Encodable { let name: String; let type: String; let currency: String? }
    struct AccountResponse: Codable { let account: FinanceAccount }
    func createFinanceAccount(name: String, type: String, currency: String? = nil) async throws -> FinanceAccount {
        let response: AccountResponse = try await request("POST", "/api/finance/accounts", body: CreateAccountBody(name: name, type: type, currency: currency))
        return response.account
    }

    func deleteFinanceAccount(_ id: String) async throws {
        let _: DeletedResponse = try await requestNoBody("DELETE", "/api/finance/accounts/\(id)")
    }

    struct RecordBalanceBody: Encodable { let balance: Double; let date: String? }
    struct BalanceResponse: Codable { let snapshot: JSONValue }
    func recordBalance(accountId: String, balance: Double, date: String? = nil) async throws {
        let _: BalanceResponse = try await request(
            "POST", "/api/finance/accounts/\(accountId)/balance",
            body: RecordBalanceBody(balance: balance, date: date)
        )
    }

    struct AddTransactionBody: Encodable { let description: String; let amount: Double; let date: String?; let category: String? }
    struct TransactionResponse: Codable { let transaction: FinanceTransaction }
    func addTransaction(accountId: String, description: String, amount: Double, date: String? = nil, category: String? = nil) async throws -> FinanceTransaction {
        let response: TransactionResponse = try await request(
            "POST", "/api/finance/accounts/\(accountId)/transactions",
            body: AddTransactionBody(description: description, amount: amount, date: date, category: category)
        )
        return response.transaction
    }

    // MARK: - Health

    func healthSummary() async throws -> HealthSummary {
        try await requestNoBody("GET", "/api/health-data/summary")
    }

    // MARK: - Usage

    func usageSummary(days: Int = 30) async throws -> UsageSummary {
        try await requestNoBody("GET", "/api/usage/summary?days=\(days)")
    }

    // MARK: - Memory

    struct MemoryResponse: Codable { let observations: [UserModelObservation]; let count: Int }
    func memoryObservations() async throws -> MemoryResponse { try await requestNoBody("GET", "/api/memory") }

    struct StatusOnly: Codable { let status: String }
    func clearMemory() async throws {
        let _: StatusOnly = try await requestNoBody("DELETE", "/api/memory")
    }
    func forgetMemory(_ id: Int) async throws {
        let _: StatusOnly = try await requestNoBody("DELETE", "/api/memory/\(id)")
    }

    // MARK: - Search

    struct SearchMatch: Codable { let snippet: String }
    struct SearchResult: Codable, Identifiable { let chatId: String; let chatTitle: String; let updatedAt: String; let matches: [SearchMatch]; var id: String { chatId } }
    struct SearchResponse: Codable { let results: [SearchResult] }
    func search(query: String) async throws -> [SearchResult] {
        let encoded = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        let response: SearchResponse = try await requestNoBody("GET", "/api/search?q=\(encoded)")
        return response.results
    }

    // MARK: - Stop

    struct ChatIdBody: Encodable { let chatId: String }
    func stop(chatId: String) async throws {
        let _: DeletedResponse = try await request("POST", "/api/stop", body: ChatIdBody(chatId: chatId))
    }

    // MARK: - Turn streaming

    struct TurnBody: Encodable {
        let chatId: String
        let text: String?
        let thinking: String?
        let taskMode: String?
        let retry: Bool?
    }

    struct ApproveBody: Encodable {
        let chatId: String
        let thinking: String?
        let taskMode: String?
        let decisions: [String: Bool]
    }

    func streamTurn(
        chatId: String,
        text: String?,
        thinking: String = "full",
        taskMode: String = "none",
        retry: Bool = false
    ) -> AsyncThrowingStream<TurnEvent, Error> {
        stream(path: "/api/turn", body: TurnBody(chatId: chatId, text: text, thinking: thinking, taskMode: taskMode, retry: retry))
    }

    func streamApprove(
        chatId: String,
        decisions: [String: Bool],
        thinking: String = "full",
        taskMode: String = "none"
    ) -> AsyncThrowingStream<TurnEvent, Error> {
        stream(path: "/api/approve", body: ApproveBody(chatId: chatId, thinking: thinking, taskMode: taskMode, decisions: decisions))
    }

    private func stream(path: String, body: some Encodable) -> AsyncThrowingStream<TurnEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard let base = baseURL else { throw ULTRONError.noServerConfigured }
                    guard let requestURL = URL(string: path, relativeTo: base) else { throw ULTRONError.invalidURL }
                    var req = URLRequest(url: requestURL)
                    req.httpMethod = "POST"
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    req.httpBody = try JSONEncoder().encode(body)

                    let (bytes, response) = try await session.bytes(for: req)
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        var collected = Data()
                        for try await byte in bytes { collected.append(byte) }
                        throw ULTRONError.badStatus(http.statusCode, String(data: collected, encoding: .utf8) ?? "")
                    }

                    let parser = SSEParser()
                    var lineBuffer = Data()
                    for try await byte in bytes {
                        lineBuffer.append(byte)
                        guard let chunkString = String(data: lineBuffer, encoding: .utf8) else { continue }
                        lineBuffer.removeAll()
                        let frames = await parser.feed(chunkString)
                        for frame in frames {
                            if let event = Self.decodeFrame(frame) {
                                continuation.yield(event)
                            }
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func decodeFrame(_ frame: SSEFrame) -> TurnEvent? {
        let data = Data(frame.data.utf8)
        let decoder = JSONDecoder()
        switch frame.event {
        case "text":
            struct Payload: Codable { let delta: String }
            guard let payload = try? decoder.decode(Payload.self, from: data) else { return nil }
            return .text(payload.delta)
        case "tool_call":
            struct Payload: Codable { let name: String; let summary: String }
            guard let payload = try? decoder.decode(Payload.self, from: data) else { return nil }
            return .toolCall(name: payload.name, summary: payload.summary)
        case "tool_result":
            struct Payload: Codable { let name: String; let content: String }
            guard let payload = try? decoder.decode(Payload.self, from: data) else { return nil }
            return .toolResult(name: payload.name, content: payload.content)
        case "approval_required":
            struct Payload: Codable { let calls: [PendingToolCall] }
            guard let payload = try? decoder.decode(Payload.self, from: data) else { return nil }
            return .approvalRequired(payload.calls)
        case "done":
            guard let payload = try? decoder.decode(TurnDoneStats.self, from: data) else { return nil }
            return .done(payload)
        case "goal":
            struct Payload: Codable { let status: String; let reason: String }
            guard let payload = try? decoder.decode(Payload.self, from: data) else { return nil }
            return .goal(status: payload.status, reason: payload.reason)
        case "aborted":
            return .aborted
        case "error":
            struct Payload: Codable { let message: String }
            guard let payload = try? decoder.decode(Payload.self, from: data) else { return .error("erreur inconnue") }
            return .error(payload.message)
        default:
            return nil
        }
    }
}

struct EmptyBody: Encodable {}
