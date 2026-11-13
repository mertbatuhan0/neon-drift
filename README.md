# Neon Drift

An online multiplayer top-down racing game for 2-4 players. Players race neon cars around a futuristic track, collect power-ups and sabotage each other. Every player drives with a **Wokwi-simulated controller** (PSX gamepad or steering wheel), and all players meet on **one public internet server**.

## Team
| Name | Role |
|------|------|
| Batuhan Mert Elma | Game server & networking |
| Muhsin Arsu | Game screen (Web client) |
| Rita Gadlela | Wokwi controllers, bridge & docs |

## Docs
- [Game concept](concept.md)
- [Game events](game_events.md)
- [Tech design](tech_design.md)

## How to run

The Dockerfile starts the game server and serves the game screen on the same port. Browsers and the Wokwi bridge connect there. Steering at 30 Hz stays on the WebSocket. Finished events (`room_joined`, `lap_completed`, `race_ended`, and the rest) are published to the course Redpanda broker when the broker variables below are set. The password is never committed.

**Port:** `8787`, unless `PORT` is set.

**Environment variables**

| Name | Required | Purpose |
|------|----------|---------|
| `PORT` | no | Listen port. Default `8787`. |
| `BROKER_URL` | for events | `https://edp-broker.codewithpeter.com` |
| `BROKER_USER` | for events | `team3` |
| `BROKER_PASSWORD` | for events | Team password from Slack. Set it on the server only. |
| `BROKER_TOPIC` | no | Default `team3.events`. |
| `LEADERBOARD_PATH` | no | SQLite file for best laps. |
| `CLIENT_DIST` | no | Built game screen. The image uses `/app/client/dist`. |

```bash
docker build -t neon-drift .
docker run --rm -p 8787:8787 --env-file .env neon-drift
```

`.env` is the copy of `.env.example` with `BROKER_PASSWORD` filled in. It stays off git. Startup logs `Neon Drift listening on 8787` and `broker on` or `broker off`. `GET /health` returns `{"ok":true}`.

Players open `http://<vps-host>:8787`, one person creates a room, and the others join with the 4-letter code. The bridge on each laptop uses `GAME_SERVER_URL=ws://<vps-host>:8787`.

## Run locally

Wokwi controllers and the serial bridge are a separate piece. This repo runs the game without them: the browser sends the same `set_input` / `use_item` commands the bridge will send later.

```bash
npm install
cp .env.example .env   # optional; put BROKER_PASSWORD here, never commit .env
npm run dev
```

- Game screen: `http://localhost:5173`
- Game server: `ws://localhost:8787`

Press Ready to start. A race with one driver starts as soon as that driver is ready. A race with two or more waits until every driver is ready. Time Attack is solo. Drive with WASD or the arrow keys. Space uses a held boost or EMP. Shield and oil fire on pickup.
Race rooms start when at least two drivers are ready. Time Attack starts with one. Drive with WASD or the arrow keys. Space uses a held boost or EMP. Shield and oil fire on pickups.

## Wheel bridge

The ESP32 wheel lives in `controller/wheel` (Wokwi, serial on port 4000). `bridge/bridge.py` reads that serial port and drives the car.

1. Create or join a room in the browser and leave the tab open.
2. Copy the room code and your driver name into `bridge/.env` (`ROOM_CODE`, `PLAYER_ID`). `PLAYER_ID` is the name you typed, not a separate account.
3. Start the Wokwi simulation, then `pip install -r bridge/requirements.txt` and `python bridge/bridge.py`.

The bridge sends `connect_controller`, `drive_input` and `use_item`. Hits, boosts and the finish line come back as `controller_feedback` and the sketch flashes the LED and buzzes. Keyboard still works until the bridge is connected; after that the wheel owns the pedals.

The server publishes finished events (`room_joined`, `lap_completed`, `race_ended`, …) to the course Redpanda broker when `BROKER_URL`, `BROKER_USER` and `BROKER_PASSWORD` are set. Snapshots and session tokens stay off that topic. Wire format is `game_events.md`.
