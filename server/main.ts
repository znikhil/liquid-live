// Samvad AI's server: serves the web app on 127.0.0.1, answers /api/status
// and /api/speak, and runs one CallSession per /call WebSocket.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { config } from "./config.ts";
import type { Status } from "../shared/protocol.ts";
import { CallSession } from "./call/session.ts";
import { faceAvailable } from "./face/a2e.ts";
import { parakeetAvailable, warmUp } from "./models/asr.ts";
import { woof, woofInstalled } from "./models/woof.ts";
import { Brain } from "./models/brain.ts";
import { Router } from "./models/router.ts";
import { speak } from "./models/omni.ts";
import { ModelRuntime } from "./models/runtime.ts";
import { MODES } from "./modes/index.ts";
import { newsAvailable } from "./news.ts";

const { host, port, webDir } = config;
/** Changes every launch; the page gets it in a meta tag, so other websites can't use the API. */
const TOKEN = crypto.randomBytes(24).toString("hex");
const HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`));
const CSP = [
  "default-src 'self'",
  // The avatar renderer compiles WebAssembly ('wasm-unsafe-eval' allows that, not JS eval)
  // and reads its textures and workers from blob: URLs.
  "script-src 'self' 'wasm-unsafe-eval'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "connect-src 'self' blob: data: ws://127.0.0.1:* ws://localhost:*",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
].join("; ");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
};

const runtime = new ModelRuntime();
const brain = new Brain(runtime);
const router = new Router(runtime);

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Blocks other websites (and DNS rebinding) from talking to this server. */
function trusted(req: http.IncomingMessage, url: URL, needToken: boolean) {
  if (!HOSTS.has(req.headers.host ?? "")) return false;
  const origin = req.headers.origin;
  if (origin && !ORIGINS.has(origin)) return false;
  if (!needToken) return true;
  const token = req.headers["x-live-token"] ?? url.searchParams.get("t");
  return typeof token === "string" && token.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN));
}

function sendJson(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readJson(req: http.IncomingMessage, limit = 100_000) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new HttpError(413, "Too big.");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "Bad JSON.");
  }
}

async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (req.method === "GET" && url.pathname === "/api/status") {
    const status: Status = { setupNeeded: config.omniEnabled ? !runtime.available("omni") : !parakeetAvailable() || !woofInstalled(), omni: runtime.available("omni"), omniLoaded: runtime.isUp("omni"), brain: brain.available, brainName: config.brainModel, face: faceAvailable(), news: newsAvailable(), woof: woof.available, router: router.available, modes: MODES.map((m) => m.info) };
    return sendJson(res, 200, status);
  }
  // Scripted calls read the user's lines aloud in the other voice.
  if (req.method === "POST" && url.pathname === "/api/speak") {
    const { text, voice } = await readJson(req);
    if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Nothing to say.");
    // With Omni turned off, Woof reads the line: Mira where a male voice was asked for, so it differs from Juno (Aria).
    if (!config.omniEnabled) {
      const wav = await woof.speak(text.slice(0, 1200), voice === "male" ? "mira" : "juno");
      if (!wav) throw new HttpError(503, "Underdog Woof couldn't read the line.");
      res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store" });
      return res.end(wav);
    }
    // Omni's TTS reads the lines (male or female); it is loaded for this if it isn't already.
    if (!(await runtime.need("omni"))) {
      runtime.release("omni");
      throw new HttpError(503, "LFM3 Omni 2B couldn't start to read the line.");
    }
    let wav: Buffer;
    try {
      wav = await speak(text.slice(0, 1200), voice === "male" ? "male" : "female");
    } finally {
      runtime.release("omni");
    }
    res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store" });
    return res.end(wav);
  }
  throw new HttpError(404, "Not found.");
}

function serveStatic(res: http.ServerResponse, url: URL) {
  let file = path.normalize(path.join(webDir, decodeURIComponent(url.pathname)));
  if (!file.startsWith(webDir)) return sendJson(res, 403, { error: "Forbidden." });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webDir, "index.html");
  if (!fs.existsSync(file)) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    return res.end("The web app isn't built yet. Run: npm run build");
  }
  const ext = path.extname(file);
  const headers = { "Content-Type": TYPES[ext] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  if (ext === ".html") {
    const html = fs.readFileSync(file, "utf8").replace("</head>", `<meta name="live-token" content="${TOKEN}"></head>`);
    res.writeHead(200, { ...headers, "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": CSP });
    return res.end(html);
  }
  res.writeHead(200, { ...headers, "Cache-Control": url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  if (url.pathname === "/healthz") return sendJson(res, 200, { app: "samvad-ai" });
  const isApi = url.pathname.startsWith("/api/");
  if (!trusted(req, url, isApi)) return sendJson(res, isApi ? 401 : 403, { error: "Not allowed." });
  try {
    if (isApi) await api(req, res, url);
    else serveStatic(res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    const status = e instanceof HttpError ? e.status : 500;
    sendJson(res, status, { error: e instanceof Error ? e.message.slice(0, 300) : String(e) });
  }
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  if (url.pathname !== "/call" || !req.headers.origin || !trusted(req, url, true)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  sockets.handleUpgrade(req, socket, head, (ws) => new CallSession(ws, { runtime, brain, router }));
});

function openBrowser() {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [`http://127.0.0.1:${port}`], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(`Port ${port} is in use. Set LIVE_PORT to use another one.`);
  process.exit(1);
});

server.listen(port, host, async () => {
  console.log(`Samvad AI is running at http://127.0.0.1:${port}`);
  console.log("Models:");
  await runtime.start();
  warmUp();
  await woof.start();
  if (process.argv.includes("--open")) openBrowser();
});

function shutdown() {
  runtime.stop();
  woof.stop();
  server.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => {
  runtime.stop();
  woof.stop();
});
