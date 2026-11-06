// The contract between the browser and the server, imported by both sides.
// One WebSocket per call carries JSON control messages and binary PCM16 audio:
// microphone audio upstream at `inputRate`, speech downstream at `outputRate`.

export type Voice = "female" | "male";

/** Who speaks the replies: Omni's own realtime voice, or Underdog Woof in one of its voices. */
export type SpeechEngine = "omni" | "juno" | "mira";
export const SPEECH_ENGINES: readonly SpeechEngine[] = ["omni", "juno", "mira"];

export type Emotion = "neutral" | "happy" | "sad" | "surprised" | "angry" | "thinking";
export const EMOTIONS: readonly Emotion[] = ["neutral", "happy", "sad", "surprised", "angry", "thinking"];

/** LAM A2E output for one chunk of speech: `n` frames of the 52 ARKit shapes, as integers 0–1000. */
export type FaceFrames = { fps: number; n: number; values: number[] };

/** What the server is doing; the browser adds "hearing" while you talk. */
export type ServerPhase = "listening" | "thinking" | "speaking";

export type StartMessage = {
  type: "start";
  mode: string;
  /** What the assistant is called (the avatar's name). */
  name: string;
  voice: Voice;
  /** Send LAM A2E face frames with the speech (only for avatars that use them). */
  face: boolean;
  /** Send {type:"emotion"} as the feeling of the reply changes. */
  emotions: boolean;
  /** Allow live web search for news questions (only works when the server has a Tavily key). */
  search: boolean;
  /** Who speaks the replies (Woof only works when the server has it installed). */
  speech: SpeechEngine;
};

export type ClientMessage =
  | StartMessage
  /** The utterance streamed so far is complete. */
  | { type: "commit" }
  /** The user talked over the reply. */
  | { type: "cancel" }
  | { type: "stop" }
  | { type: "text"; text: string }
  /** A scripted turn: `text` is spoken word for word as the reply to `user`. */
  | { type: "say"; user: string; text: string }
  /** The newest camera picture (base64 JPEG), about once a second. */
  | { type: "frame"; jpeg: string }
  | { type: "camera"; on: false };

export type ServerMessage =
  | { type: "ready"; inputRate: number; outputRate: number; face: boolean }
  | { type: "state"; state: ServerPhase }
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  /** The reply's text is complete. */
  | { type: "turn.done" }
  /** All of the finished reply's speech has been sent. */
  | { type: "audio.done" }
  /** Face frames for the chunk of speech that comes next. */
  | ({ type: "face" } & FaceFrames)
  /** The feeling of the speech that comes next. */
  | { type: "emotion"; emotion: Emotion }
  | { type: "error"; message: string };

/** A use case the lobby offers. */
export type ModeInfo = {
  id: string;
  title: string;
  description: string;
  /** Needs the everyday model (LFM3 1.7B) to work. */
  needsBrain: boolean;
};

export type Status = {
  /** The models aren't downloaded yet: `npm run setup`. */
  setupNeeded: boolean;
  /** Omni can be used: running, or installed to load on demand (see omniLoaded). */
  omni: boolean;
  /** Omni is loaded in memory right now. */
  omniLoaded: boolean;
  brain: boolean;
  /** Which model the brain is (e.g. "qwen3.5-4b-mlx"). */
  brainName: string;
  face: boolean;
  /** Live news search is set up (TAVILY_API_KEY). */
  news: boolean;
  /** Underdog Woof is installed and running, so replies can be spoken with it. */
  woof: boolean;
  /** d1-2B, the decision model, is routing requests (else word lists do). */
  router: boolean;
  modes: ModeInfo[];
};
