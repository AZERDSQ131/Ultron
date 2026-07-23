import Foundation

/// Minimal server-sent-events frame parser: splits a raw byte stream into
/// (event, data) pairs on blank-line frame boundaries, mirroring the loop
/// remote.ts's `pump()` runs by hand over `res.body.getReader()`.
struct SSEFrame {
    let event: String
    let data: String
}

actor SSEParser {
    private var buffer = ""

    /// Feed a decoded text chunk, returning any complete frames it produced.
    func feed(_ chunk: String) -> [SSEFrame] {
        buffer += chunk
        var frames: [SSEFrame] = []

        while let range = buffer.range(of: "\n\n") {
            let rawFrame = String(buffer[buffer.startIndex..<range.lowerBound])
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)

            var event = "message"
            var dataLines: [String] = []
            for line in rawFrame.split(separator: "\n", omittingEmptySubsequences: false) {
                if line.hasPrefix("event:") {
                    event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                } else if line.hasPrefix("data:") {
                    dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                }
            }
            if !dataLines.isEmpty {
                frames.append(SSEFrame(event: event, data: dataLines.joined(separator: "\n")))
            }
        }
        return frames
    }
}
