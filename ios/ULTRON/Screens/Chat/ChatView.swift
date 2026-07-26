import SwiftUI
import AVFoundation
import PhotosUI

struct ChatView: View {
    let chatId: String

    @Environment(ULTRONClient.self) private var client
    @Environment(LiveActivityManager.self) private var liveActivity
    @State private var timeline = ChatTimelineBuilder()
    @State private var composerText = ""
    @State private var isSending = false
    @State private var errorMessage: String?

    @State private var modelId = ""
    @State private var providerId = ""
    @State private var thinkingMode = "full"
    @State private var reasoningProfile: ReasoningProfile?
    @State private var taskMode = "none"
    @State private var securityMode = "bypass"
    @State private var verbose = false
    @State private var verboseStats: String?
    @State private var photoItem: PhotosPickerItem?
    @State private var isRecording = false
    @State private var recorder: AVAudioRecorder?

    @State private var showModelPicker = false
    @State private var showThinkingModePicker = false
    @State private var showTaskModePicker = false
    @State private var showPermissionPicker = false

    @State private var pendingApprovalId: String?
    @State private var streamTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(timeline.items.filter(isVisible)) { item in
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

            if verbose, let verboseStats {
                Text(verboseStats)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
            }

            ComposerBar(
                text: $composerText,
                modelLabel: modelId.isEmpty ? "Modèle" : modelId,
                thinkingModeLabel: thinkingModeLabel,
                taskModeLabel: taskModeLabel,
                permissionLabel: permissionLabel,
                verbose: verbose,
                isSending: isSending,
                photoItem: $photoItem,
                isRecording: isRecording,
                onSend: { send() },
                onStop: { stop() },
                onTapModel: { showModelPicker = true },
                onTapThinkingMode: { showThinkingModePicker = true },
                onTapTaskMode: { showTaskModePicker = true },
                onTapPermission: { showPermissionPicker = true },
                onToggleVerbose: { verbose.toggle() },
                onToggleRecording: { toggleRecording() }
            )
        }
        .navigationTitle("Conversation")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showModelPicker) {
            ModelPickerSheet { provider, model in
                let previousProvider = providerId
                providerId = provider
                modelId = model
                Task {
                    if provider != previousProvider { try? await client.setProvider(provider) }
                    _ = try? await client.setModel(model)
                    await loadReasoningProfile()
                }
            }
        }
        .sheet(isPresented: $showThinkingModePicker) {
            ThinkingModePickerSheet(selected: $thinkingMode, profile: reasoningProfile) { _ in }
        }
        .sheet(isPresented: $showTaskModePicker) {
            TaskModePickerSheet(selected: $taskMode) { _ in }
        }
        .sheet(isPresented: $showPermissionPicker) {
            PermissionPickerSheet(chatId: chatId, selected: $securityMode)
        }
        .navigationDestination(for: SubAgentRoute.self) { route in
            SubAgentChatView(route: route)
        }
        .task { await bootstrap() }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task { await attachPhoto(item) }
            photoItem = nil
        }
    }

    private var taskModeLabel: String {
        switch taskMode {
        case "todo": return "To-Do"
        case "plan": return "Plan"
        case "goal": return "Objectif"
        case "deep_research": return "Deep Research"
        default: return "Aucun mode"
        }
    }

    private var thinkingModeLabel: String {
        switch thinkingMode {
        case "low": return "Réduit"
        case "default": return "Par défaut"
        case "medium": return "Medium"
        case "high": return "High"
        case "max": return "Max"
        case "off": return "Sans raisonnement"
        default: return "Complet"
        }
    }

    private var permissionLabel: String {
        switch securityMode {
        case "manual": return "Manuel"
        case "accept_edit": return "Accept edit"
        default: return "Bypass"
        }
    }

    /// The model sometimes emits an assistant turn between tool calls whose
    /// visible content is empty or a bare `""` (a stringified empty JSON
    /// value) — filtered out here rather than at the row level so the
    /// LazyVStack's inter-item spacing doesn't still leave a visible gap.
    private func isVisible(_ item: ChatTimelineItem) -> Bool {
        guard case .assistant(_, let text) = item else { return true }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed != "\"\"" && trimmed != "\""
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
            await loadReasoningProfile()
        } catch {
            // Non-fatal: model label just stays empty until picked.
        }
    }

    private func loadReasoningProfile() async {
        guard !providerId.isEmpty, !modelId.isEmpty else { return }
        do {
            let profile = try await client.reasoningProfile(provider: providerId, model: modelId)
            reasoningProfile = profile
            if !profile.options.contains(thinkingMode) { thinkingMode = profile.defaultMode ?? profile.options.first ?? "off" }
        } catch {
            reasoningProfile = nil
            thinkingMode = "off"
        }
    }

    private func send(textOverride: String? = nil) {
        let text = (textOverride ?? composerText).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        composerText = ""
        timeline.addHumanMessage(text)
        verboseStats = nil
        Task { await liveActivity.start(chatId: chatId, title: "ULTRON") }
        runStream(client.streamTurn(chatId: chatId, text: text, thinking: thinkingMode, taskMode: taskMode))
    }

    private func attachPhoto(_ item: PhotosPickerItem) async {
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            let mimeType = item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"
            let extensionName = mimeType.split(separator: "/").last.map(String.init) ?? "jpg"
            let saved = try await client.uploadFile(chatId: chatId, filename: "photo.\(extensionName)", data: data)
            let note = "[Attached image]\n- \(saved.path)"
            composerText = composerText.isEmpty ? note : "\(composerText)\n\n\(note)"
        } catch {
            errorMessage = "Impossible d'importer la photo : \(error.localizedDescription)"
        }
    }

    private func toggleRecording() {
        if isRecording {
            finishRecording()
        } else {
            requestMicrophoneAndRecord()
        }
    }

    private func requestMicrophoneAndRecord() {
        let permission = AVAudioSession.sharedInstance().recordPermission
        if permission == .denied {
            errorMessage = "L'accès au microphone est désactivé dans Réglages."
            return
        }
        if permission == .undetermined {
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                Task { @MainActor in
                    if granted { startRecording() }
                    else { errorMessage = "L'accès au microphone est nécessaire pour dicter." }
                }
            }
        } else {
            startRecording()
        }
    }

    private func startRecording() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .spokenAudio, options: [.allowBluetooth])
            try session.setActive(true)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("ultron-voice-\(UUID().uuidString).m4a")
            recorder = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
            ])
            recorder?.record()
            isRecording = true
        } catch {
            errorMessage = "Impossible de démarrer le microphone : \(error.localizedDescription)"
        }
    }

    private func finishRecording() {
        guard let recorder else { return }
        recorder.stop()
        self.recorder = nil
        isRecording = false
        let url = recorder.url
        Task {
            do {
                let data = try Data(contentsOf: url)
                let transcript = try await client.transcribe(data: data)
                let combined = composerText.isEmpty ? transcript : "\(composerText) \(transcript)"
                send(textOverride: combined)
                try? FileManager.default.removeItem(at: url)
            } catch {
                errorMessage = "Transcription Voxtral impossible : \(error.localizedDescription)"
            }
        }
    }

    private func stop() {
        streamTask?.cancel()
        Task { try? await client.stop(chatId: chatId) }
        Task { await liveActivity.end() }
        isSending = false
        timeline.endTurn()
    }

    private func approve(decisions: [String: Bool]) {
        if let id = pendingApprovalId { timeline.removeApproval(id: id) }
        runStream(client.streamApprove(chatId: chatId, decisions: decisions, thinking: thinkingMode, taskMode: taskMode))
    }

    private func runStream(_ stream: AsyncThrowingStream<TurnEvent, Error>) {
        isSending = true
        timeline.beginAssistantTurn()
        streamTask = Task {
            var terminalEventReceived = false
            // The Live Activity rewrites its streaming line in place, so it needs
            // the reply accumulated so far rather than the latest delta.
            var assistantText = ""
            do {
                for try await event in stream {
                    switch event {
                    case .text(let delta):
                        timeline.appendText(delta)
                        assistantText += delta
                        await liveActivity.noteAssistantText(assistantText)
                    case .toolCall(let name, let summary):
                        timeline.addToolCall(name: name, summary: summary)
                        assistantText = ""
                        await liveActivity.noteToolCall(name: name, summary: summary)
                    case .toolResult(let name, let content):
                        timeline.addToolResult(name: name, content: content)
                        assistantText = ""
                        await liveActivity.noteToolResult(name: name, content: content)
                    case .approvalRequired(let calls):
                        timeline.addApproval(calls)
                        await liveActivity.noteApprovalRequired()
                    case .done(let stats):
                        verboseStats = stats.stats
                        terminalEventReceived = true
                        await liveActivity.finish(success: true)
                    case .goal:
                        break
                    case .aborted:
                        terminalEventReceived = true
                        await liveActivity.finish(success: false)
                    case .error(let message):
                        errorMessage = message
                        terminalEventReceived = true
                        await liveActivity.finish(success: false)
                    }
                }
            } catch {
                errorMessage = error.localizedDescription
                terminalEventReceived = true
                // A dead socket is not a failed turn: the server keeps running
                // app-originated turns, so let the Live Activity ask it what
                // really happened instead of claiming a failure.
                await liveActivity.resolveAfterStreamFailure()
            }
            if !terminalEventReceived && !isSending {
                await liveActivity.resolveAfterStreamFailure()
            }
            timeline.endTurn()
            isSending = false
        }
    }
}
