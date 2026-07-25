@preconcurrency import ActivityKit
import Foundation
import Observation

@MainActor
@Observable
final class LiveActivityManager {
    private weak var client: ULTRONClient?
    private var activity: Activity<ULTRONTaskActivityAttributes>?
    private var tokenTask: Task<Void, Never>?
    private var actions: [ULTRONTaskActivityAttributes.ContentState.Action] = []
    private var actionCounter = 0

    init(client: ULTRONClient) {
        self.client = client
    }

    func start(chatId: String, title: String) async {
        await end()
        actions = []
        actionCounter = 0
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        let attributes = ULTRONTaskActivityAttributes(chatId: chatId, title: title)
        let state = ULTRONTaskActivityAttributes.ContentState(
            status: .running,
            latestAction: "Traitement en cours",
            actions: []
        )

        let activity: Activity<ULTRONTaskActivityAttributes>
        var supportsPushUpdates = true
        do {
            activity = try Activity.request(
                attributes: attributes,
                content: ActivityContent(state: state, staleDate: Date(timeIntervalSinceNow: 15 * 60)),
                pushType: .token
            )
        } catch {
            // Personal Apple teams cannot sign Push Notifications. Fall back
            // to a local-only Live Activity so the Dynamic Island still works.
            supportsPushUpdates = false
            do {
                activity = try Activity.request(
                    attributes: attributes,
                    content: ActivityContent(state: state, staleDate: Date(timeIntervalSinceNow: 15 * 60)),
                    pushType: nil
                )
            } catch {
                self.activity = nil
                return
            }
        }

        self.activity = activity
        if supportsPushUpdates {
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
    }

    func update(status: ULTRONTaskActivityAttributes.ContentState.Status, action: String? = nil) async {
        guard let activity else { return }
        if let action { appendAction(action) }
        let state = ULTRONTaskActivityAttributes.ContentState(
            status: status,
            latestAction: action ?? latestAction(for: status),
            actions: actions
        )
        await activity.update(ActivityContent(state: state, staleDate: Date(timeIntervalSinceNow: 15 * 60)))
    }

    func appendText(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await update(status: .running, action: "Réponse : \(String(trimmed.suffix(140)))")
    }

    func finish(success: Bool) async {
        guard let activity else { return }
        let status: ULTRONTaskActivityAttributes.ContentState.Status = success ? .completed : .failed
        let label = success ? "Terminé" : "Échec"
        appendAction(label)
        let state = ULTRONTaskActivityAttributes.ContentState(status: status, latestAction: label, actions: actions)
        await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .default)
        tokenTask?.cancel()
        tokenTask = nil
        self.activity = nil
    }

    func end() async {
        guard let activity else { return }
        await activity.end(nil, dismissalPolicy: .immediate)
        tokenTask?.cancel()
        tokenTask = nil
        self.activity = nil
    }

    private func appendAction(_ label: String) {
        actionCounter += 1
        let action = ULTRONTaskActivityAttributes.ContentState.Action(
            id: "\(actionCounter)",
            label: String(label.prefix(160))
        )
        actions = Array((actions + [action]).suffix(5))
    }

    private func latestAction(for status: ULTRONTaskActivityAttributes.ContentState.Status) -> String {
        switch status {
        case .running: return "Traitement en cours"
        case .completed: return "Terminé"
        case .failed: return "Échec"
        case .waitingForApproval: return "Approbation requise"
        }
    }
}
