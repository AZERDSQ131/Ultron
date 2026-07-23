import SwiftUI

/// Minimal hand-rolled Markdown renderer covering the same span the web
/// frontend's public/js/markdown.js does for chat bubbles: bold, italic,
/// inline code, fenced code blocks, and plain paragraphs. Deliberately not
/// exhaustive — no external Markdown library per the project's zero-external-
/// dependency constraint for this app.
struct MarkdownText: View {
    let raw: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let text):
                    Text(Self.inlineAttributed(text))
                        .textSelection(.enabled)
                case .code(let language, let text):
                    CodeBlockView(language: language, code: text)
                }
            }
        }
    }

    private enum Block {
        case paragraph(String)
        case code(language: String?, text: String)
    }

    private var blocks: [Block] {
        var result: [Block] = []
        var lines = raw.components(separatedBy: "\n")[...]
        var paragraphLines: [String] = []

        func flushParagraph() {
            guard !paragraphLines.isEmpty else { return }
            let text = paragraphLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { result.append(.paragraph(text)) }
            paragraphLines.removeAll()
        }

        while let line = lines.first {
            lines.removeFirst()
            if line.hasPrefix("```") {
                flushParagraph()
                let language = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var codeLines: [String] = []
                while let next = lines.first, !next.hasPrefix("```") {
                    codeLines.append(next)
                    lines.removeFirst()
                }
                if lines.first?.hasPrefix("```") == true { lines.removeFirst() }
                result.append(.code(language: language.isEmpty ? nil : language, text: codeLines.joined(separator: "\n")))
            } else {
                paragraphLines.append(line)
            }
        }
        flushParagraph()
        return result
    }

    private static func inlineAttributed(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}

private struct CodeBlockView: View {
    let language: String?
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let language {
                Text(language.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Text(code)
                .font(.system(.footnote, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(.secondarySystemBackground)))
    }
}
