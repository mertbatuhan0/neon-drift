import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import {
  FINISH_GRACE_MS,
  PARK_MS,
  isCarId,
  parseCommand,
  trackById,
  type CarId,
  type GameMode,
  type LobbyPlayer,
  type RaceResult,
  type RoomState,
  type ServerMessage,
  type StateSnapshot,
} from "@neon/shared";
import { publishEvent } from "./broker.js";
import { scoreRace, type ScoreEntry } from "./score.js";
import {
  carSpeed,
  freshCar,
  progressOf,
  resetGrid,
  stepWorld,
  useHeldItem,
  type SimWorld,
} from "./sim.js";

type Socket = WebSocket;

type Conn = {
  ws: Socket;
  playerId?: string;
  controllerFor?: string;
  hits: number[];
  lastSeen: number;
};

type Seat = {
  id: string;
  token: string;
  name: string;
  carId: CarId;
  ready: boolean;
  totalPoints: number;
  lastSeq: number;
  roomCode?: string;
  conn?: Conn;
  controller?: Conn;
  removeAt?: number;
};

type Room = {
  code: string;
  hostId: string;
  mode: GameMode;
  maxPlayers: number;
  world: SimWorld;
  players: Seat[];
  votes: Map<string, boolean>;
  countdownLeft: number | null;
  countdownAt: number;
  startTs: number | null;
  endsAt: number | null;
  departed: ScoreEntry[];
  tick: number;
  ended: boolean;
};

const rooms = new Map<string, Room>();
const seats = new Map<string, Seat>();
const tokens = new Map<string, Seat>();

function nid(prefix: string) {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

function roomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = "";
    const bytes = randomBytes(4);
    for (let i = 0; i < 4; i++) code += alphabet[bytes[i] % alphabet.length];
    if (!rooms.has(code)) return code;
  }
  return nid("R").slice(0, 4).toUpperCase();
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim().slice(0, 16);
  return name || null;
}

function send(ws: Socket, message: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function sockets(room: Room): Socket[] {
  const list: Socket[] = [];
  for (const seat of room.players) {
    if (seat.conn && seat.conn.ws.readyState === WebSocket.OPEN) list.push(seat.conn.ws);
    if (seat.controller && seat.controller.ws.readyState === WebSocket.OPEN) list.push(seat.controller.ws);
  }
  return list;
}

function emit(room: Room, message: ServerMessage) {
  publishEvent(message);
  const payload = JSON.stringify(message);
  for (const ws of sockets(room)) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function event(type: string, data: unknown, causedBy?: string): ServerMessage {
  const message: ServerMessage = { kind: "event", type, ts: Date.now(), data };
  if (causedBy) message.causedBy = causedBy;
  return message;
}

function reject(conn: Conn, command: string, cmdId: string, code: string, message: string) {
  send(
    conn.ws,
    event("command_rejected", { command, cmdId, code, message }, cmdId),
  );
}

function lobby(room: Room): LobbyPlayer[] {
  return room.players.map((seat) => ({
    playerId: seat.id,
    playerName: seat.name,
    carId: seat.carId,
    ready: seat.ready,
    connected: seat.conn?.ws.readyState === WebSocket.OPEN || seat.controller?.ws.readyState === WebSocket.OPEN,
    totalPoints: seat.totalPoints,
  }));
}

function broadcastState(room: Room, causedBy?: string) {
  const data: RoomState = {
    players: lobby(room),
    trackId: room.world.track.id,
    mode: room.mode,
    status: room.world.status,
    maxPlayers: room.maxPlayers,
    hostId: room.hostId,
    roomCode: room.code,
  };
  emit(room, event("room_state_updated", data, causedBy));
}

function snapshot(room: Room, now: number): StateSnapshot {
  const places = [...room.world.cars].sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished) return (a.finishTimeMs ?? 0) - (b.finishTimeMs ?? 0);
    return progressOf(b, room.world.track) - progressOf(a, room.world.track);
  });
  const placeOf = new Map(places.map((car, index) => [car.id, index + 1]));
  return {
    roomCode: room.code,
    trackId: room.world.track.id,
    mode: room.mode,
    status: room.world.status,
    tick: room.tick,
    startTs: room.startTs,
    endsAt: room.endsAt,
    serverNow: now,
    countdown: room.countdownLeft,
    players: room.world.cars.map((car) => ({
      id: car.id,
      name: car.name,
      carId: car.carId,
      x: car.x,
      y: car.y,
      angle: car.angle,
      speed: carSpeed(car),
      lap: car.lap,
      checkpoint: car.nextGate,
      place: placeOf.get(car.id) ?? room.world.cars.length,
      finished: car.finished,
      item: car.item,
      boost: now < car.boostUntil,
      shield: car.shield,
      invisible: now < car.invisibleUntil,
      parked: car.parked,
      slow: now < car.empUntil,
      spinning: now < car.spinUntil,
      bestLapMs: car.bestLapMs,
    })),
    items: room.world.items.map((item) => ({ id: item.id, type: item.type, x: item.x, y: item.y })),
    oils: room.world.oils.map((oil) => ({ id: oil.id, x: oil.x, y: oil.y })),
  };
}

