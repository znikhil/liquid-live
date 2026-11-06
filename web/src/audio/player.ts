// Plays streamed PCM16 speech without gaps, and stops instantly when the user
// talks over it. Avatars wrap it to move the face in time with the audio.

import type { FaceFrames } from "../../../shared/protocol";

/** What the call plays its replies through: the plain Player, or an avatar's. */
export interface Speaker {
  push(bytes: ArrayBuffer): void;
  readonly playing: boolean;
  flush(): void;
  close(): void;
  resume(): Promise<void>;
  /** Face frames for the chunk of speech pushed next (LAM heads). */
  face?(face: FaceFrames): void;
}

export class Player implements Speaker {
  readonly #rate: number;
  readonly #ctx = new AudioContext();
  readonly #sources = new Set<AudioBufferSourceNode>();
  #next = 0;

  constructor(rate: number) {
    this.#rate = rate;
  }

  resume() {
    return this.#ctx.resume();
  }

  /** Queues the chunk right after the previous one; returns when it starts, on `time`'s clock. */
  push(bytes: ArrayBuffer): number {
    const pcm = new Int16Array(bytes);
    if (!pcm.length) return this.#next;
    const buffer = this.#ctx.createBuffer(1, pcm.length, this.#rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 0x8000;
    const source = this.#ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#ctx.destination);
    const at = Math.max(this.#ctx.currentTime + 0.04, this.#next);
    source.start(at);
    this.#next = at + buffer.duration;
    this.#sources.add(source);
    source.onended = () => this.#sources.delete(source);
    return at;
  }

  /** The playback clock, in seconds. */
  get time() {
    return this.#ctx.currentTime;
  }

  get playing() {
    return this.#ctx.currentTime < this.#next - 0.02;
  }

  flush() {
    for (const s of this.#sources) {
      try {
        s.stop();
      } catch {}
    }
    this.#sources.clear();
    this.#next = 0;
  }

  close() {
    this.flush();
    this.#ctx.close().catch(() => {});
  }
}
