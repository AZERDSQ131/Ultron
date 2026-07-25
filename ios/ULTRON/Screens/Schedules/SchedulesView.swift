import SwiftUI

struct SchedulesView: View {
    @Environment(ULTRONClient.self) private var client

    @State private var schedules: [Schedule] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showingCreate = false

    var body: some View {
        List {
            if isLoading && schedules.isEmpty {
                ProgressView()
            } else if schedules.isEmpty {
                ContentUnavailableView("Aucun cron", systemImage: "clock.badge.checkmark", description: Text("Ajoute une tâche planifiée pour qu'ULTRON l'exécute automatiquement."))
            }

            ForEach(schedules) { schedule in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(schedule.name).font(.headline)
                        Spacer()
                        Toggle("", isOn: Binding(
                            get: { schedule.enabled },
                            set: { enabled in
                                Task { await setEnabled(schedule, enabled: enabled) }
                            }
                        ))
                        .labelsHidden()
                    }
                    Text(schedule.instruction)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                    Label(schedule.cron, systemImage: "calendar")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                    if let nextRun = schedule.nextRunAt {
                        Text("Prochaine exécution : \(formattedDate(nextRun))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button(role: .destructive) {
                        Task { await delete(schedule) }
                    } label: {
                        Label("Supprimer", systemImage: "trash")
                    }
                }
            }
        }
        .navigationTitle("Crons")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingCreate = true } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Ajouter un cron")
            }
        }
        .sheet(isPresented: $showingCreate) {
            NavigationStack { ScheduleFormView { await create($0) } }
        }
        .refreshable { await load() }
        .task { await load() }
        .alert("Erreur", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "Une erreur est survenue.")
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do { schedules = try await client.listSchedules() }
        catch { errorMessage = error.localizedDescription }
    }

    private func create(_ draft: ScheduleDraft) async {
        do {
            _ = try await client.createSchedule(name: draft.name, instruction: draft.instruction, cron: draft.cron, timezone: draft.timezone)
            await load()
        } catch { errorMessage = error.localizedDescription }
    }

    private func setEnabled(_ schedule: Schedule, enabled: Bool) async {
        do {
            try await client.setScheduleEnabled(schedule.id, enabled: enabled)
            await load()
        } catch { errorMessage = error.localizedDescription }
    }

    private func delete(_ schedule: Schedule) async {
        do {
            try await client.deleteSchedule(schedule.id)
            await load()
        } catch { errorMessage = error.localizedDescription }
    }

    private func formattedDate(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: iso) else { return iso }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

private struct ScheduleDraft {
    let name: String
    let instruction: String
    let cron: String
    let timezone: String
}

private struct ScheduleFormView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var instruction = ""
    @State private var cron = "0 9 * * *"
    @State private var timezone = "Europe/Paris"
    let onSubmit: (ScheduleDraft) async -> Void

    var body: some View {
        Form {
            Section("Tâche") {
                TextField("Nom", text: $name)
                TextField("Instruction à exécuter", text: $instruction, axis: .vertical)
                    .lineLimit(3...6)
            }
            Section("Planification") {
                TextField("Cron (minute heure jour mois semaine)", text: $cron)
                    .font(.body.monospaced())
                TextField("Fuseau horaire", text: $timezone)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Text("Exemple : 0 9 * * * exécute la tâche chaque jour à 09:00.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Nouveau cron")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Annuler") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Créer") {
                    Task {
                        await onSubmit(ScheduleDraft(name: name.trimmingCharacters(in: .whitespacesAndNewlines), instruction: instruction.trimmingCharacters(in: .whitespacesAndNewlines), cron: cron.trimmingCharacters(in: .whitespacesAndNewlines), timezone: timezone.trimmingCharacters(in: .whitespacesAndNewlines)))
                        dismiss()
                    }
                }
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || cron.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }
}
