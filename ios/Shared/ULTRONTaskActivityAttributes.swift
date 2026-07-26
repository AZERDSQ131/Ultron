import ActivityKit
import Foundation

/// Shared by the app (`LiveActivityManager`) and the widget extension
/// (`ULTRONLiveActivity`). The server encodes this exact `ContentState` shape
/// in its APNs payload (`src/core/memory/liveActivities.ts`), so any field
/// added here has to be added there too or a pushed update silently fails to
/// decode.
struct ULTRONTaskActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum Status: String, Codable, Hashable {
            case running
            case completed
            case failed
            case waitingForApproval
        }

        /// One transcript line, as listed when the Dynamic Island is expanded.
        /// `kind` is what lets that view tell an assistant message apart from a
        /// tool invocation at a glance instead of relying on a text prefix.
        struct Entry: Codable, Hashable, Identifiable {
            enum Kind: String, Codable, Hashable {
                case message
                case tool
                /// Not part of the conversation: an approval request or a failure
                /// reason, worth a line of its own in the expanded view.
                case status
            }

            let id: String
            let kind: Kind
            let text: String
        }

        let status: Status
        let entries: [Entry]
        /// Unix epoch seconds — deliberately not `Date`, so the server can emit
        /// plain JSON numbers without having to match a Codable date strategy.
        /// Drives the elapsed counter, which counts up on its own and so keeps
        /// moving even while the app is suspended and nothing can update the
        /// activity.
        let startedAt: Double
    }

    let chatId: String
    let title: String
}

extension ULTRONTaskActivityAttributes.ContentState {
    var startedDate: Date { Date(timeIntervalSince1970: startedAt) }

    /// The last thing that happened, used as the one-line summary on the Lock
    /// Screen and at the top of the expanded view.
    var headline: String {
        entries.last?.text ?? "Traitement en cours"
    }
}
