import SwiftUI

@main
struct ULTRONApp: App {
    @State private var client: ULTRONClient
    @State private var liveActivityManager: LiveActivityManager

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
        }
    }
}
