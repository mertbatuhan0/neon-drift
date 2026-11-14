import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { trackById } from "@neon/shared";
import { consumerBase, openBrokerConsumer } from "./broker-consumer.js";
import { lapFromBroker } from "./consume.js";
import { closeStore, recordLap, topLaps } from "./store.js";

const track = trackById(1);
if (!track) throw new Error("missing track");
const legal = Math.ceil((track.length / 520) * 1000) + 1000;

test("a lap event becomes a leaderboard row, and a cut lap does not", () => {
  const stored = lapFromBroker({
    type: "lap_completed",
    player: "Ada",
    data: { playerName: "Ada", lap: 2, lapTimeMs: legal, trackId: 1, mode: "time_attack" },
  });
  assert.equal(stored?.player, "Ada");
  assert.equal(stored?.trackId, 1);
  assert.equal(stored?.mode, "time_attack");
  assert.equal(stored?.lap, 2);
  assert.equal(lapFromBroker({
    type: "lap_completed",
    player: "Ada",
    data: { lapTimeMs: 50, trackId: 1, mode: "race", lap: 1 },
  }), null);
  assert.equal(lapFromBroker({ type: "room_joined", player: "Ada", data: {} }), null);
  assert.equal(lapFromBroker({
    type: "lap_completed",
    player: "Ada",
    data: { lapTimeMs: legal, lap: 1, mode: "race" },
  }), null);
  const fromContext = lapFromBroker({
    type: "lap_completed",
    player: "Ada",
    data: { playerName: "Ada", lap: 1, lapTimeMs: legal },
  }, { trackId: 1, mode: "time_attack" });
  assert.equal(fromContext?.trackId, 1);
  assert.equal(fromContext?.mode, "time_attack");
});

test("the proxy's internal consumer address is rewritten to the public broker", () => {
  assert.equal(
    consumerBase(
      "https://edp-broker.codewithpeter.com",
      "http://edp-redpanda:8082/consumers/team3.leaderboard/instances/leaderboard",
    ),
    "https://edp-broker.codewithpeter.com/consumers/team3.leaderboard/instances/leaderboard",
  );
});

test("the same lap from the broker is stored once", () => {
  closeStore();
  process.env.LEADERBOARD_PATH = path.join(mkdtempSync(path.join(tmpdir(), "neon-board-")), "board.sqlite");
  try {
    assert.equal(recordLap("Ada", 1, legal, "race", 1), true);
    assert.equal(recordLap("Ada", 1, legal, "race", 1), false);
    assert.equal(topLaps(1, 10).length, 1);
  } finally {
    closeStore();
  }
});

test("the consumer subscribes and returns event values", async () => {
  const calls: string[] = [];
  const responses = [
    { status: 200, body: "" },
    { status: 500, body: "{\"error_code\":50003}" },
    { status: 200, body: "" },
    { status: 200, body: JSON.stringify({ base_uri: "http://edp-redpanda:8082/consumers/team3.leaderboard/instances/leaderboard" }) },
    { status: 200, body: "" },
    { status: 200, body: JSON.stringify([{ value: { type: "lap_completed", player: "Ada" } }]) },
  ];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method || "GET"} ${url}`);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected ${url}`);
    return new Response(next.body, { status: next.status });
  };
  const consumer = await openBrokerConsumer({
    baseUrl: "https://broker.test",
    user: "team3",
    password: "secret",
    group: "team3.leaderboard",
    topic: "team3.events",
    fetchImpl,
  });
  const values = await consumer.poll();
  assert.equal((values[0] as { player: string }).player, "Ada");
  assert.ok(calls.some((line) => line.startsWith("DELETE ")));
  assert.ok(calls.some((line) => line.startsWith("GET https://broker.test/consumers/")));
  assert.ok(calls.some((line) => line.includes("/subscription")));
  await consumer.close();
});
