import { CARS, CAR_IDS, TRACKS, type GameMode, type LeaderboardRow } from "@neon/shared";
import { Net, httpUrl } from "./net.js";
import { RaceView, lapLabel } from "./race.js";

const net = new Net();
const raceRoot = document.querySelector<HTMLElement>("#race-root");
if (!raceRoot) throw new Error("Missing race root");
const race = new RaceView(raceRoot);

const connectScreen = must("#connect");
const menuScreen = must("#menu");
const roomScreen = must("#room");
const raceScreen = must("#race");
const link = must("#link");
const nameInput = mustInput<HTMLInputElement>("#name");
const connectError = must("#connect-error");
const menuError = must("#menu-error");
const trackPicker = must("#track-picker");
const modeHelp = must("#mode-help");
const maxLabel = must("#max-label");
const maxPlayers = mustInput<HTMLSelectElement>("#max-players");
const codeBtn = must("#code-btn") as HTMLButtonElement;
const playerList = must("#player-list");
const carPicker = must("#car-picker");
const readyBtn = must("#ready-btn") as HTMLButtonElement;
const bridgeHint = must("#bridge-hint");
const roomMeta = must("#room-meta");
const hudPlace = must("#hud-place");
const hudLap = must("#hud-lap");
const hudItem = must("#hud-item");
const hudSpeed = must("#hud-speed");
const countdownEl = must("#countdown");
const toastEl = must("#toast");
const resultsEl = must("#results");
const resultList = must("#result-list");
const boardList = must("#board-list");
const rematchBtn = must("#rematch-btn") as HTMLButtonElement;

let mode: GameMode = "race";
let trackId = 1;
let boardFor = "";

nameInput.value = net.name;
TRACKS.forEach((track) => {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.track = String(track.id);
  button.innerHTML = `${track.name}<small>${track.id === 2 ? "Tight turns" : track.id === 3 ? "Long straights" : "Beginner"}</small>`;
  button.addEventListener("click", () => {
    trackId = track.id;
    paintTracks();
  });
  trackPicker.append(button);
});
paintTracks();

CAR_IDS.forEach((id) => {
  const button = document.createElement("button");
  button.type = "button";
  button.innerHTML = `${CARS[id].name}<small>${CARS[id].blurb}</small>`;
  button.addEventListener("click", () => net.command("select_car", { carId: id }));
  carPicker.append(button);
});

document.querySelectorAll<HTMLButtonElement>("#mode-picker button").forEach((button) => {
  button.addEventListener("click", () => {
    mode = button.dataset.mode === "time_attack" ? "time_attack" : "race";
    paintModes();
  });
});

mustForm("#connect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  net.connect(nameInput.value);
});
mustForm("#create-form").addEventListener("submit", (event) => {
  event.preventDefault();
  net.command("create_room", {
    trackId,
    maxPlayers: mode === "time_attack" ? 1 : Number(maxPlayers.value),
    mode,
  });
});
mustForm("#join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const code = mustInput<HTMLInputElement>("#code").value;
  net.command("join_room", { roomCode: code.toUpperCase() });
});
must("#leave-btn").addEventListener("click", () => net.command("leave_room"));
must("#results-leave").addEventListener("click", () => net.command("leave_room"));
readyBtn.addEventListener("click", () => {
  const me = net.room?.players.find((player) => player.playerId === net.playerId);
  net.command("set_ready", { ready: !me?.ready });
});
rematchBtn.addEventListener("click", () => net.command("vote_rematch", { vote: true }));
codeBtn.addEventListener("click", async () => {
  if (!net.room) return;
  await navigator.clipboard?.writeText(net.room.roomCode).catch(() => undefined);
  codeBtn.textContent = "copied";
  window.setTimeout(() => paint(), 700);
});

net.onChange = () => paint();
if (net.token && net.name) net.connect(net.name);
else paint();

window.setInterval(() => {
  if (raceScreen.classList.contains("hidden")) return;
  race.sync(net.snap, net.playerId);
  net.drive(race.readDrive(), race.consumeItem());
}, 50);

function paint() {
  const phase = screen();
  connectScreen.classList.toggle("hidden", phase !== "connect");
  menuScreen.classList.toggle("hidden", phase !== "menu");
  roomScreen.classList.toggle("hidden", phase !== "room");
  raceScreen.classList.toggle("hidden", phase !== "race");
  link.textContent = net.status === "online" ? `online · ${net.pingMs} ms` : net.status;
  link.classList.toggle("on", net.status === "online");
  link.classList.toggle("bad", net.status === "offline");
  connectError.textContent = phase === "connect" ? net.error : "";
  menuError.textContent = phase === "menu" ? net.error : "";
  paintModes();
  if (phase === "room" && net.room) paintRoom();
  if (phase === "race") {
    race.ensure();
    race.sync(net.snap, net.playerId);
    paintHud();
  }
}

function screen() {
  if (!net.playerId) return "connect";
  if (net.room?.status === "lobby") return "room";
  if (net.room) return "race";
  if (net.snap && net.snap.status !== "lobby") return "race";
  return "menu";
}

