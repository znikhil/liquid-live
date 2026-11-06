// Voice activity detection with Silero VAD (https://github.com/snakers4/silero-vad,
// MIT), a ~2 MB model that tells human speech from other sounds. Loudness alone
// started a turn on a click, a cough, typing or a fan; Silero scores those near
// 0 and speech near 1 (measured: keyboard 0.02, hum 0.39, speech 1.00). It runs
// on the call's 16 kHz frames in 32 ms chunks, about a millisecond each.

import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";

const MODEL_URL = "/models/silero_vad.onnx";
const RATE = 16000;
/** Silero v5 reads 512 samples at 16 kHz, with the 64 samples before them as context. */
const CHUNK = 512;
const CONTEXT = 64;

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
// Threads need cross-origin isolation, which this page doesn't have; one is plenty for this model.
ort.env.wasm.numThreads = 1;

export class VoiceProbe {
  readonly #session: ort.InferenceSession;
  readonly #sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(RATE)]), []);
  #state: ort.Tensor = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  #context = new Float32Array(CONTEXT);
  #buffer = new Float32Array(CHUNK);
  #filled = 0;
  /** Chunks run one after another: each needs the state the one before it left. */
  #queue: Promise<void> = Promise.resolve();
  /** Speech probability of the newest chunk, 0..1. */
  probability = 0;

  private constructor(session: ort.InferenceSession) {
    this.#session = session;
  }

  /** Loads the model; the call's input must be 16 kHz. */
  static async load(rate: number) {
    if (rate !== RATE) throw new Error(`Silero VAD needs 16 kHz audio, not ${rate} Hz.`);
    return new VoiceProbe(await ort.InferenceSession.create(MODEL_URL));
  }

  /** Feeds a frame of microphone audio; `probability` updates once a chunk is full. */
  push(pcm: Int16Array) {
    for (let i = 0; i < pcm.length; i++) {
      this.#buffer[this.#filled++] = pcm[i] / 0x8000;
      if (this.#filled === CHUNK) {
        const chunk = this.#buffer;
        this.#buffer = new Float32Array(CHUNK);
        this.#filled = 0;
        this.#queue = this.#queue.then(() => this.#run(chunk)).catch(() => {});
      }
    }
  }

  async #run(chunk: Float32Array) {
    const input = new Float32Array(CONTEXT + CHUNK);
    input.set(this.#context);
    input.set(chunk, CONTEXT);
    this.#context = input.slice(-CONTEXT);
    const out = await this.#session.run({ input: new ort.Tensor("float32", input, [1, input.length]), state: this.#state, sr: this.#sr });
    this.#state = out.stateN;
    this.probability = (out.output.data as Float32Array)[0];
  }

  close() {
    void this.#session.release().catch(() => {});
  }
}
