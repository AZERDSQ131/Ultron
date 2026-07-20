import { DatabaseSync } from "node:sqlite";

// Meal/exercise logging — two entry paths write into the same tables:
// a photo sent on Telegram (src/core/health/visionAnalyzer.ts estimates
// the content, photoPath always set) or a plain text description in any
// conversation (the log_meal_or_exercise tool, src/core/tools/health.ts —
// the main chat model estimates the content itself, photoPath is null).
// Photos are never stored as SQLite blobs, only a disk path
// (photoStorage.ts). Global like HealthRegistry's health_days: one
// person, one timeline, not scoped per chat, though the originating chat
// is kept for reference.

export interface MealLogEntry {
  id: number;
  date: string;
  timestamp: string;
  photoPath: string | null;
  caption: string | null;
  description: string;
  estimatedCalories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  sourceChatId: string;
}

export interface ExerciseLogEntry {
  id: number;
  date: string;
  timestamp: string;
  photoPath: string | null;
  caption: string | null;
  description: string;
  exerciseType: string | null;
  durationMinutes: number | null;
  intensity: string | null;
  estimatedCaloriesBurned: number | null;
  sourceChatId: string;
}

interface MealRow {
  id: number;
  date: string;
  timestamp: string;
  photo_path: string | null;
  caption: string | null;
  description: string;
  estimated_calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  source_chat_id: string;
}

interface ExerciseRow {
  id: number;
  date: string;
  timestamp: string;
  photo_path: string | null;
  caption: string | null;
  description: string;
  exercise_type: string | null;
  duration_minutes: number | null;
  intensity: string | null;
  estimated_calories_burned: number | null;
  source_chat_id: string;
}

function toMeal(row: MealRow): MealLogEntry {
  return {
    id: row.id,
    date: row.date,
    timestamp: row.timestamp,
    photoPath: row.photo_path,
    caption: row.caption,
    description: row.description,
    estimatedCalories: row.estimated_calories,
    proteinG: row.protein_g,
    carbsG: row.carbs_g,
    fatG: row.fat_g,
    sourceChatId: row.source_chat_id,
  };
}

function toExercise(row: ExerciseRow): ExerciseLogEntry {
  return {
    id: row.id,
    date: row.date,
    timestamp: row.timestamp,
    photoPath: row.photo_path,
    caption: row.caption,
    description: row.description,
    exerciseType: row.exercise_type,
    durationMinutes: row.duration_minutes,
    intensity: row.intensity,
    estimatedCaloriesBurned: row.estimated_calories_burned,
    sourceChatId: row.source_chat_id,
  };
}

export class MealExerciseLogRegistry {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meal_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        photo_path TEXT,
        caption TEXT,
        description TEXT NOT NULL,
        estimated_calories REAL,
        protein_g REAL,
        carbs_g REAL,
        fat_g REAL,
        source_chat_id TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS exercise_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        photo_path TEXT,
        caption TEXT,
        description TEXT NOT NULL,
        exercise_type TEXT,
        duration_minutes REAL,
        intensity TEXT,
        estimated_calories_burned REAL,
        source_chat_id TEXT NOT NULL
      )
    `);
  }

  addMeal(entry: Omit<MealLogEntry, "id">): MealLogEntry {
    this.db
      .prepare(
        "INSERT INTO meal_log (date, timestamp, photo_path, caption, description, estimated_calories, protein_g, carbs_g, fat_g, source_chat_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(entry.date, entry.timestamp, entry.photoPath, entry.caption, entry.description, entry.estimatedCalories, entry.proteinG, entry.carbsG, entry.fatG, entry.sourceChatId);
    const row = this.db.prepare("SELECT * FROM meal_log WHERE id = last_insert_rowid()").get() as unknown as MealRow;
    return toMeal(row);
  }

  addExercise(entry: Omit<ExerciseLogEntry, "id">): ExerciseLogEntry {
    this.db
      .prepare(
        "INSERT INTO exercise_log (date, timestamp, photo_path, caption, description, exercise_type, duration_minutes, intensity, estimated_calories_burned, source_chat_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(entry.date, entry.timestamp, entry.photoPath, entry.caption, entry.description, entry.exerciseType, entry.durationMinutes, entry.intensity, entry.estimatedCaloriesBurned, entry.sourceChatId);
    const row = this.db.prepare("SELECT * FROM exercise_log WHERE id = last_insert_rowid()").get() as unknown as ExerciseRow;
    return toExercise(row);
  }

  getMeals(from: string, to: string): MealLogEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM meal_log WHERE date >= ? AND date <= ? ORDER BY timestamp ASC")
      .all(from, to) as unknown as MealRow[];
    return rows.map(toMeal);
  }

  getExercises(from: string, to: string): ExerciseLogEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM exercise_log WHERE date >= ? AND date <= ? ORDER BY timestamp ASC")
      .all(from, to) as unknown as ExerciseRow[];
    return rows.map(toExercise);
  }
}

let sharedRegistry: MealExerciseLogRegistry | undefined;

export function getMealExerciseLogRegistry(dbPath: string): MealExerciseLogRegistry {
  if (!sharedRegistry) sharedRegistry = new MealExerciseLogRegistry(dbPath);
  return sharedRegistry;
}
