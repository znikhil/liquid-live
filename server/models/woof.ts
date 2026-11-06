// Underdog Woof text-to-speech (~40 MB, CPU, numpy only), the alternative to
// Omni's own voice. It runs in a small Python helper (server/woof/woof_server.py)
// started here when its files and Python with numpy are present. Juno is the
// default voice; Mira sometimes didn't stop, so the helper redoes or drops
// takes that run far too long.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.ts";

export const WOOF_VOICES = ["juno", "mira"] as const;
export type WoofVoice = (typeof WOOF_VOICES)[number];
export const isWoofVoice = (v: unknown): v is WoofVoice => typeof v === "string" && (WOOF_VOICES as readonly string[]).includes(v);

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "woof", "woof_server.py");
const URL_BASE = `http://127.0.0.1:${config.woofPort}`;
const START_TIMEOUT_MS = 30_000;

export const woofInstalled = () => fs.existsSync(path.join(config.woofDir, "woof_int8.npz")) && fs.existsSync(path.join(config.woofDir, "underdog_woof", "runtime.py"));

async function healthy() {
  try {
    return (await fetch(`${URL_BASE}/health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

class WoofService {
  #child: ChildProcess | null = null;
  #up = false;

  get available() {
    return this.#up;
  }

  /** Starts the helper if Woof is downloaded; resolves once it answers (or gives up quietly). */
  async start() {
    if (!woofInstalled()) return;
    if (await healthy()) {
      this.#up = true;
      return;
    }
    fs.mkdirSync(config.logDir, { recursive: true });
    const log = fs.openSync(path.join(config.logDir, "woof.log"), "w");
    // -I: isolated mode, so nothing next to the script or in the working folder is imported by accident.
    const child = spawn(config.python, ["-I", SCRIPT, "--model", config.woofDir, "--port", String(config.woofPort)], { stdio: ["ignore", log, log] });
    fs.closeSync(log);
    this.#child = child;
    let exited = false;
    child.on("error", () => (exited = true));
    child.on("exit", () => {
      exited = true;
      this.#up = false;
      if (this.#child === child) this.#child = null;
    });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!exited && Date.now() < deadline) {
      if (await healthy()) {
        this.#up = true;
        return console.log("  Underdog Woof: ready");
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log(`  Underdog Woof: didn't start (see ${config.logDir}/woof.log; it needs ${config.python} with numpy)`);
  }

  stop() {
    this.#child?.kill("SIGTERM");
    this.#child = null;
  }

  /** A 24 kHz mono WAV of `text`, or null when Woof made no usable take or isn't running. */
  async speak(text: string, voice: WoofVoice, { signal }: { signal?: AbortSignal } = {}) {
    if (!this.#up) return null;
    const res = await fetch(`${URL_BASE}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
      signal,
    });
    if (res.status !== 200) return null;
    return Buffer.from(await res.arrayBuffer());
  }
}

export const woof = new WoofService();
