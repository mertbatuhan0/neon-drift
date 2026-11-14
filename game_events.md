# Game Commands & Events
 
Transport: WebSocket over TLS (`wss://`) to the online server. All messages are JSON.
 
## Naming rules
- **Command** (client → server): something a player *asks for*. Imperative name: `join_room`, `use_item`. The server may accept or reject it.
- **Event** (server → clients): something that *has happened*. Past-tense name: `room_joined`, `item_used`. Events are facts and are never rejected.
- Every command gets exactly one outcome: the matching event(s), or `command_rejected`.
- Exceptions: `ping`/`pong` (heartbeat) and `*_snapshot` messages (periodic state) do not follow the naming rule.
### Message envelopes
```json
// Command
{ "kind": "command", "type": "join_room", "cmdId": "c-42", "ts": 1731500000000, "data": { "roomCode": "ABCD" } }
 
// Event
{ "kind": "event", "type": "room_joined", "ts": 1731500000050, "causedBy": "c-42", "data": { "playerId": "p1", "roomCode": "ABCD" } }
```
`causedBy` links an event to the command that triggered it (absent for server-originated events such as `countdown_ticked`).
 
---
 
# Commands (client / controller / bridge → server)
 
## Session & lobby
| Command | Payload | Description | Resulting event(s) |
|---------|---------|-------------|--------------------|
| `connect` | `{ playerName, token? }` | Open a session; token allows rejoin | `session_opened` or `player_reconnected` |
| `create_room` | `{ trackId, maxPlayers }` | Create a room | `room_created`, `room_joined` |
| `join_room` | `{ roomCode }` | Join an existing room | `room_joined` |
| `leave_room` | `{}` | Leave lobby or race | `room_left` |
| `select_car` | `{ carId }` | Pick a car | `car_selected` |
| `set_ready` | `{ ready }` | Mark self ready or not | `ready_changed` |
| `vote_rematch` | `{ vote }` | Vote for a rematch after a race | `rematch_vote_cast` |
 
## Controller & driving
| Command | Payload | Description | Resulting event(s) |
|---------|---------|-------------|--------------------|
| `attach_controller` | `{ deviceType: "psx"\|"wheel", roomCode, playerName }` | Bridge links a Wokwi controller to a player | `controller_attached` |
| `set_input` | `{ seq, steer: -1..1, throttle: 0..1, brake: 0..1 }` | Current driving input; 30 Hz, only on change (+ 5 Hz heartbeat) | none (reflected in `state_snapshot`) |
| `use_item` | `{ seq }` | Activate held power-up | `item_used`, or `command_rejected` if no item held |
 
## Protocol
| Command | Payload | Description | Resulting message |
|---------|---------|-------------|-------------------|
| `ping` | `{ ts }` | Latency measurement | `pong` |
 
---
 
# Events (server → clients)
 
## Session & lobby
| Event | Payload | Description |
|-------|---------|-------------|
| `session_opened` | `{ playerId, token }` | Session accepted |
| `room_created` | `{ roomCode, trackId, maxPlayers }` | A room now exists |
| `room_joined` | `{ playerId, playerName, roomCode }` | A player entered the room (sent to the whole room) |
| `room_left` | `{ playerId, reason: "left"\|"kicked"\|"timeout" }` | A player left the room |
| `car_selected` | `{ playerId, carId }` | A player picked a car |
| `ready_changed` | `{ playerId, ready }` | A player's ready state changed |
| `room_state_updated` | `{ players[], trackId, status }` | Full lobby state after any change (for late joiners and resync) |
| `controller_attached` | `{ playerId, deviceType }` | A controller is now linked to the player |
| `rematch_vote_cast` | `{ playerId, vote }` | A player voted on a rematch |
| `command_rejected` | `{ command, cmdId, code, message }` | Command refused: ROOM_FULL, ROOM_NOT_FOUND, NOT_IN_ROOM, NO_ITEM, ... |
 
## Race lifecycle
| Event | Payload | Description |
|-------|---------|-------------|
| `countdown_ticked` | `{ secondsLeft }` | 3-2-1 |
| `race_started` | `{ startTs }` | Driving enabled |
| `checkpoint_passed` | `{ playerId, checkpointId, lap }` | Validated by server |
| `lap_completed` | `{ playerId, playerName, lap, lapTimeMs, trackId, mode }` | A finished lap. The leaderboard consumer stores plausible times. |
| `player_finished` | `{ playerId, position, totalTimeMs }` | |
| `race_ended` | `{ results[] }` | Final standings and points |
 
## World
| Event | Payload | Description |
|-------|---------|-------------|
| `item_spawned` | `{ itemId, type, x, y }` | A pickup appeared on the track |
| `item_picked_up` | `{ itemId, playerId, type }` | A player collected a pickup |
| `item_used` | `{ playerId, type, targetId? }` | A player activated a power-up |
| `car_hit` | `{ playerId, source, effect, durationMs }` | A car was slowed, spun, etc. |
| `haptic_triggered` | `{ playerId, pattern: "hit"\|"boost"\|"finish" }` | Buzzer / LED pattern played on that player's controller |
| `player_disconnected` | `{ playerId }` | Connection lost |
| `player_reconnected` | `{ playerId }` | Player came back with their token |
 

# Example flow
```
C→S  command  connect          { playerName: "Ala" }
S→C  event    session_opened   { playerId: "p1", token: "..." }
C→S  command  create_room      { trackId: 1, maxPlayers: 4 }
S→C  event    room_created     { roomCode: "ABCD", ... }
S→C  event    room_joined      { playerId: "p1", roomCode: "ABCD" }
C→S  command  set_ready        { ready: true }
S→C  event    ready_changed    { playerId: "p1", ready: true }
S→C  event    countdown_ticked { secondsLeft: 3 }  ...
S→C  event    race_started     { startTs: ... }
C→S  command  set_input        { seq: 1, steer: -0.4, throttle: 1, brake: 0 }
C→S  command  use_item         { seq: 2 }          (no item held)
S→C  event    command_rejected { command: "use_item", code: "NO_ITEM" }
```
 
