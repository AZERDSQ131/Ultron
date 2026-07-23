import SwiftUI

struct HealthView: View {
    @Environment(ULTRONClient.self) private var client
    @State private var summary: HealthSummary?
    @State private var errorMessage: String?
    @State private var isLoading = true

    var body: some View {
        List {
            if isLoading {
                ProgressView()
            } else if let errorMessage {
                Text(errorMessage).foregroundStyle(.secondary)
            } else if let summary, summary.hasData {
                if let days = summary.days, !days.isEmpty {
                    Section("7 derniers jours") {
                        ForEach(days.suffix(7)) { day in
                            HStack {
                                Text(day.date).font(.caption)
                                Spacer()
                                if let recovery = day.recoveryScore {
                                    Label(String(format: "%.0f", recovery), systemImage: "bolt.heart")
                                        .foregroundStyle(.green)
                                }
                                if let activity = day.activityScore {
                                    Label(String(format: "%.0f", activity), systemImage: "figure.walk")
                                        .foregroundStyle(.orange)
                                }
                            }
                            .font(.footnote)
                        }
                    }
                    SparklineView(values: days.compactMap(\.recoveryScore))
                        .frame(height: 60)
                        .listRowInsets(EdgeInsets())
                        .padding()
                }

                if let sleepDebt = summary.sleepDebt {
                    Section("Sommeil") {
                        LabeledContent("Dette de sommeil") { Text(String(format: "%.1f h", sleepDebt)) }
                    }
                }

                if let anomalies = summary.anomalies, !anomalies.isEmpty {
                    Section("Anomalies") {
                        ForEach(anomalies, id: \.self) { anomaly in
                            Label(anomaly, systemImage: "exclamationmark.triangle")
                                .foregroundStyle(.orange)
                        }
                    }
                }

                if let bioAge = summary.bioAge {
                    Section {
                        LabeledContent("Âge biologique estimé") { Text(String(format: "%.1f ans", bioAge)) }
                    } footer: {
                        Text("Estimation de bien-être non clinique.")
                    }
                }
            } else {
                ContentUnavailableView(
                    "Aucune donnée santé",
                    systemImage: "heart",
                    description: Text("Connecte ton export santé côté serveur pour voir ce tableau de bord.")
                )
            }
        }
        .navigationTitle("Santé")
        .refreshable { await load() }
        .task { await load() }
    }

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

struct SparklineView: View {
    let values: [Double]

    var body: some View {
        GeometryReader { geo in
            if values.count > 1, let min = values.min(), let max = values.max(), max > min {
                Path { path in
                    for (index, value) in values.enumerated() {
                        let x = geo.size.width * CGFloat(index) / CGFloat(values.count - 1)
                        let normalized = (value - min) / (max - min)
                        let y = geo.size.height * (1 - CGFloat(normalized))
                        if index == 0 { path.move(to: CGPoint(x: x, y: y)) }
                        else { path.addLine(to: CGPoint(x: x, y: y)) }
                    }
                }
                .stroke(Color.accentColor, lineWidth: 2)
            }
        }
    }
}
