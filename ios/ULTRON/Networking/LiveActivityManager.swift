@preconcurrency import ActivityKit
import Foundation
import Observation
import UIKit

private typealias TaskState = ULTRONTaskActivityAttributes.ContentState

/// Owns the one Live Activity that mirrors the turn currently running from the
/// mobile app.
///
/// Two things bound what this can do. ActivityKit only animates timer-driven
/// views, so "spinning" is a ring anchored on a date rather than a repeating
/// animation (see `StatusIndicator` in the widget). And updates can only be
/// delivered while the app has CPU: a free Apple Developer account cannot sign
/// the Push Notifications capability, so `pushType: .token` is unavailable and
/// the server's APNs path in `src/core/memory/liveActivities.ts` stays dark.
/// The two mitigations here are a background task assertion (buys ~30s after the
/// app leaves the screen, enough for short turns to land their green check) and
/// `reconcile`, which snaps the activity back to the server's real state as soon
/// as the app is active again.
@MainActor
@Observable
final class LiveActivityManager {
    private weak var client: ULTRONClient?
    private var activity: Activity<ULTRONTaskActivityAttributes>?
    private var tokenTask: Task<Void, Never>?

    private var chatId: String?
    private var entries: [TaskState.Entry] = []
    private var startedAt = Date().timeIntervalSince1970
    private var entryCounter = 0
    /// Index into `entries` of the assistant message currently streaming, so a
    /// reply grows one line instead of appending an entry per token.
    private var streamingMessageIndex: Int?
    private var lastPushedAt = Date.distantPast
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    /// Polls the server when a turn is running with no live stream attached.
    private var watchdog: Task<Void, Never>?

    /// Assistant text arrives one delta at a time; pushing every one of them to
    /// ActivityKit would be throttled by the system anyway.
    private let textUpdateInterval: TimeInterval = 0.8
    private let maxEntries = 6

    init(client: ULTRONClient) {
        self.client = client
    }

    var isTracking: Bool { activity != nil }

    // MARK: - Lifecycle

    func start(chatId: String, title: String) async {
        await end()
        self.chatId = chatId
        entries = []
        entryCounter = 0
        streamingMessageIndex = nil
        startedAt = Date().timeIntervalSince1970
        lastPushedAt = Date()

        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        let attributes = ULTRONTaskActivityAttributes(chatId: chatId, title: title)
        let content = ActivityContent(state: currentState(status: .running), staleDate: staleDate())

        // Ask for a push token first so the server can drive the activity on any
        // install whose signing does support it; fall back to a local-only
        // activity otherwise, which is what a free developer account gets.
        var pushed = true
        let activity: Activity<ULTRONTaskActivityAttributes>
        do {
            activity = try Activity.request(attributes: attributes, content: content, pushType: .token)
        } catch {
            pushed = false
            do {
                activity = try Activity.request(attributes: attributes, content: content, pushType: nil)
            } catch {
                self.activity = nil
                return
            }
        }

        self.activity = activity
        guard pushed else { return }
        tokenTask = Task { [weak self, weak activity] in
            guard let activity else { return }
            for await tokenData in activity.pushTokenUpdates {
                guard let self else { return }
                let token = tokenData.map { String(format: "%02x", $0) }.joined()
                await self.client?.registerLiveActivity(
                    chatId: attributes.chatId,
                    activityId: activity.id,
                    pushToken: token
                )
            }
        }
    }