function broadcastSnapshot(room: Room, now: number) {
  const message: ServerMessage = { kind: "snapshot", type: "state_snapshot", ts: now, data: snapshot(room, now) };
  const payload = JSON.stringify(message);
  for (const ws of sockets(room)) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function carOf(room: Room, id: string) {
  return room.world.cars.find((car) => car.id === id);
}

function ensureCar(room: Room, seat: Seat, now: number) {
  if (carOf(room, seat.id)) return;
  room.world.cars.push(freshCar(seat.id, seat.name, seat.carId, room.world.track, room.world.cars.length, now));
}

function removeSeat(room: Room, seat: Seat, reason: "left" | "kicked" | "timeout", now: number) {
  const car = carOf(room, seat.id);
  if (car && (room.world.status === "racing" || room.world.status === "finished")) {
    room.departed.push({
      playerId: seat.id,
      playerName: seat.name,
      finished: car.finished,
      totalTimeMs: car.finishTimeMs,
      bestLapMs: car.bestLapMs,
      progress: progressOf(car, room.world.track),
    });
  }
  room.world.cars = room.world.cars.filter((item) => item.id !== seat.id);
  room.players = room.players.filter((item) => item.id !== seat.id);
  room.votes.delete(seat.id);
  seat.roomCode = undefined;
  seat.ready = false;
  seat.removeAt = undefined;
  if (room.hostId === seat.id && room.players[0]) room.hostId = room.players[0].id;
  emit(room, event("room_left", { playerId: seat.id, playerName: seat.name, reason }));
  if (room.players.length === 0) {
    clearCountdown(room);
    rooms.delete(room.code);
    return;
  }
  broadcastState(room);
  if (room.world.status === "countdown") cancelCountdown(room, now);
  else maybeStart(room, now);
}

function connected(seat: Seat) {
  return seat.conn?.ws.readyState === WebSocket.OPEN;
}

function clearCountdown(room: Room) {
  room.countdownLeft = null;
}

function cancelCountdown(room: Room, now: number) {
  clearCountdown(room);
  room.world.status = "lobby";
  room.startTs = null;
  room.endsAt = null;
  broadcastState(room);
  broadcastSnapshot(room, now);
  maybeStart(room, now);
}

function maybeStart(room: Room, now: number) {
  if (room.world.status !== "lobby") return;
  if (room.players.length < 1) return;
  if (!room.players.every((seat) => seat.ready)) return;
  room.world.status = "countdown";
  room.ended = false;
  room.departed = [];
  room.endsAt = null;
  room.votes.clear();
  for (const seat of room.players) ensureCar(room, seat, now);
  room.world.cars = room.world.cars.filter((car) => room.players.some((seat) => seat.id === car.id));
  for (const seat of room.players) {
    const car = carOf(room, seat.id);
    if (car) {
      car.name = seat.name;
      car.carId = seat.carId;
      car.parked = false;
    }
  }
  resetGrid(room.world, now);
  room.countdownLeft = 3;
  room.countdownAt = now + 1000;
  emit(room, event("countdown_ticked", { secondsLeft: 3 }));
  broadcastState(room);
  broadcastSnapshot(room, now);
}

function startRace(room: Room, now: number) {
  clearCountdown(room);
  room.world.status = "racing";
  room.startTs = now;
  room.world.startTs = now;
  room.world.nextItemAt = now;
  for (const car of room.world.cars) car.lapStartMs = now;
  emit(room, event("race_started", { startTs: now }));
  broadcastState(room);
  broadcastSnapshot(room, now);
}

function finishRace(room: Room, now: number) {
  if (room.ended) return;
  room.ended = true;
  room.world.status = "finished";
  clearCountdown(room);
  const active: ScoreEntry[] = room.world.cars.map((car) => ({
    playerId: car.id,
    playerName: car.name,
    finished: car.finished,
    totalTimeMs: car.finishTimeMs,
    bestLapMs: car.bestLapMs,
    progress: progressOf(car, room.world.track),
  }));
  const seen = new Set(active.map((entry) => entry.playerId));
  for (const entry of room.departed) {
    if (!seen.has(entry.playerId)) active.push(entry);
  }
  const previous: Record<string, number> = {};
  for (const seat of room.players) previous[seat.id] = seat.totalPoints;
  for (const entry of room.departed) {
    const seat = seats.get(entry.playerId);
    if (seat && previous[entry.playerId] == null) previous[entry.playerId] = seat.totalPoints;
  }
  const results: RaceResult[] = scoreRace(active, previous);
  for (const result of results) {
    const seat = seats.get(result.playerId);
    if (seat) seat.totalPoints = result.totalPoints;
  }
  room.votes.clear();
  emit(room, event("race_ended", { results, trackId: room.world.track.id, mode: room.mode }));
  broadcastState(room);
  broadcastSnapshot(room, now);
}

function maybeRematch(room: Room, now: number) {
  if (room.world.status !== "finished") return;
  const voters = room.players.filter((seat) => connected(seat));
  if (!voters.length || !voters.every((seat) => room.votes.get(seat.id) === true)) return;
  const nextId = ((room.world.track.id % 3) + 1) as 1 | 2 | 3;
  const track = trackById(nextId);
  if (!track) return;
  room.world.track = track;
  room.world.status = "lobby";
  room.ended = false;
  room.startTs = null;
  room.endsAt = null;
  room.departed = [];
  room.votes.clear();
  clearCountdown(room);
  for (const seat of room.players) seat.ready = false;
  resetGrid(room.world, now);
  broadcastState(room);
}

function applySimEvents(room: Room, events: ReturnType<typeof stepWorld>, now: number) {
  let finishPlace = room.world.cars.filter((car) => car.finished).length - events.filter((item) => item.type === "player_finished").length;
  for (const sim of events) {
    if (sim.type === "checkpoint_passed") {
      emit(room, event("checkpoint_passed", {
        playerId: sim.playerId,
        playerName: sim.playerName,
        checkpointId: sim.checkpointId,
        lap: sim.lap,
      }));
    } else if (sim.type === "lap_completed") {
      emit(room, event("lap_completed", {
        playerId: sim.playerId,
        playerName: sim.playerName,
        lap: sim.lap,
        lapTimeMs: sim.lapTimeMs,
        trackId: room.world.track.id,
        mode: room.mode,
      }));
    } else if (sim.type === "player_finished") {
      finishPlace += 1;
      emit(room, event("player_finished", {
        playerId: sim.playerId,
        playerName: sim.playerName,
        position: finishPlace,
        totalTimeMs: sim.totalTimeMs,
      }));
      emitHaptic(room, sim.playerId, "finish");
      if (finishPlace === 1) room.endsAt = now + FINISH_GRACE_MS;
    } else if (sim.type === "item_spawned") {
      emit(room, event("item_spawned", { itemId: sim.itemId, type: sim.itemType, x: sim.x, y: sim.y }));
    } else if (sim.type === "item_picked_up") {
      emit(room, event("item_picked_up", {
        itemId: sim.itemId,
        playerId: sim.playerId,
        playerName: sim.playerName,
        type: sim.itemType,
      }));
    } else if (sim.type === "item_used") {
      emit(room, event("item_used", {
        playerId: sim.playerId,
        playerName: sim.playerName,
        type: sim.itemType,
        targetId: sim.targetId,
      }));
    } else if (sim.type === "car_hit") {
      emit(room, event("car_hit", {
        playerId: sim.playerId,
        playerName: sim.playerName,
        source: sim.source,
        effect: sim.effect,
        durationMs: sim.durationMs,
      }));
    } else if (sim.type === "haptic_triggered") {
      emitHaptic(room, sim.playerId, sim.pattern);
    }
  }
}

function seatFromConn(conn: Conn) {
  const id = conn.controllerFor || conn.playerId;
  return id ? seats.get(id) : undefined;
}

function emitHaptic(room: Room, playerId: string, pattern: "hit" | "boost" | "finish") {
  emit(room, event("haptic_triggered", { playerId, pattern }));
  const seat = seats.get(playerId);
  const link = seat?.controller?.ws;
  if (link && link.readyState === WebSocket.OPEN) {
    link.send(JSON.stringify({ type: "controller_feedback", event: pattern }));
  }
}

/** The wheel bridge speaks command/payload. Fold that into the game_events envelope. */
function adaptBridge(text: string): string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return text;
  }
  if (!body || typeof body !== "object") return text;
  const rec = body as Record<string, unknown>;
  if (rec.kind === "command" || typeof rec.command !== "string") return text;
  const payload = rec.payload && typeof rec.payload === "object" ? (rec.payload as Record<string, unknown>) : {};
  const stamp = Date.now();
  if (rec.command === "connect_controller") {
    const who = payload.player_name ?? payload.playerName ?? payload.player_id ?? payload.playerId;
    return JSON.stringify({
      kind: "command",
      type: "attach_controller",
      cmdId: `bridge-${stamp}`,
      ts: stamp,
      data: {
        deviceType: payload.device_type ?? payload.deviceType ?? "wheel",
        roomCode: payload.room_code ?? payload.roomCode,
        playerName: who,
        playerId: payload.player_id ?? payload.playerId ?? who,
      },
    });
  }
  if (rec.command === "drive_input") {
    return JSON.stringify({
      kind: "command",
      type: "set_input",
      cmdId: `bridge-${payload.sequence ?? stamp}`,
      ts: stamp,
      data: {
        seq: payload.sequence ?? payload.seq,
        steer: payload.steer,
        throttle: payload.throttle,
        brake: payload.brake,
      },
    });
  }
  if (rec.command === "use_item") {
    return JSON.stringify({
      kind: "command",
      type: "use_item",
      cmdId: `bridge-item-${stamp}`,
      ts: stamp,
      data: { seq: payload.sequence ?? payload.seq },
    });
  }
  return text;
}

