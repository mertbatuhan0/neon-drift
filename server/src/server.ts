import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { trackById } from "@neon/shared";
import { handleSocket, resetState, tick } from "./hub.js";
import { closeStore, topLaps } from "./store.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function clientRoot() {
  const root = process.env.CLIENT_DIST
    ? path.resolve(process.env.CLIENT_DIST)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
  return existsSync(path.join(root, "index.html")) ? root : null;
}

function insideRoot(root: string, target: string) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function handleHttp(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/leaderboard") {
    const trackId = Number(url.searchParams.get("trackId") || "1");
    if (!trackById(trackId)) {
      sendJson(res, 400, { error: "Unknown track" });
      return;
    }
    sendJson(res, 200, { trackId, rows: topLaps(trackId, 10) });
    return;
  }
  if (serveClient(req, res)) return;
  sendJson(res, 404, { error: "Not found" });
}

function serveClient(req: IncomingMessage, res: ServerResponse) {
  const root = clientRoot();
  if (!root) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const raw = (req.url || "/").split("?")[0] || "/";
  let pathname: string;
  try {
    pathname = decodeURIComponent(raw);
  } catch {
    sendJson(res, 400, { error: "Bad path" });
    return true;
  }
  if (pathname.includes("\0") || pathname.split("/").includes("..")) {
    sendJson(res, 400, { error: "Bad path" });
    return true;
  }
  const target = path.resolve(root, `.${pathname}`);
  if (!insideRoot(root, target)) {
    sendJson(res, 400, { error: "Bad path" });
    return true;
  }
  if (existsSync(target) && statSync(target).isFile()) {
    sendFile(req, res, target);
    return true;
  }
  if (path.extname(pathname)) {
    sendJson(res, 404, { error: "Not found" });
    return true;
  }
  sendFile(req, res, path.join(root, "index.html"));
  return true;
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string) {
  const ext = path.extname(file);
  res.writeHead(200, {
    "Content-Type": TYPES[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

export async function startServer(port = Number(process.env.PORT) || 8787) {
  const http = createServer(handleHttp);
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => handleSocket(ws));
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    tick(dt, now);
  }, 1000 / 30);

  await new Promise<void>((resolve) => {
    http.listen(port, "0.0.0.0", () => resolve());
  });
  const address = http.address();
  const actual = typeof address === "object" && address ? address.port : port;
  const broker = Boolean(process.env.BROKER_PASSWORD && process.env.BROKER_URL);
  const topic = process.env.BROKER_TOPIC || "team3.events";
  console.log(`Neon Drift listening on ${actual}`);
  console.log(clientRoot() ? "game screen on /" : "game screen not built (WebSocket only)");
  console.log(`broker ${broker ? "on" : "off"}${broker ? ` topic ${topic}` : ""}`);

  return {
    port: actual,
    async close() {
      clearInterval(timer);
      for (const client of wss.clients) client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      resetState();
      closeStore();
    },
  };
}
