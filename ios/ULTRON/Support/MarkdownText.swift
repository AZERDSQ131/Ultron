import SwiftUI

/// Hand-rolled Markdown renderer for chat bubbles. Deliberately not
/// exhaustive — no external Markdown library per the project's zero-external-
/// dependency constraint for this app — but covers what ULTRON's replies
/// actually use: headings, horizontal rules, tables, bulleted/numbered
/// lists, fenced code blocks, and inline bold/italic/code within paragraphs.
struct MarkdownText: View {
    let raw: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                render(block)
            }
        }
    }

    @ViewBuilder
    private func render(_ block: Block) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(Self.inlineAttributed(text))
                .font(headingFont(level))
                .fontWeight(.bold)
                .padding(.top, level <= 2 ? 4 : 2)
        case .paragraph(let text):
            Text(Self.inlineAttributed(text))
                .textSelection(.enabled)
        case .rule:
            Divider()
                .padding(.vertical, 2)
        case .list(let items, let ordered):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .top, spacing: 6) {
                        Text(ordered ? "\(index + 1)." : "•")
                            .foregroundStyle(.secondary)
                            .frame(minWidth: ordered ? 20 : 12, alignment: .leading)
                        Text(Self.inlineAttributed(item))
                            .textSelection(.enabled)
                    }
                }
            }
        case .table(let headers, let rows):
            TableBlockView(headers: headers, rows: rows)
        case .code(let language, let text):
            CodeBlockView(language: language, code: text)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title2
        case 2: return .title3
        default: return .headline
        }
    }

    private enum Block {
        case heading(level: Int, text: String)
        case paragraph(String)
        case rule
        case list(items: [String], ordered: Bool)
        case table(headers: [String], rows: [[String]])
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

        func isTableRow(_ line: String) -> Bool {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            return trimmed.hasPrefix("|") && trimmed.contains("|", after: trimmed.startIndex)
        }

        func isTableSeparator(_ line: String) -> Bool {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("|") else { return false }
            let stripped = trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "|"))
            let cells = stripped.split(separator: "|")
            guard !cells.isEmpty else { return false }
            return cells.allSatisfy { cell in
                let c = cell.trimmingCharacters(in: .whitespaces)
                return !c.isEmpty && c.allSatisfy { $0 == "-" || $0 == ":" }
            }
        }

        func parseTableRow(_ line: String) -> [String] {
            var trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("|") { trimmed.removeFirst() }
            if trimmed.hasSuffix("|") { trimmed.removeLast() }
            return trimmed.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
        }

        while let line = lines.first {
            let trimmedLine = line.trimmingCharacters(in: .whitespaces)

            if line.hasPrefix("```") {
                flushParagraph()
                lines.removeFirst()
                let language = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var codeLines: [String] = []
                while let next = lines.first, !next.hasPrefix("```") {
                    codeLines.append(next)
                    lines.removeFirst()
                }
                if lines.first?.hasPrefix("```") == true { lines.removeFirst() }
                result.append(.code(language: language.isEmpty ? nil : language, text: codeLines.joined(separator: "\n")))
                continue
            }

            if trimmedLine == "---" || trimmedLine == "***" || trimmedLine == "___" {
                flushParagraph()
                lines.removeFirst()
                result.append(.rule)
                continue
            }

            if trimmedLine.hasPrefix("#") {
                let hashes = trimmedLine.prefix(while: { $0 == "#" })
                let rest = trimmedLine.dropFirst(hashes.count).trimmingCharacters(in: .whitespaces)
                if hashes.count >= 1 && hashes.count <= 6 && !rest.isEmpty {
                    flushParagraph()
                    lines.removeFirst()
                    result.append(.heading(level: hashes.count, text: rest))
                    continue
                }
            }

            if isTableRow(trimmedLine), let next = lines.dropFirst().first, isTableSeparator(next) {
                flushParagraph()
                let headers = parseTableRow(trimmedLine)
                lines.removeFirst(2)
                var rows: [[String]] = []
                while let rowLine = lines.first, isTableRow(rowLine.trimmingCharacters(in: .whitespaces)) {
                    rows.append(parseTableRow(rowLine))
                    lines.removeFirst()
                }
                result.append(.table(headers: headers, rows: rows))
                continue
            }

            if let (marker, ordered) = listMarker(trimmedLine) {
                flushParagraph()
                var items: [String] = [String(trimmedLine.dropFirst(marker.count)).trimmingCharacters(in: .whitespaces)]
                lines.removeFirst()
                while let next = lines.first {
                    let nextTrimmed = next.trimmingCharacters(in: .whitespaces)
                    guard let (nextMarker, nextOrdered) = listMarker(nextTrimmed), nextOrdered == ordered else { break }
                    items.append(String(nextTrimmed.dropFirst(nextMarker.count)).trimmingCharacters(in: .whitespaces))
                    lines.removeFirst()
                }
                result.append(.list(items: items, ordered: ordered))
                continue
            }

            if trimmedLine.isEmpty {
                flushParagraph()
                lines.removeFirst()
                continue
            }

            paragraphLines.append(line)
            lines.removeFirst()
        }
        flushParagraph()
        return result
    }

    private func listMarker(_ line: String) -> (marker: String, ordered: Bool)? {
        if line.hasPrefix("- ") { return ("- ", false) }
        if line.hasPrefix("* ") { return ("* ", false) }
        if let dotRange = line.range(of: ". "), line.distance(from: line.startIndex, to: dotRange.lowerBound) <= 3,
           line[line.startIndex..<dotRange.lowerBound].allSatisfy(\.isNumber), !line[line.startIndex..<dotRange.lowerBound].isEmpty {
            return (String(line[line.startIndex..<dotRange.upperBound]), true)
        }
        return nil
    }

    private static func inlineAttributed(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}

private extension String {
    func contains(_ character: Character, after index: String.Index) -> Bool {
        guard index < endIndex else { return false }
        return self[self.index(after: index)...].contains(character)
    }
}

private struct TableBlockView: View {
    let headers: [String]
    let rows: [[String]]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                GridRow {
                    ForEach(Array(headers.enumerated()), id: \.offset) { _, header in
                        Text(header)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                Divider().gridCellColumns(max(headers.count, 1))
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(cell)
                                .font(.subheadline)
                        }
                    }
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(.secondarySystemBackground)))
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