export function handleSocket(ws: Socket) {
  const conn: Conn = { ws, hits: [], lastSeen: Date.now() };
  ws.on("message", (buf) => {
    conn.lastSeen = Date.now();
    const text = typeof buf === "string" ? buf : buf.toString();
    if (text.length > 8000) {
      reject(conn, "unknown", "", "BAD_MESSAGE", "Message too large");
      return;
    }
    const now = Date.now();
    conn.hits = conn.hits.filter((stamp) => now - stamp < 1000);
    const parsed = parseCommand(adaptBridge(text));
    if (!parsed.ok) {
      reject(conn, "unknown", parsed.cmdId || "", parsed.error, "Could not read command");
      return;
    }
    if (conn.hits.length >= 60) {
      if (parsed.command.type !== "set_input") {
        reject(conn, parsed.command.type, parsed.command.cmdId, "RATE_LIMIT", "Too many messages");
      }
      return;
    }
    conn.hits.push(now);
    onCommand(conn, parsed.command, now);
  });
  ws.on("close", () => onClose(conn, Date.now()));
}

function onClose(conn: Conn, now: number) {
  if (conn.controllerFor) {
    const seat = seats.get(conn.controllerFor);
    if (seat?.controller === conn) seat.controller = undefined;
  }
  if (!conn.playerId) return;
  const seat = seats.get(conn.playerId);
  if (!seat || seat.conn !== conn) return;
  seat.conn = undefined;
  const room = seat.roomCode ? rooms.get(seat.roomCode) : undefined;
  if (!room) return;
  if (room.world.status === "lobby") {
    removeSeat(room, seat, "timeout", now);
    return;
  }
  const car = carOf(room, seat.id);
  if (car) car.parked = true;
  seat.removeAt = now + PARK_MS;
  emit(room, event("player_disconnected", { playerId: seat.id, playerName: seat.name }));
  broadcastState(room);
}

