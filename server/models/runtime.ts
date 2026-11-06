// Keeps the llama.cpp model servers available: Omni, the everyday brain and the
// d1 decision model (the brain can also live on another server, e.g. LM Studio).
// Omni is loaded on demand (LIVE_OMNI_ON_DEMAND, the default): only while a call
// needs it (its voice, or the camera) and unloaded a minute after the last one. A server already answering
// at its URL is used as is; otherwise one is started from the engine and models
// that `npm run setup` downloaded. The check repeats in the background, so a
// model set up while the app runs starts on its own. Only servers started here
// are stopped on exit.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { findFile, PREFIX } from "../setup/parts.ts";

export type ModelId = "omni" | "brain" | "router";

type ModelSpec = {
  url: string;
  alias: string;
  /** File name prefix of the weights in the model folder. */
  weights: string;
  /** Omni's audio and vision projector. */
  projector?: string;
  /** Context size and parallel slots (default: 32768 tokens over 2 slots). */
  context?: number;
  slots?: number;
  /** More llama-server arguments. */
  args?: string[];
  /** Only loaded while something needs it (see need/release). */
  onDemand?: boolean;
  /** Never started or used (LIVE_OMNI turned off). */
  disabled?: boolean;
};

const SPECS: Record<ModelId, ModelSpec> = {
  omni: { url: config.omniURL, alias: "LFM3-Omni-2B", weights: PREFIX.omni, projector: PREFIX.projector, onDemand: config.omniOnDemand, disabled: !config.omniEnabled },
  brain: { url: config.brainURL, alias: config.brainModel, weights: `${config.brainModel}-` },
  // d1 reads a whole question in one batch, so the batch must hold the sentence and its questions.
  router: { url: config.routerURL, alias: "d1-2B", weights: "d1-2B-", context: 8192, slots: 1, args: ["-b", "8192", "-ub", "8192"] },
};
/** Bigger quants first: the best one on disk is used. */
const QUANT_ORDER = ["F16", "Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "Q4_0", "QAD-Q4_0"];
const HEALTH_EVERY_MS = 5000;
const START_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 3000;
/** A model that was up only counts as down after this many failed checks in a row. */
const DOWN_AFTER_FAILURES = 2;
/** An on-demand model nobody has needed for this long is unloaded. */
const IDLE_UNLOAD_MS = 60_000;

export const MODEL_IDS = Object.keys(SPECS) as ModelId[];
export const modelName = (id: ModelId) => SPECS[id].alias;
export const modelURL = (id: ModelId) => SPECS[id].url;

const healthURL = (url: string) => `${new URL(url).origin}/health`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** llama.cpp answers /health; other OpenAI-style servers (LM Studio) answer /v1/models. */
async function healthy(url: string) {
  for (const probe of [healthURL(url), `${url}/models`]) {
    try {
      // A server busy writing a reply (LM Studio) can take a moment to answer.
      if ((await fetch(probe, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })).ok) return true;
    } catch {}
  }
  return false;
}

/** The best quant on disk whose name starts with `prefix`. */
function bestGguf(prefix: string): string | null {
  let files: string[] = [];
  try {
    files = fs.readdirSync(config.modelDir).filter((f) => f.startsWith(prefix) && f.endsWith(".gguf"));
  } catch {
    return null;
  }
  const rank = (f: string) => {
    const i = QUANT_ORDER.indexOf(f.slice(prefix.length, -".gguf".length));
    return i < 0 ? QUANT_ORDER.length : i;
  };
  const best = files.sort((a, b) => rank(a) - rank(b))[0];
  return best ? path.join(config.modelDir, best) : null;
}

function command(spec: ModelSpec) {
  const cmd = findFile(config.engineDir, "llama-server");
  const weights = bestGguf(spec.weights);
  const projector = spec.projector ? bestGguf(spec.projector) : null;
  if (!cmd || !weights || (spec.projector && !projector)) return null;
  const port = new URL(spec.url).port;
  // Two slots by default: Omni holds a call on one while it transcribes, speaks and looks on the other.
  const args = ["--host", "127.0.0.1", "--port", port, "-c", String(spec.context ?? 32768), "-np", String(spec.slots ?? 2), "--jinja", "-ngl", "99", "-m", weights, "--alias", spec.alias];
  if (projector) args.push("--mmproj", projector);
  if (spec.args) args.push(...spec.args);
  return { cmd, args, weights };
}

export class ModelRuntime {
  readonly #up = new Map<ModelId, boolean>();
  readonly #owned = new Map<ModelId, ChildProcess>();
  readonly #starting = new Set<ModelId>();
  /** Models already reported as not set up, so the log says it once. */
  readonly #reported = new Set<ModelId>();
  /** Models that failed to start; they aren't retried until the app restarts. */
  readonly #failed = new Set<ModelId>();
  #timer: NodeJS.Timeout | undefined;
  /** How many calls need each on-demand model right now, and its pending unload. */
  readonly #users = new Map<ModelId, number>();
  readonly #idle = new Map<ModelId, NodeJS.Timeout>();
  readonly #misses = new Map<ModelId, number>();

