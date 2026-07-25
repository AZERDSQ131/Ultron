import ActivityKit

struct ULTRONTaskActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum Status: String, Codable, Hashable {
            case running
            case completed
            case failed
            case waitingForApproval
        }

        struct Action: Codable, Hashable, Identifiable {
            let id: String
            let label: String
        }

        let status: Status
        let latestAction: String
        let actions: [Action]
    }

    let chatId: String
    let title: String
}
