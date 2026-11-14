import { openBrokerConsumer, type BrokerConsumer } from "./broker-consumer.js";
import { lapFromBroker, trackHint } from "./consume.js";
import { loadEnv } from "./env.js";
import { recordLap } from "./store.js";

loadEnv();

const password = process.env.BROKER_PASSWORD || "";
const base = process.env.BROKER_URL || "";
const user = process.env.BROKER_USER || "team3";
const topic = process.env.BROKER_TOPIC || "team3.events";
const group = process.env.BROKER_GROUP || "team3.leaderboard";

if (!password || !base) {
  console.warn("leaderboard consumer stopped: set BROKER_URL and BROKER_PASSWORD");
  process.exit(0);
}
if (!group.startsWith("team3")) {
  console.warn(`leaderboard consumer stopped: consumer group ${group} must start with team3`);
  process.exit(1);
}

let stopped = false;
let current: BrokerConsumer | null = null;
let warnedBareLap = false;

function shutdown() {
  stopped = true;
  void current?.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function loop() {
  console.log(`leaderboard consumer group ${group} topic ${topic}`);
  while (!stopped) {
    try {
      current = await openBrokerConsumer({ baseUrl: base, user, password, group, topic });
      let context: { trackId?: number; mode?: string } = {};
      while (!stopped) {
        const values = await current.poll();
        for (const value of values) {
          const hint = trackHint(value);
          if (hint) context = { trackId: hint.trackId, mode: hint.mode ?? context.mode };
          const lap = lapFromBroker(value, context);
          if (!lap) {
            const rec = value && typeof value === "object" ? value as Record<string, unknown> : null;
            const data = rec?.data && typeof rec.data === "object" ? rec.data as Record<string, unknown> : null;
            if (rec?.type === "lap_completed" && data && data.trackId == null && !warnedBareLap) {
              warnedBareLap = true;
              console.warn("leaderboard skipped lap_completed without trackId");
            }
            continue;
          }
          if (recordLap(lap.player, lap.trackId, lap.lapTimeMs, lap.mode, lap.lap)) {
            console.log(`leaderboard stored ${lap.player} ${lap.lapTimeMs}ms track ${lap.trackId}`);
          }
        }
      }
      await current.close();
      current = null;
    } catch (err) {
      current = null;
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`leaderboard consumer failed: ${reason}`);
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

void loop();
