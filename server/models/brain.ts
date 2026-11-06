// The brain: the model that writes what Aria says (LFM3 1.7B by default; any
// OpenAI-style server via LIVE_BRAIN_URL / LIVE_BRAIN_MODEL, e.g. Qwen 3.5 in
// LM Studio). It answers from the transcript, which suits spotting grammar
// slips, staying on topic and working things out. Its text is then spoken in
// the call's voice.

import { config } from "../config.ts";
import { stream, type ChatMessage } from "./llm.ts";
import { modelName, modelURL, type ModelRuntime } from "./runtime.ts";

const reported = new Set<string>();

export type BrainOptions = { signal?: AbortSignal; temperature?: number; maxTokens?: number };

/** What the model is sent: a history that starts with the user, and for models that think unless told not to, an empty thinking block. */
function prompt(messages: ChatMessage[]): ChatMessage[] {
  // Some chat templates (Qwen 3.5) refuse a history that starts with the assistant, as a
  // call does after Aria's greeting: a short user line goes first.
  const firstTalk = messages.findIndex((m) => m.role !== "system");
  const startsWithUser: ChatMessage[] =
    firstTalk < 0 || messages[firstTalk].role === "user"
      ? messages
      : [...messages.slice(0, firstTalk), { role: "user", content: "(The call started.)" }, ...messages.slice(firstTalk)];
  // An empty thinking block to start the reply makes such models (Qwen 3.5) answer at once.
  return config.brainNoThink ? [...startsWithUser, { role: "assistant", content: "<think>\n\n</think>\n\n" }] : startsWithUser;
}

/** Said once per kind of failure, so a broken setup shows in the log without flooding it. */
function report(e: unknown, signal?: AbortSignal) {
  const message = e instanceof Error ? e.message : String(e);
  if (signal?.aborted || reported.has(message)) return;
  reported.add(message);
  console.log(`  Brain failed: ${message}`);
}

export class Brain {
  readonly #runtime: ModelRuntime;

  constructor(runtime: ModelRuntime) {
    this.#runtime = runtime;
  }

  get available() {
    return this.#runtime.isUp("brain");
  }

  /** The reply's text as it is written, without any thinking. Ends quietly on failure. */
  async *stream(messages: ChatMessage[], { signal, temperature = 0.4, maxTokens = 160 }: BrainOptions = {}) {
    if (!this.available) return;
    let thinking = false;
    try {
      const parts = stream({ url: modelURL("brain"), model: modelName("brain"), temperature, maxTokens: maxTokens + config.brainThinkTokens, signal, messages: prompt(messages) });
      for await (const part of parts) {
        // Thinking some models still write into the reply is never passed on.
        if (part.includes("<think>")) thinking = true;
        if (thinking) {
          if (part.includes("</think>")) thinking = false;
          continue;
        }
        yield part;
      }
    } catch (e) {
      report(e, signal);
    }
  }

  /** The whole completion, or "" when the model is down or fails. */
  async ask(messages: ChatMessage[], options?: BrainOptions) {
    let out = "";
    for await (const part of this.stream(messages, options)) out += part;
    return out.replace(/^[\s\S]*<\/think>/, "").replace(/<\/?think>/g, "").trim();
  }

  /** A reply made fit to be spoken: no markdown, on one line. */
  async say(messages: ChatMessage[], options?: BrainOptions) {
    return spoken(await this.ask(messages, options));
  }
}

/** Plain words for speech: drops markdown and joins lines. */
export const spoken = (text: string) => text.replace(/[*_`#]+/g, "").replace(/\s+/g, " ").trim();
