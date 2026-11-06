// Every setting in one place, from environment variables with sensible defaults.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const HOME = os.homedir();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir =
  env.LIVE_HOME ??
  (process.platform === "darwin"
    ? path.join(HOME, "Library", "Application Support", "SamvadAI")
    : path.join(env.XDG_DATA_HOME ?? path.join(HOME, ".local", "share"), "samvad-ai"));
const modelDir = path.join(dataDir, "models");

export const config = {
  host: "127.0.0.1",
  port: Number(env.LIVE_PORT ?? 8190),
  webDir: path.join(ROOT, "web", "dist"),
  /** Downloaded engine and models, logs and tutor notes (`npm run setup` fills it). */
  dataDir,
  engineDir: path.join(dataDir, "engine"),
  modelDir,
  logDir: path.join(dataDir, "logs"),

  /** LFM3 Omni 2B: realtime voice, transcription, speech and vision. */
  omniURL: env.LIVE_OMNI_URL ?? "http://127.0.0.1:8181/v1",
  /**
   * Load Omni only while a call needs it (the Omni voice, or the camera), so with
   * Woof as the voice and the brain answering, it takes no memory. "0" keeps it loaded.
   */
  omniOnDemand: env.LIVE_OMNI_ON_DEMAND !== "0",
  /**
   * Use Omni at all. Off by default: Qwen answers, Woof speaks and Parakeet hears, so
   * nothing needs it, and the Omni voice, the camera and Omni's transcription are
   * turned off. LIVE_OMNI=1 brings them back (Omni then loads on demand).
   */
  omniEnabled: env.LIVE_OMNI === "1",
  /** The brain: tutor replies and answers. LFM3 1.7B on llama.cpp unless LIVE_BRAIN_URL points at another server (e.g. LM Studio). */
  brainURL: env.LIVE_BRAIN_URL ?? "http://127.0.0.1:8180/v1",
  /** The brain is LFM3 1.7B, downloaded by setup and started here (no LIVE_BRAIN_URL). */
  brainLocal: env.LIVE_BRAIN_URL === undefined,
  /**
   * Which everyday model runs there: the start of its GGUF file name in the model folder,
   * or the model's name on another OpenAI-style server (e.g. LM Studio: "twil-8b-mlx").
   */
  brainModel: env.LIVE_BRAIN_MODEL ?? "LFM3-1.7B",
  /**
   * Extra tokens allowed on every brain request for models that always think before
   * answering, so their thinking doesn't use up the answer's budget (0 for models that don't).
   */
  brainThinkTokens: Number(env.LIVE_BRAIN_THINK_TOKENS ?? 0),
  /**
   * For models that think unless told otherwise and have no switch for it (Qwen 3.5 in LM Studio):
   * every brain reply starts with an empty thinking block, so the model answers at once.
   */
  brainNoThink: env.LIVE_BRAIN_NO_THINK === "1",
  /** d1-2B, Liquid's decision model: routes each request (search? small talk? camera?) in ~0.1 s. */
  routerURL: env.LIVE_ROUTER_URL ?? "http://127.0.0.1:8183/v1",
  /** Start llama-server for a model that isn't already running. */
  launchModels: env.LIVE_LAUNCH_MODELS !== "0",
  /** Tavily API key for live news in the Assistant (optional; set it in .env). */
  tavilyKey: env.TAVILY_API_KEY?.trim() ?? "",
  /** Parakeet TDT 0.6B v2: speech recognition (sherpa-onnx, int8). */
  asrModel: path.join(modelDir, "asr", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"),
  /** Underdog Woof text-to-speech: its folder, the port of its helper, and the Python that runs it. */
  woofDir: path.join(modelDir, "woof"),
  woofPort: Number(env.LIVE_WOOF_PORT ?? 8768),
  python: env.LIVE_PYTHON ?? "python3",
  /** LAM A2E (Wav2ARKit): speech to 52 face shapes for the photo-real heads. */
  faceModel: path.join(modelDir, "wav2arkit", "wav2arkit_cpu.onnx"),


  call: {
    maxReplySeconds: 45,
    /** How long a spoken turn waits for its transcript when the route depends on the words. */
    transcriptWaitMs: 2500,
    /** How often the camera view is described while the camera is on. */
    sceneEveryMs: 4000,
    maxFrameBytes: 1_500_000,
  },
} as const;

export function isLocal(url: string) {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}
