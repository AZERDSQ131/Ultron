import SwiftUI

@main
struct ULTRONApp: App {
    @State private var client: ULTRONClient
    @State private var liveActivityManager: LiveActivityManager
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let client = ULTRONClient()
        _client = State(initialValue: client)
        _liveActivityManager = State(initialValue: LiveActivityManager(client: client))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(client)
                .environment(liveActivityManager)
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .inactive, .background:
                        // Claim the background assertion before iOS suspends us,
                        // so an in-flight turn keeps streaming into the Live
                        // Activity for a few more seconds.
                        liveActivityManager.beginBackgroundHold()
                    case .active:
                        liveActivityManager.endBackgroundHold()
                        // The activity froze on whatever state it had when we
                        // lost CPU; ask the server what really happened.
                        Task { await liveActivityManager.reconcile() }
                    @unknown default:
                        break
                    }
                }
        }
    }
}
