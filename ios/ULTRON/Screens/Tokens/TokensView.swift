import Charts
import SwiftUI

/// Usage dashboard for every LLM call ULTRON makes — not just chat turns, but
/// the cheap separate ones too (health narrator, goal judge, passive memory,
/// vision, chat titles). Backed by `GET /api/usage/summary`, whose provider /
/// model / kind / per-day breakdowns this screen used to decode and then throw
/// away.
struct TokensView: View {
    @Environment(ULTRONClient.self) private var client

    @State private var summary: UsageSummary?
    @State private var errorMessage: String?
    @State private var isLoading = true
    @State private var days = 30
    @State private var dimension: Dimension = .model
    @State private var metric: Metric = .tokens
    @State private var showAllRecent = false

    private let ranges = [(7, "7j"), (30, "30j"), (90, "90j"), (0, "Tout")]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Picker("Période", selection: $days) {
                    ForEach(ranges, id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.segmented)

                if isLoading && summary == nil {
                    ProgressView().frame(maxWidth: .infinity, alignment: .center).padding(.top, 40)
                } else if let errorMessage {
                    ContentUnavailableView("Chargement impossible", systemImage: "exclamationmark.triangle", description: Text(errorMessage))
                } else if let summary, summary.hasData, let totals = summary.totals {
                    overview(totals)
                    if let byDay = summary.byDay, byDay.count > 1 { activityChart(byDay) }
                    splitCard(totals)
                    breakdownCard()
                    if let recent = summary.recent, !recent.isEmpty { recentCard(recent) }
                } else {
                    ContentUnavailableView(
                        "Aucune donnée d'usage",
                        systemImage: "chart.bar",
                        description: Text("Envoie un message pour commencer le suivi.")
                    )
                    .padding(.top, 40)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        // Cards use secondarySystemGroupedBackground, so the page behind them has
        // to be the grouped background or they read as floating on plain white.
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Tokens")
        .onChange(of: days) { _, _ in Task { await load() } }
        .refreshable { await load() }
        .task { await load() }
    }

    // MARK: - Overview

    private func overview(_ totals: UsageTotals) -> some View {
        let perRequest = totals.requests > 0 ? totals.totalTokens / totals.requests : 0
        let costPerRequest = totals.requests > 0 ? totals.costUsd / Double(totals.requests) : 0
        let averageLatency = totals.requests > 0 ? totals.elapsedMs / totals.requests : 0

        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
            StatTile(
                label: "Tokens",
                value: compact(totals.totalTokens),
                detail: "\(compact(totals.inputTokens)) entrée · \(compact(totals.outputTokens)) sortie",
                systemImage: "number.square.fill",
                tint: .blue
            )
            StatTile(
                label: "Appels",
                value: totals.requests.formatted(),
                detail: "\(compact(perRequest)) tokens / appel",
                systemImage: "arrow.left.arrow.right.square.fill",
                tint: .purple
            )
            StatTile(
                label: "Coût estimé",
                value: cost(totals.costUsd),
                detail: "\(cost(costPerRequest)) / appel",
                systemImage: "creditcard.fill",
                tint: .green
            )
            StatTile(
                label: "Temps de calcul",
                value: duration(totals.elapsedMs),
                detail: "\(duration(averageLatency)) en moyenne",
                systemImage: "clock.fill",
                tint: .orange
            )
        }
    }

    // MARK: - Per-day chart