    func finish(success: Bool) async {
        guard let activity else { return }
        let state = currentState(status: success ? .completed : .failed)
        // Keep the outcome on screen briefly rather than yanking it away the
        // instant the turn ends — the green check / red cross is the point.
        await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .after(.now + 8))
        teardown()
    }

    func end() async {
        guard let activity else { return }
        await activity.end(nil, dismissalPolicy: .immediate)
        teardown()
    }

    private func teardown() {
        tokenTask?.cancel()
        tokenTask = nil
        watchdog?.cancel()
        watchdog = nil
        activity = nil
        chatId = nil
        streamingMessageIndex = nil
        endBackgroundHold()
    }

    /// A live event means the stream is feeding us again, so polling is redundant.
    private func cancelWatchdog() {
        watchdog?.cancel()
        watchdog = nil
    }

    // MARK: - Turn events

    /// `fullText` is the reply accumulated so far, not the latest delta — the
    /// streaming line is rewritten in place with its tail.
    func noteAssistantText(_ fullText: String) async {
        cancelWatchdog()
        let trimmed = fullText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let text = String(trimmed.suffix(140))

        if let index = streamingMessageIndex, entries.indices.contains(index) {
            entries[index] = TaskState.Entry(id: entries[index].id, kind: .message, text: text)
        } else {
            append(kind: .message, text: text)
            streamingMessageIndex = entries.count - 1
        }
        await push(status: .running, throttled: true)
    }

    func noteToolCall(name: String, summary: String) async {
        cancelWatchdog()
        // A tool call closes the streaming message: whatever text comes next is
        // a new paragraph of the reply, not a continuation of that line.
        streamingMessageIndex = nil
        // The server falls back to the bare tool name when a call has no
        // arguments worth showing; don't print it twice.
        let detail = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        append(kind: .tool, text: detail.isEmpty || detail == name ? name : "\(name) — \(detail)")
        await push(status: .running, throttled: false)
    }

    func noteToolResult(name: String, content: String) async {
        cancelWatchdog()
        streamingMessageIndex = nil
        let detail = content.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\n", with: " ")
        guard !detail.isEmpty else { return }
        append(kind: .tool, text: "\(name) → \(String(detail.prefix(120)))")
        await push(status: .running, throttled: false)
    }

    func noteApprovalRequired() async {
        cancelWatchdog()
        streamingMessageIndex = nil
        append(kind: .status, text: "Approbation requise")
        await push(status: .waitingForApproval, throttled: false)
    }

    // MARK: - Background continuation

    /// Called when the app leaves the screen mid-turn. Buys a short extension so
    /// the SSE stream can keep feeding the activity; without a signed push
    /// capability this is the only way a turn finishing seconds later still
    /// shows its outcome.
    func beginBackgroundHold() {
        guard activity != nil, backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "ultron.turn") { [weak self] in
            Task { @MainActor in self?.endBackgroundHold() }
        }
    }

    func endBackgroundHold() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    /// Pull the turn's real state back from the server. The activity freezes on
    /// its last known state once iOS suspends the app, so this is what makes a
    /// long turn resolve to a check or a cross when the user comes back.
    func reconcile() async {
        _ = await reconcileOnce()
    }

    /// The SSE stream dies when iOS suspends the app, but the server keeps
    /// running an app-originated turn on purpose (see `streamGraphTurn`). So a
    /// transport failure says nothing about the turn's outcome — asking the
    /// server is the only way to avoid flashing a red cross over work that
    /// actually succeeded.
    func resolveAfterStreamFailure() async {
        guard activity != nil else { return }
        if await reconcileOnce() { return }
        await finish(success: false)
    }

    /// Returns false when the server had nothing to say, so the caller can fall
    /// back to its own conclusion.
    private func reconcileOnce() async -> Bool {
        guard let chatId, activity != nil, let client else { return false }
        guard let remote = await client.liveActivityState(chatId: chatId) else { return false }

        if !remote.entries.isEmpty {
            entries = remote.entries.suffix(maxEntries).map {
                TaskState.Entry(id: $0.id, kind: TaskState.Entry.Kind(rawValue: $0.kind) ?? .message, text: $0.text)
            }
            streamingMessageIndex = nil
        }
        if remote.startedAt > 0 { startedAt = remote.startedAt }

        switch remote.status {
        case "completed":
            await finish(success: true)
        case "failed":
            await finish(success: false)
        case "waitingForApproval":
            await push(status: .waitingForApproval, throttled: false)
        default:
            // Still working: the socket died, not the turn. Nothing is feeding
            // the activity any more, so poll until it lands.
            await push(status: .running, throttled: false)
            startWatchdog()
        }
        return true
    }

    /// Polls the server while a turn is known to be running with no stream
    /// attached, so the ring still resolves to a check or a cross without
    /// waiting for the user to background and foreground the app again.
    private func startWatchdog() {
        guard watchdog == nil else { return }
        watchdog = Task { [weak self] in
            for _ in 0..<200 {
                try? await Task.sleep(for: .seconds(3))
                guard let self, !Task.isCancelled else { return }
                guard let chatId = self.chatId, self.activity != nil, let client = self.client else { return }
                guard let remote = await client.liveActivityState(chatId: chatId) else { return }
                switch remote.status {
                case "completed":
                    await self.finish(success: true)
                    return
                case "failed":
                    await self.finish(success: false)
                    return
                default:
                    self.entries = remote.entries.suffix(self.maxEntries).map {
                        TaskState.Entry(id: $0.id, kind: TaskState.Entry.Kind(rawValue: $0.kind) ?? .message, text: $0.text)
                    }
                    let status: TaskState.Status = remote.status == "waitingForApproval" ? .waitingForApproval : .running
                    await self.push(status: status, throttled: false)
                }
            }
        }
    }

    // MARK: - Internals

    private func append(kind: TaskState.Entry.Kind, text: String) {
        entryCounter += 1
        entries.append(TaskState.Entry(id: "\(entryCounter)", kind: kind, text: String(text.prefix(160))))
        if entries.count > maxEntries {
            let dropped = entries.count - maxEntries
            entries.removeFirst(dropped)
            if let index = streamingMessageIndex { streamingMessageIndex = max(0, index - dropped) }
        }
    }

    private func currentState(status: TaskState.Status) -> TaskState {
        TaskState(
            status: status,
            entries: entries,
            startedAt: startedAt,
            ringStartedAt: Date().timeIntervalSince1970
        )
    }

    private func push(status: TaskState.Status, throttled: Bool) async {
        guard let activity else { return }
        if throttled, Date().timeIntervalSince(lastPushedAt) < textUpdateInterval { return }
        lastPushedAt = Date()
        await activity.update(ActivityContent(state: currentState(status: status), staleDate: staleDate()))
    }

    /// Marks the activity stale if nothing has updated it for a while, so a turn
    /// that died with the app suspended stops looking live.
    private func staleDate() -> Date {
        Date(timeIntervalSinceNow: 5 * 60)
    }
}
