// The avatar's feelings: each sentence of a reply gets one of a few emotions,
// which the browser blends into the face while the lips follow the lip sync.
// The reply itself is never changed (tags in Omni's text would be spoken).
// Clear word cues decide first; d1-2B labels the rest, or the everyday model without it.

import { config } from "../config.ts";
import type { Emotion } from "../../shared/protocol.ts";
import type { Brain } from "../models/brain.ts";
import type { Router } from "../models/router.ts";

const CUES: [Emotion, RegExp][] = [
  ["sad", /\b(sorry|unfortunately|sadly|condolences|that's (tough|hard))\b/i],
  ["surprised", /\b(wow|whoa|no way|really\?|incredible)\b/i],
  ["thinking", /^\W*(hmm+|let me (think|see|check)|i'm not sure|good question)\b/i],
  ["happy", /\b(congrat\w*|great|wonderful|awesome|glad|love|fantastic|excellent|yay|perfect|nice to meet|well done)\b/i],
];
const LETTERS: Record<string, Emotion> = { A: "happy", B: "sad", C: "surprised", D: "angry", E: "thinking", F: "neutral" };
const question = (sentence: string) =>
  `Sentence: "${sentence}"\n\nWhich emotion does this sentence express?\nA) happy or warm\nB) sad or sorry\nC) surprised\nD) angry or upset\nE) thinking or unsure\nF) neutral, just information\n\nReply with only the letter.`;
const TIMEOUT_MS = 1500;
const SENTENCE_END = /[.!?…](?=\s|$)|\n/g;

export class Feelings {
  readonly #brain: Brain;
  readonly #router: Router;
  readonly #show: (emotion: Emotion) => void;
  readonly #signal: AbortSignal;
  #last: Emotion = "neutral";
  /** How much of the current reply's text has been labelled. */
  #done = 0;
  #queue: Promise<void> = Promise.resolve();
  #generation = 0;

  constructor(brain: Brain, router: Router, show: (emotion: Emotion) => void, signal: AbortSignal) {
    this.#brain = brain;
    this.#router = router;
    this.#show = show;
    this.#signal = signal;
  }

  /** The feeling of one sentence. Never throws: neutral when unsure. */
  async feel(sentence: string): Promise<Emotion> {
    const text = sentence.trim().slice(0, 400);
    if (!text) return "neutral";
    for (const [emotion, cue] of CUES) if (cue.test(text)) return emotion;
    if (this.#router.available) return (await this.#router.emotion(text)) ?? "neutral";
    // A brain that thinks before answering can't label a sentence in time, and would only slow real answers.
    if (config.brainThinkTokens > 0) return "neutral";
    const answer = await this.#brain.ask([{ role: "user", content: question(text) }], {
      temperature: 0,
      maxTokens: 12,
      signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), this.#signal]),
    });
    const letter = (answer.match(/\b([A-F])\)/) ?? answer.match(/^([A-F])\b/))?.[1];
    return (letter && LETTERS[letter]) || "neutral";
  }

  /** Tells the browser, when the feeling changed. */
  show(emotion: Emotion) {
    if (emotion === this.#last) return;
    this.#last = emotion;
    this.#show(emotion);
  }

  /** A new reply. */
  reset() {
    this.#generation++;
    this.#done = 0;
    this.#queue = Promise.resolve();
  }

  /**
   * For replies whose speech streams with their text: labels each sentence of
   * `text` as it completes (`final`: the rest too) and shows them in order.
   */
  follow(text: string, final: boolean) {
    const rest = text.slice(this.#done);
    let end = final ? rest.length : 0;
    if (!final) for (const m of rest.matchAll(SENTENCE_END)) end = m.index + 1;
    const sentence = rest.slice(0, end).trim();
    this.#done += end;
    if (!sentence) return;
    const generation = this.#generation;
    const feeling = this.feel(sentence);
    this.#queue = this.#queue.then(async () => {
      const emotion = await feeling;
      if (generation === this.#generation) this.show(emotion);
    });
  }
}
