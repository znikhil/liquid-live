// Microphone capture: 20 ms PCM16 frames at the call's input rate, each with its
// loudness. Resampling happens in an audio worklet (public/capture-worklet.js).

export type Frame = { pcm: Int16Array; rms: number };

export class Mic {
  readonly #rate: number;
  readonly #onFrame: (frame: Frame) => void;
  #ctx: AudioContext | null = null;
  #stream: MediaStream | null = null;
  #node: AudioWorkletNode | null = null;
  muted = false;

  constructor(rate: number, onFrame: (frame: Frame) => void) {
    this.#rate = rate;
    this.#onFrame = onFrame;
  }

  async start() {
    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.#ctx = new AudioContext();
    await this.#ctx.audioWorklet.addModule("/capture-worklet.js");
    const source = this.#ctx.createMediaStreamSource(this.#stream);
    this.#node = new AudioWorkletNode(this.#ctx, "capture", { processorOptions: { rate: this.#rate } });
    this.#node.port.onmessage = (e) => {
      if (!this.muted) this.#onFrame({ pcm: new Int16Array(e.data.pcm), rms: e.data.rms });
    };
    source.connect(this.#node);
  }

  stop() {
    this.#node?.disconnect();
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#ctx?.close().catch(() => {});
    this.#ctx = null;
    this.#stream = null;
    this.#node = null;
  }
}
