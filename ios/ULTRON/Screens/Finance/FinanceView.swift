import Charts
import SwiftUI

/// Finance dashboard over `GET /api/finance/summary`. Entry is manual and
/// happens mostly in conversation (`finance_record_balance` /
/// `finance_add_transaction` are written to be called proactively), so this
/// screen is deliberately a read surface.
struct FinanceView: View {
    @Environment(ULTRONClient.self) private var client

    @State private var summary: FinanceSummary?
    @State private var errorMessage: String?
    @State private var isLoading = true
    @State private var days = 30
    @State private var showAllTransactions = false

    private let ranges = [(7, "7j"), (30, "30j"), (90, "90j"), (365, "1an")]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Picker("Période", selection: $days) {
                    ForEach(ranges, id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.segmented)

                if isLoading && summary == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                } else if let errorMessage {
                    ContentUnavailableView("Chargement impossible", systemImage: "exclamationmark.triangle", description: Text(errorMessage))
                } else if let summary, summary.hasData {
                    content(summary)
                } else {
                    ContentUnavailableView(
                        "Aucune donnée financière",
                        systemImage: "eurosign.circle",
                        description: Text("Dis simplement à ULTRON en conversation ce que tu as dépensé ou le solde d'un compte.")
                    )
                    .padding(.top, 40)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Finance")
        .onChange(of: days) { _, _ in Task { await load() } }
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder
    private func content(_ summary: FinanceSummary) -> some View {
        let code = summary.accounts?.first?.currency ?? "EUR"

        overview(summary, code: code)

        if let history = summary.netWorthHistory, history.filter({ $0.netWorth != 0 }).count > 1 {
            netWorthCard(history, code: code)
        }

        if let cashFlow = summary.monthlyCashFlow, cashFlow.contains(where: { $0.income != 0 || $0.expenses != 0 }) {
            cashFlowCard(cashFlow, code: code)
        }

        if let accounts = summary.accounts, !accounts.isEmpty {
            accountsCard(accounts)
        }

        if let categories = summary.spendingByCategory, !categories.isEmpty {
            categoriesCard(categories, code: code)
        }

        if let transactions = summary.transactions, !transactions.isEmpty {
            transactionsCard(transactions, code: code)
        } else {
            DashboardCard("Transactions") {
                Text("Aucune transaction enregistrée. Dis-le en conversation — ULTRON la classe lui-même.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Overview

    private func overview(_ summary: FinanceSummary, code: String) -> some View {
        let month = summary.monthSummary

        return LazyVGrid(columns: dashboardTwoColumns, spacing: 12) {
            StatTile(
                label: "Valeur nette",
                value: money(summary.netWorth ?? 0, code),
                detail: accountsDetail(summary.accounts),
                systemImage: "chart.line.uptrend.xyaxis",
                tint: .blue
            )
            StatTile(
                label: "Épargne du mois",
                value: money(month?.savings ?? 0, code),
                detail: savingsDetail(month),
                systemImage: "banknote.fill",
                tint: (month?.savings ?? 0) >= 0 ? .green : .red
            )
            StatTile(
                label: "Revenus du mois",
                value: money(month?.income ?? 0, code),
                detail: nil,
                systemImage: "arrow.down.circle.fill",
                tint: .green
            )
            StatTile(
                label: "Dépenses du mois",
                value: money(month?.expenses ?? 0, code),
                detail: nil,
                systemImage: "arrow.up.circle.fill",
                tint: .red
            )
        }
    }

    private func accountsDetail(_ accounts: [FinanceAccount]?) -> String? {
        guard let accounts, !accounts.isEmpty else { return nil }
        return "\(accounts.count) compte\(accounts.count > 1 ? "s" : "")"
    }

    private func savingsDetail(_ month: MonthSummary?) -> String? {
        guard let month else { return nil }
        guard let rate = month.savingsRatePct else { return "Aucun revenu ce mois-ci" }
        return String(format: "%.0f %% des revenus", rate)
    }

    // MARK: - Net worth

    private func netWorthCard(_ history: [NetWorthPoint], code: String) -> some View {
        let points = history.compactMap { point -> (date: Date, value: Double)? in
            point.day.map { (date: $0, value: point.netWorth) }
        }
        let first = points.first?.value ?? 0
        let last = points.last?.value ?? 0
        let delta = last - first

        return DashboardCard("Valeur nette", subtitle: "Soldes reportés d'un jour sur l'autre entre deux relevés") {
            Chart {
                ForEach(points, id: \.date) { point in
                    AreaMark(x: .value("Jour", point.date, unit: .day), y: .value("Valeur", point.value))
                        .foregroundStyle(.linearGradient(colors: [.blue.opacity(0.35), .blue.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                    LineMark(x: .value("Jour", point.date, unit: .day), y: .value("Valeur", point.value))
                        .foregroundStyle(.blue)
                        .interpolationMethod(.monotone)
                }
            }
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) }
            .frame(height: 160)

            HStack(spacing: 5) {
                Image(systemName: delta >= 0 ? "arrow.up.right" : "arrow.down.right")
                    .font(.caption2)
                Text("\(delta >= 0 ? "+" : "")\(money(delta, code)) sur la période")
                    .font(.caption2)
            }
            .foregroundStyle(delta >= 0 ? .green : .red)
        }
    }

    // MARK: - Cash flow

    private func cashFlowCard(_ cashFlow: [CashFlowPoint], code: String) -> some View {
        let bars = cashFlow.flatMap { point -> [CashFlowBar] in
            guard let month = point.monthStart else { return [] }
            return [
                CashFlowBar(month: month, series: "Revenus", value: point.income),
                CashFlowBar(month: month, series: "Dépenses", value: point.expenses),
            ]
        }
        let averageNet = cashFlow.isEmpty ? 0 : cashFlow.reduce(0) { $0 + $1.net } / Double(cashFlow.count)

        return DashboardCard("Revenus et dépenses", subtitle: "6 derniers mois") {
            Chart(bars) { bar in
                BarMark(
                    x: .value("Mois", bar.month, unit: .month),
                    y: .value("Montant", bar.value)
                )
                .foregroundStyle(by: .value("Série", bar.series))
                .position(by: .value("Série", bar.series))
                .cornerRadius(2)
            }
            .chartForegroundStyleScale(["Revenus": Color.green, "Dépenses": Color.red])
            .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) }
            .frame(height: 160)

            Text("Solde mensuel moyen : \(averageNet >= 0 ? "+" : "")\(money(averageNet, code))")
                .font(.caption2)
                .foregroundStyle(averageNet >= 0 ? .green : .red)
        }
    }

    // MARK: - Accounts

    private func accountsCard(_ accounts: [FinanceAccount]) -> some View {
        DashboardCard("Comptes") {
            ForEach(Array(accounts.enumerated()), id: \.element.id) { index, account in
                if index > 0 { Divider() }
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: accountIcon(account.type))
                        .font(.callout)
                        .foregroundStyle(.blue)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(displayName(account.name))
                            .font(.subheadline.weight(.medium))
                            .lineLimit(1)
                        Text(accountTypeLabel(account.type))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(account.balance.map { money($0, account.currency) } ?? "—")
                            .font(.subheadline.weight(.medium).monospacedDigit())
                        if let date = balanceDateLabel(account.balanceDate) {
                            Text(date)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    /// A balance recorded through chat can land with a literal "null" name or
    /// date string; don't render that as if it were real.
    private func displayName(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty || trimmed == "null" ? "Compte principal" : trimmed
    }

    private func balanceDateLabel(_ raw: String?) -> String? {
        guard let raw, raw != "null", let date = Date(healthDate: raw) else { return nil }
        return "au \(date.formatted(.dateTime.day().month(.abbreviated)))"
    }

    private func accountIcon(_ type: String) -> String {
        switch type {
        case "checking": return "creditcard.fill"
        case "savings": return "banknote.fill"
        case "investment": return "chart.pie.fill"
        case "cash": return "eurosign.circle.fill"
        case "credit": return "creditcard.trianglebadge.exclamationmark"
        default: return "wallet.pass.fill"
        }
    }

    private func accountTypeLabel(_ type: String) -> String {
        switch type {
        case "checking": return "Compte courant"
        case "savings": return "Épargne"
        case "investment": return "Investissement"
        case "cash": return "Liquide"
        case "credit": return "Crédit"
        default: return type.capitalized
        }
    }

    // MARK: - Categories

    private func categoriesCard(_ categories: [CategorySpend], code: String) -> some View {
        // `total` is SUM(amount) over negative rows, so it arrives negative.
        let amounts = categories.map { abs($0.amount) }
        let biggest = max(0.01, amounts.max() ?? 0.01)
        let total = max(0.01, amounts.reduce(0, +))

        return DashboardCard("Dépenses par catégorie", subtitle: "Mois en cours") {
            ForEach(categories) { category in
                let amount = abs(category.amount)
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(category.category)
                            .font(.subheadline.weight(.medium))
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Text(money(amount, code))
                            .font(.caption.monospacedDigit())
                    }
                    ProgressView(value: min(1, amount / biggest))
                        .tint(.red)
                    HStack {
                        Text("\(category.count) transaction\(category.count > 1 ? "s" : "")")
                        Spacer()
                        Text(dashboardPercent(amount / total))
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
                .padding(.vertical, 3)
            }
        }
    }

    // MARK: - Transactions

    private func transactionsCard(_ transactions: [FinanceTransaction], code: String) -> some View {
        let shown = showAllTransactions ? transactions : Array(transactions.prefix(10))

        return DashboardCard("Transactions") {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, transaction in
                if index > 0 { Divider() }
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: transaction.isExpense ? "arrow.up.right" : "arrow.down.left")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(transaction.isExpense ? .red : .green)
                        .frame(width: 14)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(transaction.description)
                            .font(.subheadline)
                            .lineLimit(2)
                        HStack(spacing: 6) {
                            if let category = transaction.category, !category.isEmpty {
                                Text(category)
                                    .font(.caption2)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color.secondary.opacity(0.15), in: Capsule())
                            }
                            Text(transaction.day.map { $0.formatted(.dateTime.day().month(.abbreviated)) } ?? transaction.date)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    Spacer(minLength: 8)
                    Text(money(transaction.amount, code))
                        .font(.subheadline.weight(.medium).monospacedDigit())
                        .foregroundStyle(transaction.isExpense ? .red : .green)
                }
                .padding(.vertical, 3)
            }

            if transactions.count > 10 {
                Button(showAllTransactions ? "Réduire" : "Voir les \(transactions.count) transactions") {
                    withAnimation { showAllTransactions.toggle() }
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
            summary = try await client.financeSummary(days: days)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func money(_ value: Double, _ code: String) -> String {
        value.formatted(.currency(code: code).precision(.fractionLength(abs(value) < 100 ? 2 : 0)))
    }
}

private struct CashFlowBar: Identifiable {
    let month: Date
    let series: String
    let value: Double

    var id: String { "\(series)-\(month.timeIntervalSince1970)" }
}
