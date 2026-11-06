// The reply's speech on its way to the browser.
//
// SpeechOut: every piece of speech goes through here. It caps a reply's length,
// reports when speaking starts and, for LAM heads, holds each chunk until its
// face frames are ready so they arrive together.
//
// SentenceSpeaker: for replies that come as text and are spoken sentence by
// sentence by a text-to-speech voice: Underdog Woof, or Omni's TTS for a male
// voice (Omni's realtime voice is always female in this llama.cpp build).
// Speech requests start as soon as a sentence is complete; their audio is
// handed over in order.

import { config } from "../config.ts";
import type { Emotion, FaceFrames, ServerMessage } from "../../shared/protocol.ts";
import { FaceChunks } from "../face/a2e.ts";
import type { Feelings } from "../face/emotion.ts";
import { pcmOf } from "../wav.ts";

export type ClientLink = { json(message: ServerMessage): void; binary(pcm: Buffer): void };

export class SpeechOut {
  readonly #rate: number;
  readonly #link: ClientLink;
  readonly #face: FaceChunks | null;
  readonly #started: () => void;
  readonly #overflow: () => void;
  #bytes = 0;

  constructor(rate: number, link: ClientLink, { face, started, overflow }: { face: boolean; started(): void; overflow(): void }) {
    this.#rate = rate;
    this.#link = link;
    this.#started = started;
    this.#overflow = overflow;
    this.#face = face ? new FaceChunks(rate, (frames, audio) => this.#forward(frames, audio)) : null;
  }

  /** A new reply starts. */
  begin() {
    this.#bytes = 0;
  }

  push(pcm: Buffer) {
    if (!pcm.length) return;
    this.#bytes += pcm.length;
    if (this.#bytes > this.#rate * 2 * config.call.maxReplySeconds) return this.#overflow();
    if (this.#bytes === pcm.length) this.#started();
    if (this.#face) this.#face.push(pcm);
    else this.#link.binary(pcm);
  }

  /** The reply's speech is complete. */
  flush() {
    this.#face?.flush();
  }

  /** Interrupted: drop what hasn't gone out. */
  reset() {
    this.#face?.reset();
  }

  /** Resolves once all speech so far has been handed to the browser. */
  get drained(): Promise<void> {
    return this.#face?.drained ?? Promise.resolve();
  }

  #forward(frames: FaceFrames | null, audio: Buffer[]) {
    if (frames?.n) this.#link.json({ type: "face", ...frames });
    for (const chunk of audio) this.#link.binary(chunk);
  }
}

const SENTENCE_END = /[.!?…](?=\s|$)|\n/g;

/** Speaks one sentence: a WAV, or null when it couldn't. */
export type SayFn = (text: string, signal: AbortSignal) => Promise<Buffer | null>;

export class SentenceSpeaker {
  readonly #say: SayFn;
  readonly #out: SpeechOut;
  readonly #feelings: Feelings | null;
  readonly #signal: AbortSignal;
  #chain: Promise<void> = Promise.resolve();
  #generation = 0;
  /** How much of the current reply's text has been queued. */
  #queued = 0;

  constructor(say: SayFn, out: SpeechOut, feelings: Feelings | null, signal: AbortSignal) {
    this.#say = say;
    this.#out = out;
    this.#feelings = feelings;
    this.#signal = signal;
  }

  /** A new reply's text starts (sentences still queued from the last one keep playing). */
  restart() {
    this.#queued = 0;
  }

  /** Interrupted: drop everything queued. */
  interrupt() {
    this.#generation++;
    this.#queued = 0;
    this.#chain = Promise.resolve();
  }

  /**
   * Queues the finished sentences of a reply that is still being written
   * (`final`: the reply is complete, queue the rest too). Long sentences are
   * cut at a comma, and the first clause goes out early, so speech starts sooner.
   * Resolves once everything queued so far has been handed over.
   */
  follow(text: string, final: boolean) {
    const rest = text.slice(this.#queued);
    let end = final ? rest.length : 0;
    if (!final) {
      for (const m of rest.matchAll(SENTENCE_END)) end = m.index + 1;
      const opening = this.#queued === 0 ? rest.search(/[,;:](?=\s)/) : -1;
      if (!end && opening > 0 && rest.slice(0, opening).trim().split(/\s+/).length >= 4) end = opening + 1;
      if (!end && rest.length > 160) end = rest.lastIndexOf(",", 160) + 1;
    }
    this.#queued += end;
    this.#enqueue(rest.slice(0, end));
    return this.#chain;
  }

  /** Speaks a whole reply; every sentence is requested at once. */
  speakAll(text: string) {
    this.restart();
    for (const sentence of text.match(/[^.!?…]+[.!?…]*["')\]]*\s*/g) ?? [text]) this.#enqueue(sentence);
    return this.#chain;
  }

  #enqueue(sentence: string) {
    const text = sentence.trim();
    if (!text) return;
    const generation = this.#generation;
    const audio = this.#say(text, this.#signal).catch(() => null);
    const feeling: Promise<Emotion> | undefined = this.#feelings?.feel(text);
    this.#chain = this.#chain.then(async () => {
      const wav = await audio;
      if (!wav || generation !== this.#generation) return;
      // The feeling goes out just before its sentence's speech.
      if (feeling) this.#feelings!.show(await feeling);
      this.#out.push(pcmOf(wav));
    });
  }
}
