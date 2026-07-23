import SwiftUI

struct ChatView: View {
    let chatId: String

    @Environment(ULTRONClient.self) private var client
    @State private var timeline = ChatTimelineBuilder()
    @State private var composerText = ""
    @State private var isSending = false
    @State private var errorMessage: String?

    @State private var modelId = ""
    @State private var providerId = ""
    @State private var taskMode = "none"
    @State private var securityMode = "bypass"

    @State private var showModelPicker = false
    @State private var showTaskModePicker = false
    @State private var showPermissionPicker = false

    @State private var pendingApprovalId: String?
    @State private var streamTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(timeline.items) { item in
                            row(for: item).id(item.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 12)
                }
                .onChange(of: timeline.items.count) {
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 12)
            }

            ComposerBar(
                text: $composerText,
                modelLabel: modelId.isEmpty ? "Modèle" : modelId,
                taskModeLabel: taskModeLabel,
                permissionLabel: permissionLabel,
                isSending: isSending,
                onSend: send,
                onStop: stop,
                onTapModel: { showModelPicker = true },
                onTapTaskMode: { showTaskModePicker = true },
                onTapPermission: { showPermissionPicker = true }
            )
        }
        .navigationTitle("Conversation")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showModelPicker) {
            ModelPickerSheet { provider, model in
                providerId = provider
                modelId = model
                Task {
                    if provider != providerId { try? await client.setProvider(provider) }
                    _ = try? await client.setModel(model)
                }
            }
        }
        .sheet(isPresented: $showTaskModePicker) {
            TaskModePickerSheet(selected: $taskMode) { _ in }
        }
        .sheet(isPresented: $showPermissionPicker) {
            PermissionPickerSheet(chatId: chatId, selected: $securityMode)
        }
        .task { await bootstrap() }
    }

    private var taskModeLabel: String {
        switch taskMode {
        case "todo": return "To-Do"
        case "plan": return "Plan"
        default: return "Aucun mode"
        }
    }

    private var permissionLabel: String {
        switch securityMode {
        case "manual": return "Manuel"
        case "accept_edit": return "Accept edit"
        default: return "Bypass"
        }
    }

    @ViewBuilder
    private func row(for item: ChatTimelineItem) -> some View {
        switch item {
        case .human(_, let text):
            HumanBubble(text: text)
        case .assistant(_, let text):
            AssistantMessageView(text: text)
        case .toolGroup(_, let calls):
            ToolCallGroupView(calls: calls)
        case .approval(let id, let calls):
            ApprovalCardView(calls: calls) { decisions in
                pendingApprovalId = id
                approve(decisions: decisions)
            }
        }
    }

    private func bootstrap() async {
        do {
            let response = try await client.messages(for: chatId)
            timeline.loadHistory(response.messages)
            let tools = try await client.tools()
            timeline.setToolScopes(tools)
        } catch {
            errorMessage = error.localizedDescription
        }
        do {
            let grouped = try await client.groupedModels()
            modelId = grouped.current
            providerId = grouped.currentProvider
        } catch {
            // Non-fatal: model label just stays empty until picked.
        }
    }

    private func send() {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        composerText = ""
        timeline.addHumanMessage(text)
        runStream(client.streamTurn(chatId: chatId, text: text, taskMode: taskMode))
    }

    private func stop() {
        streamTask?.cancel()
        Task { try? await client.stop(chatId: chatId) }
        isSending = false
        timeline.endTurn()
    }

    private func approve(decisions: [String: Bool]) {
        if let id = pendingApprovalId { timeline.removeApproval(id: id) }
        runStream(client.streamApprove(chatId: chatId, decisions: decisions, taskMode: taskMode))
    }

    private func runStream(_ stream: AsyncThrowingStream<TurnEvent, Error>) {
        isSending = true
        timeline.beginAssistantTurn()
        streamTask = Task {
            do {
                for try await event in stream {
                    switch event {
                    case .text(let delta):
                        timeline.appendText(delta)
                    case .toolCall(let name, let summary):
                        timeline.addToolCall(name: name, summary: summary)
                    case .toolResult(let name, let content):
                        timeline.addToolResult(name: name, content: content)
                    case .approvalRequired(let calls):
                        timeline.addApproval(calls)
                    case .done:
                        break
                    case .goal:
                        break
                    case .aborted:
                        break
                    case .error(let message):
                        errorMessage = message
                    }
                }
            } catch {
                errorMessage = error.localizedDescription
            }
            timeline.endTurn()
            isSending = false
        }
    }
}
