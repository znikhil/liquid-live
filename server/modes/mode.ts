// A mode is one use case of a call (assistant, English tutor).
// Omni always does the listening and speaking; a mode decides who writes the
// replies: Omni straight from the audio (fastest), or the everyday model from
// the transcript (better at corrections and working things out).

import type { ModeInfo } from "../../shared/protocol.ts";
import type { Brain } from "../models/brain.ts";
import type { Router } from "../models/router.ts";

/** One line of the call's transcript. */
export type Line = { role: "user" | "assistant"; text: string };

export type ModeContext = {
  /** What the assistant is called. */
  name: string;
  brain: Brain;
  /** d1-2B decides where requests go; its answers are null when it isn't running. */
  router: Router;
  /** Live web search is allowed in this call (switched on, and a Tavily key is set). */
  search: boolean;
  signal: AbortSignal;
};

/** A mode for the length of one call. */
export interface CallMode {
  /** Omni's system instructions. They can't change mid-call. */
  readonly instructions: string;
  /** Whether `answer` may take turns, so a spoken turn waits for its transcript. */
  readonly answers: boolean;
  /** The first line, when the assistant opens the call. */
  opener?(): Promise<string>;
  /** A short line to say at once while `answer` works on something slow (a web search), or null. */
  holdLine?(text: string): string | null | Promise<string | null>;
  /** A reply written from the transcript, or null to let Omni answer from the audio. */
  answer?(text: string, history: Line[]): Promise<string | null>;
  /** After the call, with everything that was said. */
  end?(transcript: Line[]): Promise<void>;
}

export interface ModeDefinition {
  readonly info: ModeInfo;
  open(context: ModeContext): CallMode;
}

/** How every reply should sound: it will be spoken, not read. */
export const SPOKEN =
  "You are speaking out loud. Use plain, everyday words. Never use markdown, lists, symbols, emoji or code.";

/** The last `n` lines as chat messages for the everyday model. */
export const asMessages = (history: Line[], n = 10) =>
  history.slice(-n).map((l) => ({ role: l.role, content: l.text.slice(0, 400) }) as const);

export function now() {
  const d = new Date();
  return `${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}
