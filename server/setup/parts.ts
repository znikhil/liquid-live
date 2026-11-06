// What the app needs on disk, where each part comes from, and how to tell
// whether it's there. Shared by `npm run setup` and the server.

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";

export type Size = "small" | "balanced" | "best";

/** Model quants for each size. Bigger is sharper but slower and uses more memory. */
export const SIZES: Record<Size, { omni: string; brain: string; label: string }> = {
  small: { omni: "Q4_0", brain: "QAD-Q4_0", label: "Smallest" },
  balanced: { omni: "Q4_K_M", brain: "Q4_K_M", label: "Balanced (recommended)" },
  best: { omni: "Q8_0", brain: "Q8_0", label: "Best" },
};
export const isSize = (s: unknown): s is Size => typeof s === "string" && s in SIZES;

const hf = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}?download=true`;
const OMNI_REPO = "LiquidAI/LFM3-Omni-2B-GGUF";
const BRAIN_REPO = "LiquidAI/LFM3-1.7B-GGUF";
const FACE_REPO = "myned-ai/wav2arkit_cpu";
const WOOF_REPO = "ConwayResearch/Underdog-Woof";

export const PREFIX = { omni: "LFM3-Omni-2B-", projector: "mmproj-LFM3-Omni-2B-", brain: "LFM3-1.7B-" } as const;
/** The projector (Omni's ears and eyes) is small, so it always comes in its best quant. */
const PROJECTOR = `${PREFIX.projector}Q8_0.gguf`;

export type FileDownload = { url: string; dest: string };

export type Part = {
  id: "engine" | "omni" | "brain" | "router" | "asr" | "woof" | "face";
  title: string;
  /** Files to download for `size`; the engine is resolved from GitHub instead. */
  files(size: Size): FileDownload[];
  /** A .tar.bz2 to download and unpack into `into`, for parts published that way. */
  archive?: { url: string; into: string };
  installed(): boolean;
  /** False when this setup doesn't use the part, so it isn't downloaded (default: needed). */
  needed?(): boolean;
};

const model = (name: string) => path.join(config.modelDir, name);
const hasGguf = (prefix: string) => {
  try {
    return fs.readdirSync(config.modelDir).some((f) => f.startsWith(prefix) && f.endsWith(".gguf"));
  } catch {
    return false;
  }
};

export const PARTS: Part[] = [
  {
    id: "engine",
    title: "llama.cpp engine",
    files: () => [],
    installed: () => findFile(config.engineDir, "llama-server") !== null,
  },
  {
    id: "omni",
    title: "LFM3 Omni 2B (voice, hearing, sight)",
    files: (size) => [
      { url: hf(OMNI_REPO, PROJECTOR), dest: model(PROJECTOR) },
      { url: hf(OMNI_REPO, `${PREFIX.omni}${SIZES[size].omni}.gguf`), dest: model(`${PREFIX.omni}${SIZES[size].omni}.gguf`) },
    ],
    installed: () => hasGguf(PREFIX.omni) && hasGguf(PREFIX.projector),
    // Never loaded unless LIVE_OMNI=1.
    needed: () => config.omniEnabled,
  },
  {
    id: "brain",
    title: "LFM3 1.7B (tutor, smart answers)",
    files: (size) => [{ url: hf(BRAIN_REPO, `${PREFIX.brain}${SIZES[size].brain}.gguf`), dest: model(`${PREFIX.brain}${SIZES[size].brain}.gguf`) }],
    installed: () => hasGguf(PREFIX.brain),
    // Not needed when the brain runs elsewhere (LIVE_BRAIN_URL, e.g. Qwen in LM Studio).
    needed: () => config.brainLocal,
  },
  {
    id: "router",
    title: "d1-2B (decision model: routes each request)",
    files: () => [{ url: hf("LiquidAI/d1-2B-GGUF", "d1-2B-Q8_0.gguf"), dest: model("d1-2B-Q8_0.gguf") }],
    installed: () => hasGguf("d1-2B-"),
  },
  {
    id: "asr",
    title: "Parakeet TDT 0.6B (speech recognition)",
    files: () => [],
    archive: {
      url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${path.basename(config.asrModel)}.tar.bz2`,
      into: path.dirname(config.asrModel),
    },
    installed: () => ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"].every((f) => fs.existsSync(path.join(config.asrModel, f))),
  },
  {
    id: "woof",
    title: "Underdog Woof (the voice, needs Python with numpy)",
    files: () =>
      [
        "woof_int8.npz", "LICENSE", "NOTICE",
        ...["__init__.py", "normalize.py", "respell.py", "respell.tsv", "runtime.py", "textsplit.py"].map((f) => `underdog_woof/${f}`),
      ].map((f) => ({ url: hf(WOOF_REPO, f), dest: path.join(config.woofDir, f) })),
    installed: () => fs.existsSync(path.join(config.woofDir, "woof_int8.npz")) && fs.existsSync(path.join(config.woofDir, "underdog_woof", "runtime.py")),
  },
  {
    id: "face",
    title: "LAM A2E (lip sync for the photo-real heads)",
    files: () =>
      ["wav2arkit_cpu.onnx", "wav2arkit_cpu.onnx.data"].map((f) => ({ url: hf(FACE_REPO, f), dest: path.join(path.dirname(config.faceModel), f) })),
    installed: () => fs.existsSync(config.faceModel) && fs.existsSync(`${config.faceModel}.data`),
  },
];

/** Searches `dir` and its subfolders for a file called `name`. */
export function findFile(dir: string, name: string): string | null {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === name) return full;
    }
  }
  return null;
}
