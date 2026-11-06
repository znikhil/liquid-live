// The user's camera during a call. Omni won't reliably ask to look, so while
// the camera is on, its second slot keeps a fresh description of the view. The
// description is given to Omni only when the user's words are about seeing:
// handed the view on every turn, Omni talked about it even when not asked.
// With the camera off, a note saying so is added only when the user clearly asks
// it to look: told in its instructions to "say the camera is off", Omni said it
// in reply to "Thank you".

import { config } from "../config.ts";
import { look } from "../models/omni.ts";

const ABOUT_SEEING =
  /\b(see|seeing|saw|look|looking|looks|watch|show|showing|camera|visible|wear|wearing|holding|hold|hand|hands|colou?rs?|read|picture|photo|image|room|behind|in front|face|shirt|hair|glasses|this|these|that one)\b/i;
/** Clearly asking to be looked at; narrower than ABOUT_SEEING, which also fires on "this" or "hand". */
const ASKS_TO_LOOK = /\b(can you see|do you see|what do you see|look at|camera|what am i (holding|wearing|showing)|how do i look)\b/i;
const PROMPT =
  "Describe what this camera shows in two or three short, plain sentences: the people, what they are holding or doing, the main objects and any readable text. Only say what is clearly visible; never guess.";

/** What Omni is told about the camera in its instructions (they can't change mid-call). */
export const CAMERA_INSTRUCTIONS =
  "Notes in brackets may tell you about the user's camera. Only talk about the camera when such a note is there, using only what it says and never inventing anything; never bring up the camera yourself.";

export class Camera {
  readonly #busy: () => boolean;
  readonly #signal: AbortSignal;
  readonly #timer: NodeJS.Timeout;
  /** Only the newest picture is kept. */
  #frame: { jpeg: Buffer; at: number } | null = null;
  #scene: { text: string; at: number } | null = null;
  #describing = false;

  /** `busy`: the call is answering, so describing would slow the reply down. */
  constructor(busy: () => boolean, signal: AbortSignal) {
    this.#busy = busy;
    this.#signal = signal;
    this.#timer = setInterval(() => this.#describe(), config.call.sceneEveryMs);
  }

  get on() {
    return this.#frame !== null;
  }

  /** A base64 JPEG from the browser; anything else is ignored. */
  setFrame(base64: unknown) {
    if (typeof base64 !== "string" || base64.length > config.call.maxFrameBytes) return;
    const jpeg = Buffer.from(base64, "base64");
    if (jpeg[0] === 0xff && jpeg[1] === 0xd8) this.#frame = { jpeg, at: Date.now() };
  }

  off() {
    this.#frame = null;
    this.#scene = null;
  }

  /** Whether `words` ask about what the camera shows. */
  /** `aboutCamera`: the d1 router's verdict, when it has one; otherwise word lists decide. */
  asksAbout(words: string, aboutCamera?: boolean) {
    return this.on && (aboutCamera ?? ABOUT_SEEING.test(words));
  }

  /** The note for Omni when `words` ask about the view (or ask to look while the camera is off), else null. */
  noteFor(words: string, aboutCamera?: boolean) {
    if (!this.on) return (aboutCamera ?? ASKS_TO_LOOK.test(words)) ? "The user's camera is off, so you can't see anything. Say so briefly." : null;
    if (!this.asksAbout(words, aboutCamera)) return null;
    return this.#scene ? `Camera view right now (only for questions about what you see): ${this.#scene.text}` : "The camera is on, but you can't see anything yet.";
  }

  stop() {
    clearInterval(this.#timer);
  }

  async #describe() {
    const shot = this.#frame;
    if (this.#describing || this.#busy() || !shot || (this.#scene && this.#scene.at >= shot.at)) return;
    this.#describing = true;
    try {
      const text = (await look(shot.jpeg, PROMPT, { signal: this.#signal })).trim();
      if (this.#frame && text) this.#scene = { text, at: shot.at };
    } catch {
    } finally {
      this.#describing = false;
    }
  }
}