  /** Whether the model answered its last health check. */
  isUp(id: ModelId) {
    return this.#up.get(id) ?? false;
  }

  /** Whether the model can run here: answering already, or its files are on disk. */
  available(id: ModelId) {
    if (SPECS[id].disabled) return false;
    return this.isUp(id) || command(SPECS[id]) !== null;
  }

  async start() {
    await Promise.all(MODEL_IDS.map((id) => this.#ensure(id)));
    this.#timer = setInterval(() => MODEL_IDS.forEach((id) => void this.#ensure(id)), HEALTH_EVERY_MS);
    this.#timer.unref();
  }

  /** Loads an on-demand model if it isn't up (a few seconds), and keeps it while needed. Resolves to whether it's up. */
  async need(id: ModelId) {
    if (SPECS[id].disabled) return false;
    this.#users.set(id, (this.#users.get(id) ?? 0) + 1);
    clearTimeout(this.#idle.get(id));
    this.#idle.delete(id);
    this.#failed.delete(id); // asked for again: worth another try
    await this.#ensure(id);
    while (this.#starting.has(id)) await sleep(200);
    return this.isUp(id);
  }

  /** The caller no longer needs the model; once nobody does for a minute, an on-demand model it started is unloaded. */
  release(id: ModelId) {
    const users = Math.max(0, (this.#users.get(id) ?? 0) - 1);
    this.#users.set(id, users);
    if (users > 0 || !SPECS[id].onDemand || !this.#owned.has(id)) return;
    clearTimeout(this.#idle.get(id));
    this.#idle.set(
      id,
      setTimeout(() => {
        this.#idle.delete(id);
        const child = this.#owned.get(id);
        if ((this.#users.get(id) ?? 0) > 0 || !child) return;
        this.#owned.delete(id);
        this.#up.set(id, false);
        child.kill("SIGTERM");
        console.log(`  ${SPECS[id].alias}: unloaded (not needed)`);
      }, IDLE_UNLOAD_MS),
    );
  }

  stop() {
    clearInterval(this.#timer);
    for (const timer of this.#idle.values()) clearTimeout(timer);
    for (const child of this.#owned.values()) child.kill("SIGTERM");
    this.#owned.clear();
  }

  async #ensure(id: ModelId) {
    if (this.#starting.has(id)) return;
    const spec = SPECS[id];
    if (spec.disabled) return void this.#up.set(id, false);
    if (await healthy(spec.url)) {
      this.#misses.set(id, 0);
      return void this.#up.set(id, true);
    }
    // One slow answer from a busy server isn't a failure; a server we stopped is down at once.
    const misses = (this.#misses.get(id) ?? 0) + 1;
    this.#misses.set(id, misses);
    if (this.isUp(id) && misses < DOWN_AFTER_FAILURES && !this.#owned.has(id)) return;
    this.#up.set(id, false);
    if (!config.launchModels || this.#owned.has(id) || this.#failed.has(id)) return;
    // An on-demand model is only started while a call needs it.
    if (spec.onDemand && !((this.#users.get(id) ?? 0) > 0)) return;
    const launch = command(spec);
    if (!launch) {
      if (!this.#reported.has(id)) console.log(`  ${spec.alias}: not set up yet. Run: npm run setup`);
      this.#reported.add(id);
      return;
    }
    this.#starting.add(id);
    try {
      await this.#launch(id, launch);
    } finally {
      this.#starting.delete(id);
    }
  }

  async #launch(id: ModelId, launch: { cmd: string; args: string[]; weights: string }) {
    const spec = SPECS[id];
    console.log(`  ${spec.alias}: starting ${path.basename(launch.weights)}…`);
    fs.mkdirSync(config.logDir, { recursive: true });
    const logFile = path.join(config.logDir, `${id}.log`);
    const log = fs.openSync(logFile, "w");
    const child = spawn(launch.cmd, launch.args, { stdio: ["ignore", log, log] });
    fs.closeSync(log);
    this.#owned.set(id, child);
    let exited = false;
    child.on("exit", () => {
      exited = true;
      if (this.#owned.get(id) === child) this.#owned.delete(id);
      this.#up.set(id, false);
    });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!exited && Date.now() < deadline) {
      if (await healthy(spec.url)) {
        this.#up.set(id, true);
        return console.log(`  ${spec.alias}: ready`);
      }
      await sleep(500);
    }
    if (!exited) child.kill("SIGTERM");
    this.#failed.add(id);
    console.log(`  ${spec.alias}: didn't start (see ${logFile})`);
  }
}
