import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LeaderboardRow } from "@neon/shared";

let db: DatabaseSync | null = null;

function database(): DatabaseSync {
  if (db) return db;
  const file = process.env.LEADERBOARD_PATH || path.resolve("data", "leaderboard.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = 3000`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS laps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_name TEXT NOT NULL,
      track_id INTEGER NOT NULL,
      lap_time_ms INTEGER NOT NULL,
      mode TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  const columns = db.prepare(`PRAGMA table_info(laps)`).all() as { name: string }[];
  if (!columns.some((column) => column.name === "lap")) {
    db.exec(`ALTER TABLE laps ADD COLUMN lap INTEGER NOT NULL DEFAULT 0`);
  }
  return db;
}

export function recordLap(playerName: string, trackId: number, lapTimeMs: number, mode: string, lap = 0) {
  const db = database();
  const time = Math.round(lapTimeMs);
  const lapNo = Math.round(lap);
  const existing = db.prepare(
    `SELECT id FROM laps
     WHERE player_name = ? AND track_id = ? AND lap_time_ms = ? AND mode = ? AND lap = ?`,
  ).get(playerName, trackId, time, mode, lapNo);
  if (existing) return false;
  db.prepare(
    `INSERT INTO laps (player_name, track_id, lap_time_ms, mode, created_at, lap)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(playerName, trackId, time, mode, new Date().toISOString(), lapNo);
  return true;
}

export function topLaps(trackId: number, limit = 10): LeaderboardRow[] {
  return database()
    .prepare(
      `SELECT player_name, track_id, lap_time_ms, mode, created_at
       FROM laps WHERE track_id = ? ORDER BY lap_time_ms ASC LIMIT ?`,
    )
    .all(trackId, limit) as unknown as LeaderboardRow[];
}

export function closeStore() {
  db?.close();
  db = null;
}