    private func activityChart(_ byDay: [UsageDay]) -> some View {
        let points = chartPoints(byDay)
        let busiest = byDay.max { $0.totalTokens < $1.totalTokens }

        return Card("Activité par jour") {
            Picker("Métrique", selection: $metric) {
                ForEach(Metric.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.bottom, 4)

            Chart(points) { point in
                BarMark(
                    x: .value("Jour", point.date, unit: .day),
                    y: .value(metric.label, point.value)
                )
                .foregroundStyle(by: .value("Série", point.series))
                .cornerRadius(2)
            }
            .chartForegroundStyleScale([
                Series.input: Color.blue.opacity(0.45),
                Series.output: Color.blue,
                Series.requests: Color.purple,
                Series.cost: Color.green,
            ])
            .chartLegend(metric == .tokens ? .visible : .hidden)
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) }
            .frame(height: 170)

            if let busiest, let day = busiest.day, busiest.totalTokens > 0 {
                Text("Jour le plus chargé : \(day.formatted(.dateTime.day().month(.abbreviated))) — \(compact(busiest.totalTokens)) tokens")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func chartPoints(_ byDay: [UsageDay]) -> [ChartPoint] {
        byDay.flatMap { day -> [ChartPoint] in
            guard let date = day.day else { return [] }
            switch metric {
            case .tokens:
                return [
                    ChartPoint(date: date, series: Series.input, value: Double(day.inputTokens)),
                    ChartPoint(date: date, series: Series.output, value: Double(day.outputTokens)),
                ]
            case .requests:
                return [ChartPoint(date: date, series: Series.requests, value: Double(day.requests))]
            case .cost:
                return [ChartPoint(date: date, series: Series.cost, value: day.costUsd)]
            }
        }
    }

    // MARK: - Input / output split

    private func splitCard(_ totals: UsageTotals) -> some View {
        let total = max(1, totals.totalTokens)
        let inputShare = Double(totals.inputTokens) / Double(total)

        return Card("Répartition entrée / sortie") {
            GeometryReader { geometry in
                HStack(spacing: 2) {
                    Rectangle()
                        .fill(Color.blue.opacity(0.45))
                        .frame(width: max(0, geometry.size.width * inputShare - 1))
                    Rectangle().fill(Color.blue)
                }
                .clipShape(RoundedRectangle(cornerRadius: 4))
            }
            .frame(height: 10)

            HStack {
                legendDot(Color.blue.opacity(0.45), "Entrée \(percent(inputShare))")
                Spacer()
                legendDot(Color.blue, "Sortie \(percent(1 - inputShare))")
            }
            .font(.caption2)
            .foregroundStyle(.secondary)

            Text("Le contexte renvoyé à chaque tour domine presque toujours le volume — c'est l'historique de conversation, pas ce qu'ULTRON écrit.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private func legendDot(_ color: Color, _ label: String) -> some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label)
        }
    }

    // MARK: - Breakdown

    private func breakdownCard() -> some View {
        let rows = breakdownRows
        let maxTokens = max(1, rows.map(\.totalTokens).max() ?? 1)
        let totalTokens = max(1, rows.reduce(0) { $0 + $1.totalTokens })

        return Card("Détail") {
            Picker("Dimension", selection: $dimension) {
                ForEach(Dimension.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.bottom, 2)

            if rows.isEmpty {
                Text("Rien à afficher sur cette période.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { Divider() }
                    BreakdownRowView(
                        title: dimension == .kind ? Self.kindLabel(row.key) : row.key,
                        row: row,
                        barShare: Double(row.totalTokens) / Double(maxTokens),
                        share: Double(row.totalTokens) / Double(totalTokens)
                    )
                }
            }
        }
    }

    private var breakdownRows: [UsageBreakdownRow] {
        switch dimension {
        case .model: return summary?.byModel ?? []
        case .provider: return summary?.byProvider ?? []
        case .kind: return summary?.byKind ?? []
        }
    }

    // MARK: - Recent calls

    private func recentCard(_ recent: [UsageRecord]) -> some View {
        let shown = showAllRecent ? recent : Array(recent.prefix(8))

        return Card("Derniers appels") {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, record in
                if index > 0 { Divider() }
                RecentRowView(record: record)
            }
            if recent.count > 8 {
                Button(showAllRecent ? "Réduire" : "Voir les \(recent.count) appels") {
                    withAnimation { showAllRecent.toggle() }
                }
                .font(.caption.weight(.medium))
                .padding(.top, 2)
            }
        }
    }

    // MARK: - Loading

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

// MARK: - Supporting types

private enum Series {
    static let input = "Entrée"
    static let output = "Sortie"
    static let requests = "Appels"
    static let cost = "Coût"
}

private struct ChartPoint: Identifiable {
    let date: Date
    let series: String
    let value: Double

    var id: String { "\(series)-\(date.timeIntervalSince1970)" }
}

extension TokensView {
    enum Dimension: Hashable, CaseIterable, Identifiable {
        case model, provider, kind

        var id: Self { self }
        var label: String {
            switch self {
            case .model: return "Modèle"
            case .provider: return "Fournisseur"
            case .kind: return "Type"
            }
        }
    }

    enum Metric: Hashable, CaseIterable, Identifiable {
        case tokens, requests, cost

        var id: Self { self }
        var label: String {
            switch self {
            case .tokens: return "Tokens"
            case .requests: return "Appels"
            case .cost: return "Coût"
            }
        }
    }

    static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "chat": return "Conversation"
        case "narrator": return "Narrateur santé"
        case "goal_judge": return "Juge d'objectif"
        case "user_model": return "Mémoire passive"
        case "vision": return "Vision (photo)"
        case "chat_title": return "Titre de chat"
        default: return kind
        }
    }
}

// MARK: - Formatting

private func compact(_ value: Int) -> String {
    if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
    if value >= 10_000 { return String(format: "%.0fk", Double(value) / 1_000) }
    if value >= 1_000 { return String(format: "%.1fk", Double(value) / 1_000) }
    return "\(value)"
}

/// Costs here are an estimate from configurable per-million rates, not a billed
/// figure — NVIDIA NIM publishes none. Small values need real precision to be
/// meaningful at all.
private func cost(_ value: Double) -> String {
    if value == 0 { return "$0" }
    if value < 0.01 { return String(format: "$%.4f", value) }
    if value < 1 { return String(format: "$%.3f", value) }
    return String(format: "$%.2f", value)
}

private func duration(_ ms: Int) -> String {
    if ms < 1_000 { return "\(ms) ms" }
    if ms < 60_000 { return String(format: "%.1f s", Double(ms) / 1_000) }
    let minutes = ms / 60_000
    if minutes < 60 { return "\(minutes) min \((ms % 60_000) / 1_000) s" }
    return "\(minutes / 60) h \(minutes % 60) min"
}

private func percent(_ share: Double) -> String {
    "\(Int((share * 100).rounded())) %"
}

// MARK: - Reusable pieces

private struct Card<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .tracking(0.6)
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct StatTile: View {
    let label: String
    let value: String
    let detail: String
    let systemImage: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(.caption2)
                    .foregroundStyle(tint)
                Text(label)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Text(value)
                .font(.title3.weight(.semibold).monospacedDigit())
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            Text(detail)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct BreakdownRowView: View {
    let title: String
    let row: UsageBreakdownRow
    /// Relative to the largest row, so the bar is readable rather than a sliver.
    let barShare: Double
    /// Relative to the whole range, which is the number actually worth reading.
    let share: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                Text(percent(share))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            ProgressView(value: min(1, max(0, barShare)))
                .tint(.blue)

            HStack(spacing: 6) {
                Text(compact(row.totalTokens))
                Text("·")
                Text("\(compact(row.inputTokens)) in / \(compact(row.outputTokens)) out")
                Spacer(minLength: 4)
                Text(cost(row.costUsd))
            }
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.secondary)
            .lineLimit(1)

            Text("\(row.requests) appel\(row.requests > 1 ? "s" : "") · \(duration(row.averageElapsedMs)) en moyenne")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
    }
}

private struct RecentRowView: View {
    let record: UsageRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(record.model)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                Text(cost(record.costUsd))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 6) {
                Text(TokensView.kindLabel(record.kind))
                    .font(.caption2.weight(.medium))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.blue.opacity(0.15), in: Capsule())
                    .foregroundStyle(.blue)
                Text(record.provider)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Spacer(minLength: 4)
                if let timestamp = record.timestamp {
                    Text(timestamp.formatted(.dateTime.day().month(.abbreviated).hour().minute()))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            Text("\(compact(record.inputTokens)) in / \(compact(record.outputTokens)) out · \(duration(record.elapsedMs))")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}
