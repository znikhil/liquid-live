// Finds where speech starts and stops in the microphone signal (frames are 20 ms):
// 60 ms of speech starts a turn and 800 ms without it ends it. It keeps a short
// pre-roll so the first syllable isn't lost, and adapts to background noise.
//
// A frame counts as speech when it is loud enough AND, with a voice model,
// sounds like a human voice. The model keeps clicks, typing and hums from
// starting turns; loudness keeps the assistant's own voice coming back through
// the speakers (which the model rightly hears as a voice) from interrupting it.

import type { Frame } from "./mic";

export type Utterance = {
  start(preroll: Int16Array[]): void;
  frame(pcm: Int16Array): void;
  end(): void;
};

const PREROLL_FRAMES = 15;
const START_FRAMES = 3;
/** About 0.4 s of louder sound to interrupt a reply (see `push`). */
const INTERRUPT_FRAMES = 20;
const END_FRAMES = 40;
/** Voice model scores (0..1): to start or interrupt a turn, and to keep one going (lower, so pauses between words don't end it). */
const START_VOICE = 0.5;
const KEEP_VOICE = 0.35;

/** Anything that scores how much the audio sounds like a human voice, 0..1 (a VoiceProbe). */
export type VoiceScore = { readonly probability: number };

export class SpeechDetector {
  readonly #on: Utterance;
  #noise = 0.004;
  #loud = 0;
  #quiet = 0;
  #preroll: Int16Array[] = [];
  #speaking = false;
  readonly #voice: VoiceScore | null;

  /** Without `voice`, loudness alone decides (the fallback if the model can't load). */
  constructor(on: Utterance, voice: VoiceScore | null = null) {
    this.#on = on;
    this.#voice = voice;
  }

  #sounds(min: number) {
    return !this.#voice || this.#voice.probability >= min;
  }

  /**
   * `boost` > 1 while the assistant talks: then it takes louder and longer sound
   * to count as you, so its own voice coming back through the mic, a click or a
   * cough doesn't cut it off.
   */
  push({ pcm, rms }: Frame, boost = 1) {
    const threshold = Math.max(0.012, this.#noise * 3) * boost;
    if (this.#speaking) {
      this.#on.frame(pcm);
      this.#quiet = rms > threshold * 0.7 && this.#sounds(KEEP_VOICE) ? 0 : this.#quiet + 1;
      if (this.#quiet >= END_FRAMES) {
        this.#speaking = false;
        this.#loud = 0;
        this.#on.end();
      }
      return;
    }
    const interrupting = boost > 1;
    this.#noise = this.#noise * 0.98 + Math.min(rms, 0.05) * 0.02;
    this.#preroll.push(pcm);
    const keep = interrupting ? PREROLL_FRAMES + INTERRUPT_FRAMES : PREROLL_FRAMES;
    while (this.#preroll.length > keep) this.#preroll.shift();
    // Speech dips between syllables, so while interrupting a quiet frame only takes one back.
    const voiced = rms > threshold && this.#sounds(START_VOICE);
    this.#loud = voiced ? this.#loud + 1 : interrupting ? Math.max(0, this.#loud - 1) : 0;
    if (this.#loud >= (interrupting ? INTERRUPT_FRAMES : START_FRAMES)) {
      this.#speaking = true;
      this.#quiet = 0;
      this.#on.start(this.#preroll);
      this.#preroll = [];
    }
  }
}
