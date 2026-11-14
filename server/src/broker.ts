import type { ServerMessage } from "@neon/shared";

const SKIP = new Set(["state_snapshot", "pong", "command_rejected", "session_opened"]);
const BATCH = 20;

type Pending = { type: string; value: Record<string, unknown> };

let queue: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let loggedSkip = false;

export function toBrokerValue(message: ServerMessage): Record<string, unknown> | null {
  if (message.kind !== "event" || SKIP.has(message.type)) return null;
  const data =
    message.data && typeof message.data === "object" && !Array.isArray(message.data)
      ? { ...(message.data as Record<string, unknown>) }
      : {};
  delete data.token;
  const player = typeof data.playerName === "string" ? data.playerName : undefined;
  return {
    type: message.type,
    kind: "event",
    ts: message.ts,
    player,
    data,
  };
}

export function publishBlockReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.BROKER_URL) return "BROKER_URL is not set";
  if (!env.BROKER_PASSWORD) return "BROKER_PASSWORD is not set";
  return null;
}

export function brokerRecords(values: Record<string, unknown>[]) {
  return { records: values.map((value) => ({ value })) };
}

export function publishEvent(message: ServerMessage) {
  const value = toBrokerValue(message);
  if (!value) return;
  const reason = publishBlockReason();
  if (reason) {
    if (!loggedSkip) {
      loggedSkip = true;
      console.warn(`broker ${message.type} not published: ${reason}. Later events stay off the broker until it is set.`);
    }
    return;
  }
  queue.push({ type: message.type, value });
  if (queue.length >= BATCH) {
    void flushPublishes();
    return;
  }
  if (!timer) {
    timer = setTimeout(() => {
      void flushPublishes();
    }, 250);
    timer.unref?.();
  }
}

export async function flushPublishes() {
  if (timer) clearTimeout(timer);
  timer = null;
  const batch = queue.splice(0, queue.length);
  if (!batch.length) return;
  const reason = publishBlockReason();
  const base = process.env.BROKER_URL;
  const password = process.env.BROKER_PASSWORD;
  if (reason || !base || !password) {
    console.warn(`broker flush dropped ${batch.map((item) => item.type).join(", ")}: ${reason ?? "missing broker env"}`);
    return;
  }
  const user = process.env.BROKER_USER || "team3";
  const topic = process.env.BROKER_TOPIC || "team3.events";
  const url = `${base.replace(/\/$/, "")}/topics/${topic}`;
  const auth = Buffer.from(`${user}:${password}`).toString("base64");
  const names = batch.map((item) => item.type).join(", ");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.kafka.json.v2+json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(brokerRecords(batch.map((item) => item.value))),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`broker publish failed (${names}) -> ${res.status} ${text.slice(0, 160)}`);
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.warn(`broker publish failed (${names}): ${why}`);
  }
}

export function resetBrokerForTests() {
  queue = [];
  loggedSkip = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
