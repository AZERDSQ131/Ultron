import SwiftUI

struct FinanceView: View {
    @Environment(ULTRONClient.self) private var client
    @State private var summary: FinanceSummary?
    @State private var errorMessage: String?
    @State private var isLoading = true
    @State private var showAddTransaction = false

    var body: some View {
        List {
            if isLoading {
                ProgressView()
            } else if let errorMessage {
                Text(errorMessage).foregroundStyle(.secondary)
            } else if let summary, summary.hasData {
                Section("Vue d'ensemble") {
                    if let netWorth = summary.netWorth {
                        LabeledContent("Valeur nette") { Text(currency(netWorth)) }
                    }
                    if let month = summary.monthSummary {
                        LabeledContent("Revenus (mois)") { Text(currency(month.income)) }
                        LabeledContent("Dépenses (mois)") { Text(currency(month.expenses)) }
                    }
                }

                if let accounts = summary.accounts, !accounts.isEmpty {
                    Section("Comptes") {
                        ForEach(accounts) { account in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(account.name)
                                    Text(account.type).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if let balance = account.balance {
                                    Text(currency(balance))
                                }
                            }
                        }
                    }
                }

                if let categories = summary.spendingByCategory, !categories.isEmpty {
                    Section("Dépenses par catégorie") {
                        ForEach(categories) { category in
                            LabeledContent(category.category) { Text(currency(category.amount)) }
                        }
                    }
                }

                if let transactions = summary.transactions, !transactions.isEmpty {
                    Section("Transactions récentes") {
                        ForEach(transactions.prefix(20)) { tx in
                            VStack(alignment: .leading) {
                                HStack {
                                    Text(tx.description)
                                    Spacer()
                                    Text(currency(tx.amount))
                                        .foregroundStyle(tx.amount < 0 ? .red : .green)
                                }
                                if let category = tx.category {
                                    Text(category).font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            } else {
                ContentUnavailableView(
                    "Aucune donnée financière",
                    systemImage: "dollarsign.circle",
                    description: Text("Ajoute un compte ou dis simplement à ULTRON en conversation ce que tu as dépensé.")
                )
            }
        }
        .navigationTitle("Finance")
        .refreshable { await load() }
        .task { await load() }
    }

    private func currency(_ value: Double) -> String {
        value.formatted(.currency(code: "EUR"))
    }

    private func load() async {
        isLoading = summary == nil
        do {
            summary = try await client.financeSummary()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}
