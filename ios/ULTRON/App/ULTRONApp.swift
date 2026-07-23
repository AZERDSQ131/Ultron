import SwiftUI

@main
struct ULTRONApp: App {
    @State private var client = ULTRONClient()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(client)
        }
    }
}