function onCommand(conn: Conn, command: { type: string; cmdId: string; data: Record<string, unknown> }, now: number) {
  if (command.type === "ping") {
    send(conn.ws, event("pong", { ts: command.data.ts ?? now }));
    return;
  }
  if (command.type === "connect") {
    onConnect(conn, command, now);
    return;
  }
  if (command.type === "attach_controller") {
    onAttach(conn, command);
    return;
  }
  const seat = seatFromConn(conn);
  if (!seat) {
    reject(conn, command.type, command.cmdId, "NOT_CONNECTED", "Connect first");
    return;
  }
  if (command.type === "set_input" || command.type === "use_item") {
    onDrive(conn, seat, command, now);
    return;
  }
  if (conn.controllerFor) {
    reject(conn, command.type, command.cmdId, "NOT_ALLOWED", "Controller socket cannot do that");
    return;
  }
  if (command.type === "create_room") onCreate(conn, seat, command, now);
  else if (command.type === "join_room") onJoin(conn, seat, command, now);
  else if (command.type === "leave_room") onLeave(seat, command.cmdId, now);
  else if (command.type === "select_car") onCar(conn, seat, command);
  else if (command.type === "set_ready") onReady(conn, seat, command, now);
  else if (command.type === "vote_rematch") onVote(conn, seat, command, now);
}