function paintModes() {
  document.querySelectorAll<HTMLButtonElement>("#mode-picker button").forEach((button) => {
    button.classList.toggle("on", button.dataset.mode === mode);
  });
  modeHelp.textContent = mode === "time_attack"
    ? "Solo. Three laps, best single lap hits the leaderboard."
    : "Three laps. One driver can start alone. With two or more, everyone must press Ready.";
  maxLabel.classList.toggle("hidden", mode === "time_attack");
  maxPlayers.classList.toggle("hidden", mode === "time_attack");
  paintTracks();
}

function paintTracks() {
  trackPicker.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.classList.toggle("on", Number(button.dataset.track) === trackId);
  });
}

function paintRoom() {
  const room = net.room;
  if (!room) return;
  const track = TRACKS.find((item) => item.id === room.trackId);
  roomMeta.textContent = `${room.mode === "time_attack" ? "Time Attack" : "Race"} · ${track?.name ?? "Track"} · ${room.players.length}/${room.maxPlayers}`;
  codeBtn.textContent = room.roomCode;
  const mine = room.players.find((player) => player.playerId === net.playerId);
  readyBtn.textContent = mine?.ready ? "Not ready" : "Ready";
  carPicker.querySelectorAll("button").forEach((button, index) => {
    button.classList.toggle("on", CAR_IDS[index] === mine?.carId);
  });
  const waiting = room.mode === "race" && room.players.length === 1
    ? "You are alone. Press Ready to start."
    : "";
  bridgeHint.textContent = [waiting, mine
    ? `Wheel: in bridge/.env set ROOM_CODE=${room.roomCode} and PLAYER_ID=${mine.playerName}, then run python bridge/bridge.py`
    : ""].filter(Boolean).join(" ");
  playerList.replaceChildren(...room.players.map((player) => {
    const li = document.createElement("li");
    if (player.playerId === net.playerId) li.classList.add("me");
    const car = CARS[player.carId].name;
    li.innerHTML = `<span>${escapeHtml(player.playerName)} · ${car}${player.playerId === room.hostId ? " · host" : ""}</span><span>${player.ready ? "ready" : "waiting"} · ${player.totalPoints} pts</span>`;
    return li;
  }));
}

function paintHud() {
  const me = net.snap?.players.find((player) => player.id === net.playerId);
  hudPlace.textContent = me ? `P${me.place}` : "P–";
  hudLap.textContent = me ? (me.finished ? "Finished" : lapLabel(me.lap)) : "Lap 1/3";
  hudSpeed.textContent = me ? String(Math.round(me.speed)) : "0";
  if (!me) hudItem.textContent = "No item";
  else if (me.item) hudItem.textContent = `${me.item.toUpperCase()} · space`;
  else if (me.shield) hudItem.textContent = "Shield up";
  else hudItem.textContent = me.parked ? "Signal lost" : "No item";
  if (net.countdown && net.snap?.status === "countdown") {
    countdownEl.textContent = String(net.countdown);
    countdownEl.classList.remove("hidden");
  } else countdownEl.classList.add("hidden");
  if (net.toast) {
    toastEl.textContent = net.toast;
    toastEl.classList.remove("hidden");
  } else toastEl.classList.add("hidden");
  if (net.results) {
    resultsEl.classList.remove("hidden");
    resultList.replaceChildren(...net.results.map((row) => {
      const li = document.createElement("li");
      const time = row.finished && row.totalTimeMs != null ? formatMs(row.totalTimeMs) : "DNF";
      const best = row.bestLapMs != null ? ` · best ${formatMs(row.bestLapMs)}` : "";
      const bonus = row.fastestLap ? " · fastest lap" : "";
      li.textContent = `P${row.position} ${row.playerName} · ${time}${best} · ${row.points} pts (${row.totalPoints} total)${bonus}`;
      return li;
    }));
    rematchBtn.textContent = net.voted ? "Voted for rematch" : "Rematch";
    rematchBtn.disabled = net.voted;
    const track = net.room?.trackId ?? net.snap?.trackId ?? 0;
    const key = `${track}:${net.results.map((row) => row.playerId).join(",")}`;
    if (boardFor !== key && track) {
      boardFor = key;
      void loadBoard(track);
    }
  } else {
    resultsEl.classList.add("hidden");
    boardFor = "";
  }
}

async function loadBoard(trackIdToLoad: number) {
  try {
    const res = await fetch(`${httpUrl()}/leaderboard?trackId=${trackIdToLoad}`);
    const body = (await res.json()) as { rows?: LeaderboardRow[] };
    const rows = body.rows ?? [];
    boardList.replaceChildren(...(rows.length ? rows.map((row) => {
      const li = document.createElement("li");
      li.textContent = `${row.player_name} · ${formatMs(row.lap_time_ms)}`;
      return li;
    }) : [emptyBoard()]));
  } catch {
    boardList.replaceChildren(emptyBoard("Leaderboard unavailable"));
  }
}

function emptyBoard(text = "No laps yet") {
  const li = document.createElement("li");
  li.textContent = text;
  return li;
}

function formatMs(ms: number) {
  const total = Math.max(0, Math.round(ms));
  const min = Math.floor(total / 60000);
  const sec = Math.floor((total % 60000) / 1000);
  const frac = Math.floor((total % 1000) / 10);
  return `${min}:${String(sec).padStart(2, "0")}.${String(frac).padStart(2, "0")}`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
}

function must(selector: string) {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
}

function mustInput<T extends HTMLElement>(selector: string) {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
}

function mustForm(selector: string) {
  const node = document.querySelector<HTMLFormElement>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
}
