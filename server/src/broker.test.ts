import assert from "node:assert/strict";
import test from "node:test";
import type { ServerMessage } from "@neon/shared";
import { brokerRecords, publishBlockReason, publishEvent, resetBrokerForTests, toBrokerValue } from "./broker.js";

test("broker payload keeps the event type and drops session tokens", () => {
  const hidden: ServerMessage = {
    kind: "event",
    type: "session_opened",
    ts: 10,
    data: { playerId: "p1", token: "secret" },
  };
  assert.equal(toBrokerValue(hidden), null);

  const joined: ServerMessage = {
    kind: "event",
    type: "room_joined",
    ts: 20,
    data: { playerId: "p1", playerName: "Ada", roomCode: "ABCD", token: "nope" },
  };
  const value = toBrokerValue(joined);
  assert.equal(value?.type, "room_joined");
  assert.equal(value?.player, "Ada");
  const data = value?.data as Record<string, unknown>;
  assert.equal(data.token, undefined);
  assert.equal(data.roomCode, "ABCD");
});

test("snapshots are not published", () => {
  const snap: ServerMessage = { kind: "snapshot", type: "state_snapshot", ts: 1, data: { players: [] } };
  assert.equal(toBrokerValue(snap), null);
});

test("a missing password is reported instead of dropped quietly", () => {
  assert.equal(publishBlockReason({ BROKER_URL: "https://broker.test" }), "BROKER_PASSWORD is not set");
  assert.equal(publishBlockReason({}), "BROKER_URL is not set");
  resetBrokerForTests();
  const previous = process.env.BROKER_PASSWORD;
  const previousUrl = process.env.BROKER_URL;
  process.env.BROKER_URL = "https://broker.test";
  delete process.env.BROKER_PASSWORD;
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (message?: unknown) => {
    lines.push(String(message));
  };
  try {
    publishEvent({
      kind: "event",
      type: "room_joined",
      ts: 1,
      data: { playerName: "Ada" },
    });
  } finally {
    console.warn = warn;
    if (previous === undefined) delete process.env.BROKER_PASSWORD;
    else process.env.BROKER_PASSWORD = previous;
    if (previousUrl === undefined) delete process.env.BROKER_URL;
    else process.env.BROKER_URL = previousUrl;
  }
  assert.match(lines.join("\n"), /BROKER_PASSWORD/);
});

test("a publish body can carry more than one event", () => {
  const body = brokerRecords([{ type: "room_joined" }, { type: "lap_completed" }]);
  assert.equal(body.records.length, 2);
  assert.equal(body.records[1].value.type, "lap_completed");
});