function onConnect(conn: Conn, command: { cmdId: string; data: Record<string, unknown> }, now: number) {
  if (conn.playerId || conn.controllerFor) {
    reject(conn, "connect", command.cmdId, "ALREADY_CONNECTED", "Socket already connected");
    return;
  }
  const name = cleanName(command.data.playerName);
  if (!name) {
    reject(conn, "connect", command.cmdId, "BAD_INPUT", "Name is required");
    return;
  }
  const token = typeof command.data.token === "string" ? command.data.token : "";
  const existing = token ? tokens.get(token) : undefined;
  if (existing) {
    if (existing.conn && existing.conn !== conn) {
      try { existing.conn.ws.close(); } catch { /* already closing */ }
      existing.conn = undefined;
    }
    existing.name = name;
    existing.conn = conn;
    existing.removeAt = undefined;
    conn.playerId = existing.id;
    send(conn.ws, event("session_opened", { playerId: existing.id, token: existing.token, resumed: true }, command.cmdId));
    const room = existing.roomCode ? rooms.get(existing.roomCode) : undefined;
    if (room) {
      const car = carOf(room, existing.id);
      if (car) {
        car.parked = false;
        car.name = existing.name;
      }
      emit(room, event("player_reconnected", { playerId: existing.id, playerName: existing.name }, command.cmdId));
      broadcastState(room);
      if (room.world.status !== "lobby") broadcastSnapshot(room, now);
    }
    return;
  }
  const seat: Seat = {
    id: nid("p"),
    token: randomBytes(18).toString("hex"),
    name,
    carId: "volt",
    ready: false,
    totalPoints: 0,
    lastSeq: 0,
    conn,
  };
  seats.set(seat.id, seat);
  tokens.set(seat.token, seat);
  conn.playerId = seat.id;
  send(conn.ws, event("session_opened", { playerId: seat.id, token: seat.token, resumed: false }, command.cmdId));
}

