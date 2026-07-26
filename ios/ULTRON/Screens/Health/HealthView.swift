import Charts
import SwiftUI

/// Health dashboard over `GET /api/health-data/summary`. Scores, anomalies and
/// the biological-age estimate are all computed server-side and deterministically
/// (see src/core/health/), never by the model — this screen only presents them.
struct HealthView: View {
    @Environment(ULTRONClient.self) private var client

    @State private var summary: HealthSummary?
    @State private var errorMessage: String?
    @State private var isLoading = true
    @State private var metric: MetricChoice = .recovery

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if isLoading && summary == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                } else if let errorMessage {
                    ContentUnavailableView("Chargement impossible", systemImage: "exclamationmark.triangle", description: Text(errorMessage))
                } else if let summary, summary.hasData {
                    content(summary)
                } else {
                    ContentUnavailableView(
                        "Aucune donnée santé",
                        systemImage: "heart",
                        description: Text("Connecte ton export santé côté serveur pour voir ce tableau de bord.")
                    )
                    .padding(.top, 40)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Santé")
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder
    private func content(_ summary: HealthSummary) -> some View {
        let days = summary.days ?? []
        // The range's last row is often an empty placeholder day; the newest row
        // that actually carries readings is what's worth showing in detail.
        let latest = days.last { $0.hasAnyMetric }

        scoresRow(summary)

        if let anomalies = summary.anomalies, !anomalies.isEmpty {
            anomaliesCard(anomalies)
        }

        if days.filter({ metric.value($0) != nil }).count > 1 {
            trendCard(days)
        }

        if let latest {
            latestDayCard(latest)
        }

        sleepCard(days, debt: summary.sleepDebt)

        if let records = summary.records {
            recordsCard(records)
        }

        if let bioAge = summary.bioAge {
            bioAgeCard(bioAge)
        }

        if let meals = summary.meals, !meals.isEmpty {
            mealsCard(meals)
        }

        if let exercises = summary.exercises, !exercises.isEmpty {
            exercisesCard(exercises)
        }
    }

    // MARK: - Scores

    private func scoresRow(_ summary: HealthSummary) -> some View {
        let scores = summary.latestScores
        let dateLabel = scores.flatMap { Date(healthDate: $0.date) }
            .map { $0.formatted(.dateTime.weekday(.wide).day().month(.abbreviated)) }

        return VStack(alignment: .leading, spacing: 12) {
            LazyVGrid(columns: dashboardTwoColumns, spacing: 12) {
                StatTile(
                    label: "Récupération",
                    value: scores.map { scoreText($0.recovery) } ?? "—",
                    detail: scores.map { scoreVerdict($0.recovery) },
                    systemImage: "bolt.heart.fill",
                    tint: scores.map { scoreColor($0.recovery) } ?? .secondary
                )
                StatTile(
                    label: "Activité",
                    value: scores.map { scoreText($0.activity) } ?? "—",
                    detail: scores.map { scoreVerdict($0.activity) },
                    systemImage: "figure.walk",
                    tint: scores.map { scoreColor($0.activity) } ?? .secondary
                )
            }
            if let dateLabel {
                Text("Dernier jour mesuré : \(dateLabel) · comparé à ta base 30 jours")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: - Anomalies

    private func anomaliesCard(_ anomalies: [HealthAnomaly]) -> some View {
        DashboardCard("Anomalies", subtitle: "Écarts à ta propre base, pas à une norme de population") {
            ForEach(anomalies) { anomaly in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: anomaly.isSignificant ? "exclamationmark.triangle.fill" : "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(anomaly.isSignificant ? .red : .orange)
                    Text(anomaly.message)
                        .font(.caption)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    // MARK: - Trend chart

    private func trendCard(_ days: [HealthDay]) -> some View {
        let points = days.compactMap { day -> TrendPoint? in
            guard let date = day.day, let value = metric.value(day) else { return nil }
            return TrendPoint(date: date, value: value)
        }
        let average = points.isEmpty ? nil : points.reduce(0) { $0 + $1.value } / Double(points.count)

        return DashboardCard("Tendance") {
            Picker("Métrique", selection: $metric) {
                ForEach(MetricChoice.allCases) { Text($0.shortLabel).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.bottom, 4)

            Chart(points) { point in
                if metric.usesBars {
                    BarMark(x: .value("Jour", point.date, unit: .day), y: .value(metric.label, point.value))
                        .foregroundStyle(metric.tint)
                        .cornerRadius(2)
                } else {
                    LineMark(x: .value("Jour", point.date, unit: .day), y: .value(metric.label, point.value))
                        .foregroundStyle(metric.tint)
                        .interpolationMethod(.monotone)
                    PointMark(x: .value("Jour", point.date, unit: .day), y: .value(metric.label, point.value))
                        .foregroundStyle(metric.tint)
                        .symbolSize(18)
                }
            }
            .chartYScale(domain: metric.yDomain(for: points.map(\.value)))
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) }
            .frame(height: 170)

            if let average {
                Text("\(metric.label) : \(metric.format(average)) en moyenne sur \(points.count) jour\(points.count > 1 ? "s" : "") mesuré\(points.count > 1 ? "s" : "")")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Latest day detail

    private func latestDayCard(_ day: HealthDay) -> some View {
        let label = day.day.map { $0.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)) } ?? day.date

        return DashboardCard("Détail du jour", subtitle: label) {
            LazyVGrid(columns: dashboardTwoColumns, spacing: 12) {
                MetricCell(label: "Pas", value: intText(day.steps), systemImage: "shoeprints.fill", tint: .orange)
                MetricCell(label: "Énergie active", value: unitText(day.activeEnergyKcal, "kcal"), systemImage: "flame.fill", tint: .red)
                MetricCell(label: "Distance", value: decimalText(day.distanceKm, "km"), systemImage: "location.fill", tint: .blue)
                MetricCell(label: "Exercice", value: unitText(day.exerciseMinutes, "min"), systemImage: "figure.run", tint: .green)
                MetricCell(label: "Étages", value: intText(day.flightsClimbed), systemImage: "stairs", tint: .teal)
                MetricCell(label: "Séances", value: intText(day.workoutCount), systemImage: "dumbbell.fill", tint: .indigo)
                MetricCell(label: "FC au repos", value: unitText(day.restingHR, "bpm"), systemImage: "heart.fill", tint: .pink)
                MetricCell(label: "FC en marche", value: unitText(day.walkingHR, "bpm"), systemImage: "heart", tint: .pink)
                MetricCell(label: "VFC", value: decimalText(day.hrvAvg, "ms"), systemImage: "waveform.path.ecg", tint: .purple)
                MetricCell(label: "Respiration", value: decimalText(day.respiratoryRateAvg, "/min"), systemImage: "lungs.fill", tint: .cyan)
                MetricCell(label: "Sommeil", value: hoursText(day.sleepDurationSec), systemImage: "bed.double.fill", tint: .indigo)
                MetricCell(
                    label: "Efficacité",
                    value: day.sleepEfficiencyPct.map { String(format: "%.0f %%", $0) } ?? "—",
                    systemImage: "moon.zzz.fill",
                    tint: .indigo
                )
            }
        }
    }

    // MARK: - Sleep

    private func sleepCard(_ days: [HealthDay], debt: HealthSleepDebt?) -> some View {
        let nights = days.compactMap { day -> TrendPoint? in
            guard let date = day.day, let seconds = day.sleepDurationSec, seconds > 0 else { return nil }
            return TrendPoint(date: date, value: seconds / 3600)
        }

        return DashboardCard("Sommeil") {
            if let debt {
                HStack(alignment: .top) {
                    MetricCell(
                        label: "Dette de sommeil",
                        value: debt.deficitHours > 0 ? String(format: "%.1f h", debt.deficitHours) : "aucune",
                        systemImage: "moon.zzz.fill",
                        tint: debt.deficitHours > 0 ? .orange : .green
                    )
                    MetricCell(
                        label: "Fenêtre",
                        value: "\(debt.daysCounted) nuit\(debt.daysCounted > 1 ? "s" : "")",
                        systemImage: "calendar",
                        tint: .secondary
                    )
                }
                if debt.daysCounted == 0 {
                    Text("Aucune nuit exploitable sur la fenêtre — la dette n'est pas calculable.")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            if nights.count > 1 {
                Chart(nights) { night in
                    BarMark(x: .value("Nuit", night.date, unit: .day), y: .value("Heures", night.value))
                        .foregroundStyle(Color.indigo)
                        .cornerRadius(2)
                }
                .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) }
                .frame(height: 110)
            }
        }
    }

    // MARK: - Records

    private func recordsCard(_ records: HealthRecords) -> some View {
        DashboardCard("Records", subtitle: "Sur tout l'historique conservé") {
            if let sleep = records.bestSleepNight {
                recordRow("Meilleure nuit", value: hoursText(sleep.durationSec), date: sleep.date, systemImage: "bed.double.fill", tint: .indigo)
            }
            if let rhr = records.lowestRestingHR {
                recordRow("FC au repos la plus basse", value: "\(Int(rhr.value)) bpm", date: rhr.date, systemImage: "heart.fill", tint: .pink)
            }
            if let steps = records.mostSteps {
                recordRow("Plus de pas", value: Int(steps.value).formatted(), date: steps.date, systemImage: "shoeprints.fill", tint: .orange)
            }
            Divider()
            HStack(spacing: 6) {
                Image(systemName: "flame.fill").font(.caption2).foregroundStyle(.orange)
                Text(records.currentActivityStreakDays > 0
                     ? "Série en cours : \(records.currentActivityStreakDays) jour\(records.currentActivityStreakDays > 1 ? "s" : "") au niveau habituel ou au-dessus"
                     : "Aucune série d'activité en cours")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func recordRow(_ title: String, value: String, date: String, systemImage: String, tint: Color) -> some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage).font(.caption).foregroundStyle(tint).frame(width: 16)
            Text(title).font(.caption)
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 1) {
                Text(value).font(.caption.weight(.medium).monospacedDigit())
                Text(Date(healthDate: date).map { $0.formatted(.dateTime.day().month(.abbreviated).year()) } ?? date)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: - Biological age

    private func bioAgeCard(_ bioAge: HealthBioAge) -> some View {
        DashboardCard("Âge biologique estimé", subtitle: "Estimation de bien-être, non clinique") {
            Text(String(format: "%.1f ans", bioAge.age))
                .font(.title2.weight(.semibold).monospacedDigit())
            ForEach(bioAge.explanation, id: \.self) { line in
                HStack(alignment: .top, spacing: 6) {
                    Text("•").font(.caption2).foregroundStyle(.tertiary)
                    Text(line).font(.caption).foregroundStyle(.secondary)
                }
            }
            Text("Comparé à des points de référence de population, contrairement aux scores ci-dessus qui utilisent ta propre base.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: - Meals and exercises

    private func mealsCard(_ meals: [HealthMeal]) -> some View {
        let calories = meals.compactMap(\.estimatedCalories).reduce(0, +)

        return DashboardCard("Repas", subtitle: calories > 0 ? "\(Int(calories)) kcal enregistrées" : nil) {
            ForEach(Array(meals.enumerated()), id: \.element.id) { index, meal in
                if index > 0 { Divider() }
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(meal.description).font(.caption.weight(.medium))
                        Spacer(minLength: 8)
                        if let kcal = meal.estimatedCalories {
                            Text("\(Int(kcal)) kcal").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                    let macros = [
                        meal.proteinG.map { "P \(Int($0))g" },
                        meal.carbsG.map { "G \(Int($0))g" },
                        meal.fatG.map { "L \(Int($0))g" },
                    ].compactMap { $0 }
                    HStack(spacing: 6) {
                        if !macros.isEmpty {
                            Text(macros.joined(separator: " · "))
                        }
                        Spacer(minLength: 4)
                        Text(mealDateLabel(meal.timestamp, fallback: meal.date))
                    }
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                }
                .padding(.vertical, 2)
            }
        }
    }

    private func exercisesCard(_ exercises: [HealthExercise]) -> some View {
        let burned = exercises.compactMap(\.estimatedCaloriesBurned).reduce(0, +)

        return DashboardCard("Exercices", subtitle: burned > 0 ? "\(Int(burned)) kcal dépensées" : nil) {
            ForEach(Array(exercises.enumerated()), id: \.element.id) { index, exercise in
                if index > 0 { Divider() }
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(exercise.description).font(.caption.weight(.medium))
                        Spacer(minLength: 8)
                        if let kcal = exercise.estimatedCaloriesBurned {
                            Text("\(Int(kcal)) kcal").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                    let facts = [
                        exercise.exerciseType,
                        exercise.durationMinutes.map { "\(Int($0)) min" },
                        exercise.intensity,
                    ].compactMap { $0 }
                    HStack(spacing: 6) {
                        if !facts.isEmpty {
                            Text(facts.joined(separator: " · "))
                        }
                        Spacer(minLength: 4)
                        Text(mealDateLabel(exercise.timestamp, fallback: exercise.date))
                    }
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                }
                .padding(.vertical, 2)
            }
        }
    }

    private func mealDateLabel(_ timestamp: String, fallback: String) -> String {
        if let date = Date(serverTimestamp: timestamp) {
            return date.formatted(.dateTime.day().month(.abbreviated).hour().minute())
        }
        return fallback
    }

    // MARK: - Loading

    private func load() async {
        isLoading = summary == nil
        do {
            summary = try await client.healthSummary()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

// MARK: - Metric choice

extension HealthView {
    enum MetricChoice: Hashable, CaseIterable, Identifiable {
        case recovery, activity, steps, sleep, restingHR, hrv

        var id: Self { self }

        var label: String {
            switch self {
            case .recovery: return "Récupération"
            case .activity: return "Activité"
            case .steps: return "Pas"
            case .sleep: return "Sommeil"
            case .restingHR: return "FC au repos"
            case .hrv: return "VFC"
            }
        }

        /// The segmented control has six slots, so labels have to stay short.
        var shortLabel: String {
            switch self {
            case .recovery: return "Récup."
            case .activity: return "Activité"
            case .steps: return "Pas"
            case .sleep: return "Sommeil"
            case .restingHR: return "FC"
            case .hrv: return "VFC"
            }
        }

        var usesBars: Bool {
            switch self {
            case .steps, .sleep: return true
            case .recovery, .activity, .restingHR, .hrv: return false
            }
        }

        var tint: Color {
            switch self {
            case .recovery: return .green
            case .activity: return .orange
            case .steps: return .orange
            case .sleep: return .indigo
            case .restingHR: return .pink
            case .hrv: return .purple
            }
        }

        func value(_ day: HealthDay) -> Double? {
            switch self {
            case .recovery: return day.recovery
            case .activity: return day.activity
            case .steps: return day.steps
            case .sleep: return day.sleepDurationSec.map { $0 / 3600 }
            case .restingHR: return day.restingHR
            case .hrv: return day.hrvAvg
            }
        }

        func format(_ value: Double) -> String {
            switch self {
            case .recovery, .activity: return String(format: "%.0f/100", value)
            case .steps: return Int(value).formatted()
            case .sleep: return String(format: "%.1f h", value)
            case .restingHR: return String(format: "%.0f bpm", value)
            case .hrv: return String(format: "%.1f ms", value)
            }
        }

        /// Scores are only meaningful on their full 0–100 scale; everything else
        /// is padded around its own values so small variations stay visible.
        func yDomain(for values: [Double]) -> ClosedRange<Double> {
            switch self {
            case .recovery, .activity:
                return 0...100
            default:
                let low = values.min() ?? 0
                let high = values.max() ?? 1
                if high <= low { return max(0, low - 1)...(high + 1) }
                let padding = (high - low) * 0.15
                return max(0, low - padding)...(high + padding)
            }
        }
    }
}

private struct TrendPoint: Identifiable {
    let date: Date
    let value: Double

    var id: TimeInterval { date.timeIntervalSince1970 }
}

// MARK: - Formatting

private func scoreText(_ value: Double) -> String {
    "\(Int(value.rounded()))"
}

private func scoreColor(_ value: Double) -> Color {
    if value >= 66 { return .green }
    if value >= 40 { return .orange }
    return .red
}

private func scoreVerdict(_ value: Double) -> String {
    if value >= 80 { return "Excellent" }
    if value >= 66 { return "Bon" }
    if value >= 50 { return "Dans la norme" }
    if value >= 40 { return "En dessous" }
    return "Faible"
}

private func intText(_ value: Double?) -> String {
    guard let value else { return "—" }
    return Int(value).formatted()
}

private func unitText(_ value: Double?, _ unit: String) -> String {
    guard let value else { return "—" }
    return "\(Int(value.rounded())) \(unit)"
}

private func decimalText(_ value: Double?, _ unit: String) -> String {
    guard let value else { return "—" }
    return String(format: "%.1f %@", value, unit)
}

private func hoursText(_ seconds: Double?) -> String {
    guard let seconds, seconds > 0 else { return "—" }
    let total = Int(seconds.rounded())
    return "\(total / 3600) h \((total % 3600) / 60) min"
}
