import { trackById } from "@neon/shared";

export type StoredLap = {
  player: string;
  trackId: number;
  lapTimeMs: number;
  mode: string;
  lap: number;
};

export function trackHint(value: unknown): { trackId: number; mode?: string } | null {
  if (!value || typeof value !== "object") return null;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const rec = data as Record<string, unknown>;
  const trackId = Number(rec.trackId);
  if (!Number.isInteger(trackId)) return null;
  const mode = rec.mode === "time_attack" || rec.mode === "race" ? rec.mode : undefined;
  return { trackId, mode };
}

export function lapFromBroker(value: unknown, fallback?: { trackId?: number; mode?: string }): StoredLap | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (rec.type !== "lap_completed") return null;
  const data = rec.data && typeof rec.data === "object" && !Array.isArray(rec.data)
    ? rec.data as Record<string, unknown>
    : {};
  const player = typeof rec.player === "string" && rec.player
    ? rec.player
    : typeof data.playerName === "string"
      ? data.playerName
      : "";
  const lapTimeMs = Number(data.lapTimeMs);
  const ownTrack = Number(data.trackId);
  const trackId = Number.isInteger(ownTrack) ? ownTrack : Number(fallback?.trackId);
  const lap = Number(data.lap);
  const mode = data.mode === "time_attack" || data.mode === "race"
    ? data.mode
    : fallback?.mode === "time_attack" || fallback?.mode === "race"
      ? fallback.mode
      : "race";
  if (!player || !Number.isFinite(lapTimeMs) || !Number.isInteger(trackId)) return null;
  const track = trackById(trackId);
  if (!track) return null;
  const fastest = (track.length / 520) * 1000;
  if (lapTimeMs < fastest || lapTimeMs >= 5 * 60 * 1000) return null;
  return {
    player,
    trackId,
    lapTimeMs: Math.round(lapTimeMs),
    mode,
    lap: Number.isInteger(lap) ? lap : 0,
  };
}
