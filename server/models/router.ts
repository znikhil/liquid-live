// d1-2B, Liquid's decision model (https://huggingface.co/LiquidAI/d1-2B): it
// answers named questions about a sentence in one pass, with probabilities and
// without writing text (~0.1 s on an M5). It decides where each request goes,
// replacing word lists that missed requests worded in a new way ("how is the
// review of…" was never searched). Measured on 24 spoken requests: the intent
// was right for all 24. Its own yes/no "needs the web?" was wrong on 3, so the
// intent alone decides whether to search.

import { isLocal } from "../config.ts";
import type { Emotion } from "../../shared/protocol.ts";
import { modelURL, type ModelRuntime } from "./runtime.ts";

export type Intent = "small_talk" | "knowledge" | "math_time" | "current" | "camera";
export type Decision = { intent: Intent; confidence: number };

const INTENT = {
  type: "choice",
  instructions: "What kind of request did the user just say to the voice assistant?",
  criteria: {
    small_talk: "Greetings, thanks, how are you, or questions about the assistant itself",
    knowledge: "Explaining, advice, history, science, definitions or how-to that general knowledge answers",
    math_time: "Arithmetic, numbers, the current time, today's date or counting days",
    current: "Anything that changes over time: news, reviews, ratings, box office, sports results, prices, weather, trends",
    camera: "Asks what the assistant can see, or about something the user is showing or holding",
  },
};

const EMOTION = {
  type: "choice",
  instructions: "Which feeling does this sentence, spoken by a friendly assistant, express?",
  criteria: {
    neutral: "Plain information, no particular feeling",
    happy: "Happy, warm, glad or encouraging",
    sad: "Sorry, sad or sympathetic",
    surprised: "Surprised or amazed",
    angry: "Angry or upset",
    thinking: "Thinking it over, unsure or considering",
  },
};

const TIMEOUT_MS = 2000;
const CACHE_SIZE = 50;

export class Router {
  readonly #runtime: ModelRuntime;
  /** Recent decisions by sentence: the session and the mode both ask about the same words. */
  readonly #cache = new Map<string, Promise<Decision | null>>();

  constructor(runtime: ModelRuntime) {
    this.#runtime = runtime;
  }

  get available() {
    return this.#runtime.isUp("router");
  }

  /** Where `text` should go, or null when d1 isn't running (the callers fall back to word lists). */
  decide(text: string): Promise<Decision | null> {
    const key = text.trim().toLowerCase();
    if (!key || !this.available) return Promise.resolve(null);
    let decision = this.#cache.get(key);
    if (!decision) {
      decision = this.#ask(text, { intent: INTENT })
        .then((a) => (a ? { intent: a.intent.choice as Intent, confidence: a.intent.confidence } : null))
        .catch(() => null);
      this.#cache.set(key, decision);
      if (this.#cache.size > CACHE_SIZE) this.#cache.delete(this.#cache.keys().next().value!);
    }
    return decision;
  }

  /** The feeling of a sentence the assistant says, or null when d1 isn't running. */
  async emotion(sentence: string): Promise<Emotion | null> {
    if (!this.available) return null;
    const a = await this.#ask(sentence, { emotion: EMOTION }).catch(() => null);
    return (a?.emotion.choice as Emotion) ?? null;
  }

  async #ask(state: string, questions: Record<string, object>): Promise<Record<string, { choice: string; confidence: number }> | null> {
    const url = modelURL("router");
    if (!isLocal(url)) throw new Error("Refusing a model address that isn't on this computer.");
    const res = await fetch(`${url}/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()).answers ?? null;
  }
}
