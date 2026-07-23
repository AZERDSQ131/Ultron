import SwiftUI

struct TokensView: View {
    @Environment(ULTRONClient.self) private var client
    @State private var summary: UsageSummary?
    @State private var errorMessage: String?
    @State private var isLoading = true
    @State private var days = 30

    private let ranges = [(7, "7j"), (30, "30j"), (90, "90j"), (0, "Tout")]

    var body: some View {
        List {
            Section {
                Picker("Période", selection: $days) {
                    ForEach(ranges, id: \.0) { range in
                        Text(range.1).tag(range.0)
                    }
                }
                .pickerStyle(.segmented)
                .listRowInsets(EdgeInsets())
                .padding(.vertical, 4)
            }

            if isLoading {
                ProgressView()
            } else if let errorMessage {
                Text(errorMessage).foregroundStyle(.secondary)
            } else if let summary, summary.hasData {
                Section("Total") {
                    LabeledContent("Tokens en entrée") { Text("\(summary.totalInputTokens ?? 0)") }
                    LabeledContent("Tokens en sortie") { Text("\(summary.totalOutputTokens ?? 0)") }
                    if let cost = summary.totalEstimatedCost {
                        LabeledContent("Coût estimé") { Text(cost.formatted(.currency(code: "USD"))) }
                    }
                }
                if let byKind = summary.byKind, !byKind.isEmpty {
                    Section("Par type d'appel") {
                        ForEach(byKind) { entry in
                            VStack(alignment: .leading) {
                                Text(entry.kind).font(.subheadline.weight(.medium))
                                Text("\(entry.inputTokens) in · \(entry.outputTokens) out · \(entry.estimatedCost.formatted(.currency(code: "USD")))")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } else {
                ContentUnavailableView("Aucune donnée d'usage", systemImage: "chart.bar")
            }
        }
        .navigationTitle("Tokens")
        .onChange(of: days) { _, _ in Task { await load() } }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        isLoading = summary == nil
        do {
            summary = try await client.usageSummary(days: days)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}
