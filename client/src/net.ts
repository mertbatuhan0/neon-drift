import type { RaceResult, RoomState, ServerMessage, StateSnapshot } from "@neon/shared";

const TOKEN_KEY = "neon-drift-token";
const NAME_KEY = "neon-drift-name";

function devScreen() {
  return location.port === "5173" || location.port === "4173";
}

export function wsUrl() {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  if (devScreen()) return `${proto}://${location.hostname}:8787`;
  return `${proto}://${location.host}`;
}

export function httpUrl() {
  if (import.meta.env.VITE_HTTP_URL) return import.meta.env.VITE_HTTP_URL;
  if (devScreen()) return `${location.protocol}//${location.hostname}:8787`;
  return location.origin;
}

export class Net {
  status: "offline" | "connecting" | "online" = "offline";
  playerId = "";
  token = sessionStorage.getItem(TOKEN_KEY) || "";
  name = sessionStorage.getItem(NAME_KEY) || "";
  room: RoomState | null = null;
  snap: StateSnapshot | null = null;
  results: RaceResult[] | null = null;
  error = "";
  toast = "";
  pingMs = 0;
  countdown: number | null = null;
  voted = false;
  onChange: () => void = () => {};

  private ws: WebSocket | null = null;
  private seq = 0;
  private attempts = 0;
  private intentional = false;
  private pingTimer = 0;
  private toastTimer = 0;
  private lastInputAt = 0;
  private lastInput = "";

  connect(name: string) {
    this.name = name.trim().slice(0, 16);
    sessionStorage.setItem(NAME_KEY, this.name);
    this.intentional = false;
    this.open();
  }

  disconnect() {
    this.intentional = true;
    window.clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    this.status = "offline";
    this.room = null;
    this.snap = null;
    this.changed();
  }

  command(type: string, data: Record<string, unknown> = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      kind: "command",
      type,
      cmdId: `c-${++this.seq}`,
      ts: Date.now(),
      data,
    }));
  }

  drive(input: { steer: number; throttle: number; brake: number }, forceItem: boolean) {
    if (this.snap?.status !== "racing") return;
    const me = this.snap.players.find((player) => player.id === this.playerId);
    if (!me || me.finished || me.parked) return;
    const key = `${input.steer.toFixed(2)}:${input.throttle.toFixed(2)}:${input.brake.toFixed(2)}`;
    const now = Date.now();
    if (key !== this.lastInput || now - this.lastInputAt > 200) {
      this.lastInput = key;
      this.lastInputAt = now;
      this.seq += 1;
      this.command("set_input", { seq: this.seq, ...input });
    }
    if (forceItem) {
      this.seq += 1;
      this.command("use_item", { seq: this.seq });
    }
  }

  private open() {
    this.status = "connecting";
    this.error = "";
    this.changed();
    const ws = new WebSocket(wsUrl());
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.attempts = 0;
      this.command("connect", { playerName: this.name, token: this.token || undefined });
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        const ts = Date.now();
        this.command("ping", { ts });
      }, 2000);
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      this.onMessage(msg);
    });
    ws.addEventListener("close", () => {
      window.clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.status = "offline";
      this.changed();
      if (this.intentional) return;
      const wait = Math.min(8000, 400 * 2 ** this.attempts);
      this.attempts += 1;
      window.setTimeout(() => {
        if (!this.intentional) this.open();
      }, wait);
    });
  }

  private onMessage(msg: ServerMessage) {
    const data = (msg.data ?? {}) as Record<string, unknown>;
    if (msg.type === "session_opened") {
      this.status = "online";
      this.playerId = String(data.playerId || "");
      this.token = String(data.token || "");
      sessionStorage.setItem(TOKEN_KEY, this.token);
    } else if (msg.type === "room_state_updated") {
      this.room = data as unknown as RoomState;
      if (this.room.status === "lobby") {
        this.snap = null;
        this.results = null;
        this.countdown = null;
        this.voted = false;
      }
    } else if (msg.type === "state_snapshot") {
      this.snap = data as unknown as StateSnapshot;
      if (this.snap.countdown) this.countdown = this.snap.countdown;
      if (this.snap.status === "racing") this.countdown = null;
    } else if (msg.type === "countdown_ticked") {
      this.countdown = Number(data.secondsLeft);
    } else if (msg.type === "race_started") {
      this.countdown = null;
    } else if (msg.type === "race_ended") {
      this.results = (data.results as RaceResult[]) || [];
    } else if (msg.type === "command_rejected") {
      this.error = String(data.message || data.code || "Rejected");
    } else if (msg.type === "pong") {
      const echo = Number(data.ts);
      if (Number.isFinite(echo)) this.pingMs = Math.max(0, Date.now() - echo);
    } else if (msg.type === "room_left" && data.playerId === this.playerId) {
      this.room = null;
      this.snap = null;
      this.results = null;
    } else if (msg.type === "rematch_vote_cast" && data.playerId === this.playerId) {
      this.voted = Boolean(data.vote);
    } else if (data.playerId === this.playerId) {
      if (msg.type === "car_hit") this.flash(data.effect === "shield" ? "Shield broke" : `Hit: ${data.effect}`);
      if (msg.type === "item_picked_up") this.flash(`Picked up ${data.type}`);
      if (msg.type === "item_used") this.flash(`Used ${data.type}`);
      if (msg.type === "haptic_triggered") document.body.classList.add("flash");
    }
    if (msg.type === "haptic_triggered") {
      window.setTimeout(() => document.body.classList.remove("flash"), 140);
    }
    this.changed();
  }

  private flash(text: string) {
    this.toast = text;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast = "";
      this.changed();
    }, 1400);
  }

  private changed() {
    this.onChange();
  }
}
