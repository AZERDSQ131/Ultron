import Charts
import SwiftUI

/// The three layers of what ULTRON remembers, in order of how much control the
/// user has over them:
///
/// 1. **MEMORY.md** — hand-curated durable memory, never rewritten behind the
///    user's back. That separation is deliberate and is the reason this project
///    exists at all (see the OpenClaw incident in the project notes).
/// 2. **SOUL.md** — personality rather than memory, but read as part of the
///    same prompt and worth seeing next to it.
/// 3. **The passive user model** — observations SQLite accumulates on its own,
///    without being asked. Charted, because the interesting question about
///    something that grows by itself is *how* it is growing.
struct MemoryView: View {
    @Environment(ULTRONClient.self) private var client

    @State private var documents: [PromptDocument] = []
    @State private var observations: [UserModelObservation] = []
    @State private var errorMessage: String?
    @State private var isLoading = true
    @State private var showClearConfirm = false
    @State private var expandedDocuments: Set<String> = ["MEMORY.md"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if isLoading && documents.isEmpty && observations.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                } else {
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }

                    ForEach(documents) { document in
                        documentCard(document)
                    }

                    passiveModelSection
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Memory")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Tout effacer", role: .destructive) { showClearConfirm = true }
                    .disabled(observations.isEmpty)
            }
        }
        .confirmationDialog(
            "Effacer toutes les observations passives ?",
            isPresented: $showClearConfirm,
            titleVisibility: .visible
        ) {
            Button("Effacer", role: .destructive) { Task { await clearAll() } }
        } message: {
            Text("MEMORY.md et SOUL.md ne sont pas touchés.")
        }
        .refreshable { await load() }
        .task { await load() }
    }

    // MARK: - Documents

    private func documentCard(_ document: PromptDocument) -> some View {
        let expanded = expandedDocuments.contains(document.name)
        let lineCount = document.content.split(separator: "\n", omittingEmptySubsequences: false).count

        return DashboardCard(document.name, subtitle: documentSubtitle(document)) {
            Text(document.content.trimmingCharacters(in: .whitespacesAndNewlines))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .lineLimit(expanded ? nil : 8)
                .frame(maxWidth: .infinity, alignment: .leading)

            Button(expanded ? "Réduire" : "Tout afficher (\(lineCount) lignes)") {
                withAnimation {
                    if expanded { expandedDocuments.remove(document.name) }
                    else { expandedDocuments.insert(document.name) }
                }
            }
            .font(.caption.weight(.medium))
        }
    }

    private func documentSubtitle(_ document: PromptDocument) -> String {
        let role = document.name == "SOUL.md"
            ? "Personnalité — voix et ton"
            : "Mémoire durable, éditée à la main"
        guard let modified = document.modified else { return role }
        return "\(role) · modifié le \(modified.formatted(.dateTime.day().month(.abbreviated).hour().minute()))"
    }

    // MARK: - Passive user model

    @ViewBuilder
    private var passiveModelSection: some View {
        let byKind: [KindCount] = kindCounts()
        let perDay: [DayPoint] = observationsPerDay()

        VStack(alignment: .leading, spacing: 3) {
            Text("MODÈLE UTILISATEUR PASSIF")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .tracking(0.6)
            Text("Accumulé tout seul dans SQLite au fil des conversations, sans qu'on le demande — délibérément séparé de MEMORY.md, qui reste sous ton contrôle.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.top, 4)

        if observations.isEmpty {
            DashboardCard("Observations") {
                Text("Aucune observation pour l'instant. ULTRON en extrait une après un échange lorsqu'il y a quelque chose de stable à retenir.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else {
            LazyVGrid(columns: dashboardTwoColumns, spacing: 12) {
                StatTile(
                    label: "Observations",
                    value: "\(observations.count)",
                    detail: byKind.count == 1 ? "1 type" : "\(byKind.count) types",
                    systemImage: "brain.head.profile",
                    tint: .purple
                )
                StatTile(
                    label: "Depuis",
                    value: oldestLabel(),
                    detail: "\(perDay.count) jour\(perDay.count > 1 ? "s" : "") avec activité",
                    systemImage: "calendar",
                    tint: .blue
                )
            }

            if perDay.count > 1 {
                DashboardCard("Accumulation") {
                    Chart(perDay) { point in
                        BarMark(
                            x: .value("Jour", point.day, unit: .day),
                            y: .value("Observations", point.count)
                        )
                        .foregroundStyle(Color.purple)
                        .cornerRadius(2)
                    }
                    .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) }
                    .frame(height: 140)
                }
            }

            DashboardCard("Par type") {
                ForEach(byKind) { entry in
                    let share = Double(entry.count) / Double(max(1, observations.count))
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(kindLabel(entry.kind))
                                .font(.subheadline.weight(.medium))
                            Spacer(minLength: 8)
                            Text("\(entry.count) · \(dashboardPercent(share))")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                        ProgressView(value: share)
                            .tint(kindColor(entry.kind))
                    }
                    .padding(.vertical, 3)
                }
            }

            DashboardCard("Détail") {
                ForEach(Array(observations.enumerated()), id: \.element.id) { index, observation in
                    if index > 0 { Divider() }
                    observationRow(observation)
                }
            }
        }
    }

    private func observationRow(_ observation: UserModelObservation) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(kindLabel(observation.kind))
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(kindColor(observation.kind).opacity(0.15)))
                    .foregroundStyle(kindColor(observation.kind))
                Spacer(minLength: 4)
                if let timestamp = observation.timestamp {
                    Text(timestamp.formatted(.dateTime.day().month(.abbreviated).hour().minute()))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Button {
                    Task { await forget(observation) }
                } label: {
                    Image(systemName: "trash")
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
                .buttonStyle(.plain)
            }
            Text(observation.content)
                .font(.caption)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 3)
    }

    // MARK: - Derived

    /// A named type with explicit fields rather than an inline tuple pipeline:
    /// the chained grouping/map/sort was enough to blow up type inference inside
    /// the ViewBuilder ("unable to type-check this expression in reasonable
    /// time").
    private struct KindCount: Identifiable {
        let kind: String
        let count: Int
        var id: String { kind }
    }

    private func kindCounts() -> [KindCount] {
        var counts: [String: Int] = [:]
        for observation in observations {
            counts[observation.kind, default: 0] += 1
        }
        // Tie-break on the name: equal counts would otherwise come out in
        // dictionary order and the list would reshuffle on every refresh.
        return counts
            .map { KindCount(kind: $0.key, count: $0.value) }
            .sorted { $0.count == $1.count ? $0.kind < $1.kind : $0.count > $1.count }
    }

    private struct DayPoint: Identifiable {
        let day: Date
        let count: Int
        var id: TimeInterval { day.timeIntervalSince1970 }
    }

    private func observationsPerDay() -> [DayPoint] {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: observations.compactMap(\.timestamp)) {
            calendar.startOfDay(for: $0)
        }
        return grouped
            .map { DayPoint(day: $0.key, count: $0.value.count) }
            .sorted { $0.day < $1.day }
    }

    private func oldestLabel() -> String {
        guard let oldest = observations.compactMap(\.timestamp).min() else { return "—" }
        return oldest.formatted(.dateTime.day().month(.abbreviated))
    }

    private func kindLabel(_ kind: String) -> String {
        switch kind {
        case "preference": return "Préférence"
        case "fact": return "Fait"
        case "pattern": return "Habitude"
        default: return kind.capitalized
        }
    }

    private func kindColor(_ kind: String) -> Color {
        switch kind {
        case "preference": return .purple
        case "fact": return .blue
        case "pattern": return .orange
        default: return .secondary
        }
    }

    // MARK: - Loading

    private func load() async {
        isLoading = documents.isEmpty && observations.isEmpty
        // The two sources are independent: failing to read the documents must not
        // hide the observations, or the other way round.
        var failures: [String] = []
        do { documents = try await client.promptDocuments() } catch { failures.append("Documents : \(error.localizedDescription)") }
        do { observations = try await client.memoryObservations().observations } catch { failures.append("Observations : \(error.localizedDescription)") }
        errorMessage = failures.isEmpty ? nil : failures.joined(separator: "\n")
        isLoading = false
    }

    private func forget(_ observation: UserModelObservation) async {
        do {
            try await client.forgetMemory(observation.id)
            observations.removeAll { $0.id == observation.id }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func clearAll() async {
        do {
            try await client.clearMemory()
            observations.removeAll()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