function onCreate(conn: Conn, seat: Seat, command: { cmdId: string; data: Record<string, unknown> }, now: number) {
  if (seat.roomCode) {
    reject(conn, "create_room", command.cmdId, "IN_ROOM", "Leave the current room first");
    return;
  }
  const track = trackById(Number(command.data.trackId));
  if (!track) {
    reject(conn, "create_room", command.cmdId, "BAD_INPUT", "Unknown track");
    return;
  }
  const mode: GameMode = command.data.mode === "time_attack" ? "time_attack" : "race";
  let maxPlayers = Number(command.data.maxPlayers ?? 4);
  if (!Number.isInteger(maxPlayers)) maxPlayers = 4;
  maxPlayers = Math.max(1, Math.min(4, maxPlayers));
  if (mode === "time_attack") maxPlayers = 1;
  if (mode === "race") maxPlayers = Math.max(2, maxPlayers);
  const code = roomCode();
  const world: SimWorld = {
    track,
    cars: [],
    items: [],
    oils: [],
    status: "lobby",
    startTs: null,
    nextItemAt: now,
    idSeq: 0,
  };
  const room: Room = {
    code,
    hostId: seat.id,
    mode,
    maxPlayers,
    world,
    players: [],
    votes: new Map(),
    countdownLeft: null,
    countdownAt: 0,
    startTs: null,
    endsAt: null,
    departed: [],
    tick: 0,
    ended: false,
  };
  rooms.set(code, room);
  seat.roomCode = code;
  seat.ready = false;
  room.players.push(seat);
  emit(room, event("room_created", { roomCode: code, trackId: track.id, maxPlayers, mode }, command.cmdId));
  emit(room, event("room_joined", { playerId: seat.id, playerName: seat.name, roomCode: code }, command.cmdId));
  broadcastState(room, command.cmdId);
}

function onJoin(conn: Conn, seat: Seat, command: { cmdId: string; data: Record<string, unknown> }, now: number) {
  if (seat.roomCode) {
    reject(conn, "join_room", command.cmdId, "IN_ROOM", "Leave the current room first");
    return;
  }
  const code = typeof command.data.roomCode === "string" ? command.data.roomCode.trim().toUpperCase() : "";
  const room = rooms.get(code);
  if (!room) {
    reject(conn, "join_room", command.cmdId, "ROOM_NOT_FOUND", "No room with that code");
    return;
  }
  if (room.world.status !== "lobby") {
    reject(conn, "join_room", command.cmdId, "RACE_IN_PROGRESS", "Race already started");
    return;
  }
  if (room.players.length >= room.maxPlayers) {
    reject(conn, "join_room", command.cmdId, "ROOM_FULL", "Room is full");
    return;
  }
  seat.roomCode = code;
  seat.ready = false;
  room.players.push(seat);
  emit(room, event("room_joined", { playerId: seat.id, playerName: seat.name, roomCode: code }, command.cmdId));
  broadcastState(room, command.cmdId);
  void now;
}

