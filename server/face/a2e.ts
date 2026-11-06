// Full-face animation with LAM A2E (Wav2ARKit, an ONNX port of LAM
// Audio2Expression: https://huggingface.co/myned-ai/wav2arkit_cpu, Apache-2.0).
// From the reply's speech it predicts the 52 ARKit face shapes at 30 fps.
// Speech is analysed in 0.5 s chunks, each with 1 s of the audio before it as
// context (~30 ms per chunk on Apple silicon). Each chunk's face frames are
// handed over just before its audio, so the browser can schedule both on the
// same clock. Fixed-size chunks keep playback continuous at any arrival speed.

import fs from "node:fs";
import { config } from "../config.ts";
import type { FaceFrames } from "../../shared/protocol.ts";

const MODEL_RATE = 16000;
const FPS = 30;
const CHUNK_MS = 500;
const CONTEXT_SAMPLES = MODEL_RATE; // 1 s
const SHAPES = 52;

export const faceAvailable = () => fs.existsSync(config.faceModel) && fs.existsSync(`${config.faceModel}.data`);

type Ort = typeof import("onnxruntime-node");
type Loaded = { ort: Ort; session: import("onnxruntime-node").InferenceSession };

// One model session for every call, loaded on first use (~0.4 GB).
let loading: Promise<Loaded> | null = null;
function model(): Promise<Loaded> {
  loading ??= (async () => {
    const mod = await import("onnxruntime-node");
    const ort = ((mod as { default?: Ort }).default ?? mod) as Ort;
    return { ort, session: await ort.InferenceSession.create(config.faceModel) };
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** PCM16 at `rate` to float samples at 16 kHz (linear interpolation). */
function to16k(pcm: Buffer, rate: number) {
  const n = pcm.length / 2;
  const step = rate / MODEL_RATE;
  const out = new Float32Array(Math.floor(n / step));
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const f = x - j;
    const a = pcm.readInt16LE(j * 2);
    const b = j + 1 < n ? pcm.readInt16LE((j + 1) * 2) : a;
    out[i] = (a * (1 - f) + b * f) / 0x8000;
  }
  return out;
}

/** Receives each chunk's face frames (null if analysis failed) and its audio, in order. */
export type FaceSink = (face: FaceFrames | null, audio: Buffer[]) => void;

/** Cuts one call's speech into chunks and predicts the face for each. */
export class FaceChunks {
  readonly #rate: number;
  readonly #sink: FaceSink;
  #queue: Promise<void> = Promise.resolve();
  #generation = 0;
  #context = new Float32Array(0);
  #chunks: Buffer[] = [];
  #bytes = 0;

  constructor(rate: number, sink: FaceSink) {
    this.#rate = rate;
    this.#sink = sink;
    model().catch(() => {}); // start loading now; errors surface as chunks without faces
  }

  /** Resolves once every chunk so far has been handed over. */
  get drained() {
    return this.#queue;
  }

  push(pcm: Buffer) {
    this.#chunks.push(pcm);
    this.#bytes += pcm.length;
    if ((this.#bytes / 2 / this.#rate) * 1000 >= CHUNK_MS) this.#cut();
  }

  /** The reply's speech is complete: analyse what's left; the next reply starts without context. */
  flush() {
    if (this.#chunks.length) this.#cut();
    this.#context = new Float32Array(0);
  }

  /** Interrupted: drop chunks still waiting. */
  reset() {
    this.#generation++;
    this.#context = new Float32Array(0);
    this.#chunks = [];
    this.#bytes = 0;
  }

  #cut() {
    const chunks = this.#chunks;
    const generation = this.#generation;
    const fresh = to16k(Buffer.concat(chunks), this.#rate);
    const context = this.#context;
    const joined = new Float32Array(context.length + fresh.length);
    joined.set(context);
    joined.set(fresh, context.length);
    this.#context = joined.slice(Math.max(0, joined.length - CONTEXT_SAMPLES));
    this.#chunks = [];
    this.#bytes = 0;
    this.#queue = this.#queue.then(async () => {
      if (generation !== this.#generation) return;
      const face = await analyse(joined, context.length, fresh.length).catch(() => null);
      if (generation === this.#generation) this.#sink(face, chunks);
    });
  }
}

/** Face frames for the `freshLength` samples at the end of `audio` (the rest is context). */
async function analyse(audio: Float32Array, contextLength: number, freshLength: number): Promise<FaceFrames> {
  const { ort, session } = await model();
  const out = (await session.run({ audio_waveform: new ort.Tensor("float32", audio, [1, audio.length]) })).blendshapes;
  const data = out.data as Float32Array;
  const skip = Math.round((FPS * contextLength) / MODEL_RATE);
  const n = Math.max(0, Math.min(Math.ceil((FPS * freshLength) / MODEL_RATE), out.dims[1] - skip));
  const values = new Array<number>(n * SHAPES);
  for (let i = 0; i < n * SHAPES; i++) values[i] = Math.round(data[skip * SHAPES + i] * 1000);
  return { fps: FPS, n, values };
}
