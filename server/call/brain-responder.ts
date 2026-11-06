// The brain as a call's Responder, so a call needs no Omni loaded: the brain
// answers the transcript in text (Parakeet hears, a text-to-speech voice such
// as Woof speaks). It speaks the same events as Omni's realtime session, so the
// call handles both alike.

import type { ChatMessage } from "../models/llm.ts";
import type { Brain } from "../models/brain.ts";
import type { Line } from "../modes/mode.ts";
import type { RealtimeHandlers, Responder, SessionConfig } from "./realtime.ts";

/** The rates the call's audio runs at (the browser's mic, and Woof's 24 kHz speech). */
const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
/** Turns of the conversation the brain reads before each reply. */
const HISTORY_LINES = 12;
const MAX_TOKENS = 200;

export class BrainResponder implements Responder {
  readonly #brain: Brain;
  readonly #history: () => Line[];
  readonly #on: RealtimeHandlers;
  #instructions = "";
  /** What the user said, and notes for the brain, since the last reply. */
  #pending: string[] = [];
  /** The user's audio came without words (recognition failed): there is nothing to answer. */
  #unheard = false;
  #responding = false;
  #queued = false;
  #controller: AbortController | null = null;

  /** `history`: the call's transcript before the current turn. */
  constructor(brain: Brain, history: () => Line[], handlers: RealtimeHandlers) {
    this.#brain = brain;
    this.#history = history;
    this.#on = handlers;
    setTimeout(() => this.#on.event({ type: "session.created", session: { audio: { input: { format: { rate: INPUT_RATE } }, output: { format: { rate: OUTPUT_RATE } } } } }));
  }

  get responding() {
    return this.#responding;
  }

  configure(session: SessionConfig) {
    this.#instructions = session.instructions;
  }

  // The brain reads words, not audio: the call hands it the transcript instead.
  appendAudio() {}

  commitAudio() {
    this.#unheard = true;
  }

  clearAudio() {
    this.#unheard = false;
  }

  addUserText(text: string) {
    this.#pending.push(text);
  }

  // The transcript already holds every exchange.
  noteExchange() {}

  respond() {
    if (this.#responding) {
      this.#queued = true;
      return;
    }
    this.#responding = true;
    this.#on.responseStarted();
    void this.#reply();
  }

  cancel() {
    this.#queued = false;
    this.#controller?.abort();
  }

  settle() {
    this.#responding = false;
    if (!this.#queued) return false;
    this.#queued = false;
    this.respond();
    return true;
  }

  close() {
    this.#controller?.abort();
  }

  async #reply() {
    const controller = new AbortController();
    this.#controller = controller;
    const said = this.#pending.join("\n");
    const unheard = this.#unheard && !said;
    this.#pending = [];
    this.#unheard = false;
    let written = "";
    if (unheard) {
      written = "Sorry, I didn't catch that. Could you say it again?";
      this.#on.event({ type: "response.output_text.delta", delta: written });
    } else {
      const messages: ChatMessage[] = [
        { role: "system", content: this.#instructions },
        ...this.#history()
          .slice(-HISTORY_LINES)
          .map((l): ChatMessage => ({ role: l.role, content: l.text.slice(0, 600) })),
        { role: "user", content: said || "(The user said nothing you could hear.)" },
      ];
      for await (const part of this.#brain.stream(messages, { signal: controller.signal, maxTokens: MAX_TOKENS })) {
        written += part;
        this.#on.event({ type: "response.output_text.delta", delta: part });
      }
      if (!written && !controller.signal.aborted) this.#on.event({ type: "error", error: { message: "The brain didn't answer. Is LM Studio running with the model loaded?" } });
    }
    if (this.#controller === controller) this.#controller = null;
    this.#on.event({ type: "response.done", response: { status: controller.signal.aborted ? "cancelled" : "completed" } });
  }
}