function onLeave(seat: Seat, cmdId: string, now: number) {
  const room = seat.roomCode ? rooms.get(seat.roomCode) : undefined;
  if (!room) return;
  removeSeat(room, seat, "left", now);
  if (seat.conn) send(seat.conn.ws, event("room_left", { playerId: seat.id, playerName: seat.name, reason: "left" }, cmdId));
}

function onCar(conn: Conn, seat: Seat, command: { cmdId: string; data: Record<string, unknown> }) {
  const room = seat.roomCode ? rooms.get(seat.roomCode) : undefined;
  if (!room) {
    reject(conn, "select_car", command.cmdId, "NOT_IN_ROOM", "Join a room first");
    return;
  }
  if (room.world.status !== "lobby") {
    reject(conn, "select_car", command.cmdId, "RACE_IN_PROGRESS", "Car is locked");
    return;
  }
  if (!isCarId(command.data.carId)) {
    reject(conn, "select_car", command.cmdId, "BAD_INPUT", "Unknown car");
    return;
  }
  seat.carId = command.data.carId;
  emit(room, event("car_selected", { playerId: seat.id, playerName: seat.name, carId: seat.carId }, command.cmdId));
  broadcastState(room, command.cmdId);
}

function onReady(conn: Conn, seat: Seat, command: { cmdId: string; data: Record<string, unknown> }, now: number) {
  const room = seat.roomCode ? rooms.get(seat.roomCode) : undefined;
  if (!room) {
    reject(conn, "set_ready", command.cmdId, "NOT_IN_ROOM", "Join a room first");
    return;
  }
  if (room.world.status !== "lobby" && room.world.status !== "countdown") {
    reject(conn, "set_ready", command.cmdId, "RACE_IN_PROGRESS", "Already racing");
    return;
  }
  seat.ready = Boolean(command.data.ready);
  emit(room, event("ready_changed", { playerId: seat.id, playerName: seat.name, ready: seat.ready }, command.cmdId));
  if (!seat.ready && room.world.status === "countdown") cancelCountdown(room, now);
  else {
    broadcastState(room, command.cmdId);
    maybeStart(room, now);
  }
}

function onVote(conn: Conn, seat: Seat, command: { cmdId: string; data: Record<string, unknown> }, now: number) {
  const room = seat.roomCode ? rooms.get(seat.roomCode) : undefined;
  if (!room || room.world.status !== "finished") {
    reject(conn, "vote_rematch", command.cmdId, "NOT_IN_ROOM", "Rematch is only open on the results screen");
    return;
  }
  const vote = Boolean(command.data.vote);
  room.votes.set(seat.id, vote);
  emit(room, event("rematch_vote_cast", { playerId: seat.id, playerName: seat.name, vote }, command.cmdId));
  maybeRematch(room, now);
}

function onAttach(conn: Conn, command: { cmdId: string; data: Record<string, unknown> }) {
  if (conn.playerId) {
    reject(conn, "attach_controller", command.cmdId, "NOT_ALLOWED", "This socket is a player session");
    return;
  }
  const device = command.data.deviceType === "wheel" ? "wheel" : command.data.deviceType === "psx" ? "psx" : null;
  const code = typeof command.data.roomCode === "string" ? command.data.roomCode.trim().toUpperCase() : "";
  const name = cleanName(command.data.playerName);
  const hintedId = typeof command.data.playerId === "string" ? command.data.playerId : "";
  if (!device || (!name && !hintedId)) {
    reject(conn, "attach_controller", command.cmdId, "BAD_INPUT", "deviceType and playerName are required");
    return;
  }
  const room = rooms.get(code);
  if (!room) {
    reject(conn, "attach_controller", command.cmdId, "ROOM_NOT_FOUND", "No room with that code");
    return;
  }
  const matches = room.players.filter(
    (seat) => (hintedId && seat.id === hintedId) || (name != null && seat.name.toLowerCase() === name.toLowerCase()),
  );
  if (matches.length === 0) {
    reject(conn, "attach_controller", command.cmdId, "PLAYER_NOT_FOUND", "No player with that name");
    return;
  }
  const open = matches.find((seat) => !seat.controller);
  if (!open) {
    reject(conn, "attach_controller", command.cmdId, "AMBIGUOUS_PLAYER", "Matching players already have a controller");
    return;
  }
  if (open.controller) open.controller.controllerFor = undefined;
  open.controller = conn;
  conn.controllerFor = open.id;
  emit(room, event("controller_attached", { playerId: open.id, deviceType: device, playerName: open.name }, command.cmdId));
}

