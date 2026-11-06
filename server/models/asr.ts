// Speech recognition: what the user said, as text. Everything in a call is
// routed from these words, so they matter more than anything else.
//
// NVIDIA Parakeet TDT 0.6B v2 (int8, CC-BY-4.0) through sherpa-onnx, on the CPU:
// ~140 ms for a 4 s sentence, against ~1.5 s for Omni's own transcription, and
// it doesn't compete with Omni and the everyday model for the GPU. Omni's
// transcription remains the fallback when the model isn't downloaded.

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { toWav } from "../wav.ts";
import { transcribe as omniTranscribe } from "./omni.ts";

const RATE = 16000;
const FILES = { encoder: "encoder.int8.onnx", decoder: "decoder.int8.onnx", joiner: "joiner.int8.onnx", tokens: "tokens.txt" };
const file = (name: string) => path.join(config.asrModel, name);

export const parakeetAvailable = () => Object.values(FILES).every((f) => fs.existsSync(file(f)));

type Recognizer = {
  createStream(): { acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void };
  decodeAsync(stream: unknown): Promise<{ text: string }>;
};

// One recognizer for every call, loaded on first use (~1 s, ~0.7 GB).
let loading: Promise<Recognizer> | null = null;
function recognizer(): Promise<Recognizer> {
  loading ??= (async () => {
    const { OfflineRecognizer } = (await import("sherpa-onnx-node")).default;
    return OfflineRecognizer.createAsync({
      featConfig: { sampleRate: RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: file(FILES.encoder), decoder: file(FILES.decoder), joiner: file(FILES.joiner) },
        tokens: file(FILES.tokens),
        modelType: "nemo_transducer",
        numThreads: 4,
        provider: "cpu",
      },
    });
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** Starts loading the model now, so the first sentence of a call doesn't wait for it. */
export function warmUp() {
  if (parakeetAvailable()) recognizer().catch(() => {});
}

/** PCM16 mono at `rate` to float samples at 16 kHz. */
function samples16k(pcm: Buffer, rate: number) {
  const n = pcm.length / 2;
  const step = rate / RATE;
  const out = new Float32Array(Math.floor(n / step));
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const a = pcm.readInt16LE(j * 2);
    const b = j + 1 < n ? pcm.readInt16LE((j + 1) * 2) : a;
    out[i] = (a + (b - a) * (x - j)) / 0x8000;
  }
  return out;
}

/** The words in an utterance (PCM16 mono at `rate`). Parakeet when it's downloaded, else Omni. */
export async function transcribe(pcm: Buffer, rate: number, { signal }: { signal?: AbortSignal } = {}) {
  if (!parakeetAvailable()) return omniTranscribe(toWav(pcm, rate), { signal });
  const rec = await recognizer();
  const stream = rec.createStream();
  stream.acceptWaveform({ samples: samples16k(pcm, rate), sampleRate: RATE });
  return (await rec.decodeAsync(stream)).text.trim();
}
