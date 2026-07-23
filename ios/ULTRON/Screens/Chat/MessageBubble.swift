import SwiftUI

struct HumanBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 40)
            Text(text)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 18).fill(Color.accentColor.opacity(0.15)))
        }
    }
}

struct AssistantMessageView: View {
    let text: String

    var body: some View {
        HStack {
            MarkdownText(raw: text)
            Spacer(minLength: 40)
        }
    }
}