function onDrive(conn: Conn, seat: Seat, command: { type: string; cmdId: string; data: Record<string, unknown> }, now: number) {
  const room = seat.roomCode ? rooms.get(seat.roomCode) : undefined;
  if (!room) {
    if (command.type === "use_item") reject(conn, command.type, command.cmdId, "NOT_IN_ROOM", "Join a room first");
    return;
  }
  let seq = Number(command.data.seq);
  if (!Number.isFinite(seq) && conn.controllerFor && command.type === "use_item") seq = seat.lastSeq + 1;
  if (!Number.isFinite(seq)) {
    reject(conn, command.type, command.cmdId, "BAD_INPUT", "seq is required");
    return;
  }
  if (seq <= seat.lastSeq) return;
  seat.lastSeq = seq;
  const car = carOf(room, seat.id);
  if (!car) return;
  if (command.type === "set_input") {
    const steer = Number(command.data.steer);
    const throttle = Number(command.data.throttle);
    const brake = Number(command.data.brake);
    if (![steer, throttle, brake].every(Number.isFinite)) return;
    car.input.steer = Math.max(-1, Math.min(1, steer));
    car.input.throttle = Math.max(0, Math.min(1, throttle));
    car.input.brake = Math.max(0, Math.min(1, brake));
    return;
  }
  const used = useHeldItem(room.world, car, now);
  if (used === "empty") {
    reject(conn, "use_item", command.cmdId, "NO_ITEM", "No item held");
    return;
  }
  applySimEvents(room, used, now);
}

export function tick(dt: number, now: number) {
  for (const room of [...rooms.values()]) {
    for (const seat of [...room.players]) {
      if (seat.removeAt && now >= seat.removeAt && !connected(seat)) {
        removeSeat(room, seat, "timeout", now);
      }
    }
    if (!rooms.has(room.code)) continue;
    if (room.world.status === "countdown" && room.countdownLeft != null && now >= room.countdownAt) {
      room.countdownLeft -= 1;
      if (room.countdownLeft <= 0) startRace(room, now);
      else {
        room.countdownAt = now + 1000;
        emit(room, event("countdown_ticked", { secondsLeft: room.countdownLeft }));
      }
    }
    if (room.world.status === "racing" || room.world.status === "countdown") {
      const events = stepWorld(room.world, room.world.status === "racing" ? dt : 0, now);
      applySimEvents(room, events, now);
      const live = room.world.cars.filter((car) => !car.parked);
      if (room.world.status === "racing") {
        if (live.length === 0 || live.every((car) => car.finished) || (room.endsAt != null && now >= room.endsAt)) {
          finishRace(room, now);
        }
      }
    }
    room.tick += 1;
    if (room.world.status !== "lobby" && room.tick % 2 === 0) broadcastSnapshot(room, now);
    for (const seat of room.players) {
      const stale = (link?: Conn) => link && now - link.lastSeen > 10_000 && link.ws.readyState === WebSocket.OPEN;
      if (stale(seat.conn)) seat.conn?.ws.close();
      if (stale(seat.controller)) seat.controller?.ws.close();
    }
  }
}

export function resetState() {
  rooms.clear();
  seats.clear();
  tokens.clear();
}

export function roomCount() {
  return rooms.size;
}
