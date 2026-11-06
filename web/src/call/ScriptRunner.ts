// Plays a script on a live call, one turn at a time. Your lines are either read
// aloud in the other voice ("ai") and fed to the call as if from the
// microphone, or said by you ("me"): the line is shown and the microphone only
// counts while it's your turn. Each turn waits for the whole spoken reply.

import type { Voice } from "../../../shared/protocol";
import type { ScriptVoice } from "../prefs";
import { Store } from "../store";
import type { CallClient } from "./CallClient";
import { parseScript, speakLine, wait, type SpokenLine } from "./script";

export type ScriptState = {
  /** The turn being played, -1 when not running. */
  at: number;
  total: number;
  /** In "me" mode, the line you're to say now. */
  cue: string;
};

/** Silence after a spoken line before it counts as finished (the detector waits 800 ms). */
const TAIL_FRAMES = 15;
/** Give up on a reply that hasn't finished after this long. */
const REPLY_MS = 90_000;
const FRAME_MS = 20;
const PAUSE_MS = 700;

/** Resolves on the call's next `event`, or when `signal` aborts. */
function next(call: CallClient, event: "spoken" | "turnEnd", signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const off = call.on(event, () => (off(), resolve()));
    signal.addEventListener("abort", () => (off(), resolve()), { once: true });
  });
}

export class ScriptRunner extends Store<ScriptState> {
  readonly #call: CallClient;
  #run: AbortController | null = null;

  constructor(call: CallClient) {
    super({ at: -1, total: 0, cue: "" });
    this.#call = call;
  }

  stop() {
    this.#run?.abort();
  }

  /** `agentVoice`: the assistant's voice; your lines are read in the other one. */
  async play(script: string, who: ScriptVoice, agentVoice: Voice) {
    const call = this.#call;
    const turns = parseScript(script);
    if (!call.live || !turns.length) return;
    this.stop();
    const run = new AbortController();
    this.#run = run;
    const { signal } = run;
    const self = who === "me";
    const voice: Voice = agentVoice === "male" ? "female" : "male";
    const speakYou = (i: number): Promise<SpokenLine | null> =>
      !self && turns[i]?.you ? speakLine(turns[i].you, voice, call.inputRate, signal) : Promise.resolve(null);
    const out = new AudioContext();
    // Reading your lines aloud with the mic open would make it hear itself.
    call.suppressMic(!self);
    // Saying them yourself, the mic only counts during your line: between lines it
    // would hear the reply and the room, and each sound would cut in as a new turn.
    const ignore = { start() {}, end() {} };
    if (self) call.listener = ignore;
    this.patch({ at: 0, total: turns.length, cue: "" });

    try {
      let line = speakYou(0);
      for (let i = 0; i < turns.length && !signal.aborted && call.live; i++) {
        this.patch({ at: i });
        const { you, reply } = turns[i];
        const spokenLine = await line;
        line = speakYou(i + 1);
        line.catch(() => {});
        if (signal.aborted) break;
        const replied = next(call, "spoken", signal);

        if (you && self) {
          this.patch({ cue: you });
          // Without a scripted reply your speech goes to the call as usual; with one it only needs to be heard.
          const done = reply !== undefined ? new Promise<void>((resolve) => (call.listener = { start: () => call.markHearing(), end: resolve })) : next(call, "turnEnd", signal);
          if (reply === undefined) call.listener = null;
          await Promise.race([done, wait(REPLY_MS, signal)]);
          call.listener = ignore;
          this.patch({ cue: "" });
          if (signal.aborted) break;
          call.showLine(you);
        } else if (spokenLine) {
          call.showLine(you);
          await this.#playLine(spokenLine, out, reply === undefined, signal);
          if (signal.aborted) break;
        } else call.showLine("");

        if (reply !== undefined) call.say(you, reply);
        // Wait for the reply to arrive in full and finish playing, then a short beat.
        await Promise.race([replied, wait(REPLY_MS, signal)]);
        const started = performance.now();
        while (!signal.aborted && call.playing && performance.now() - started < REPLY_MS) await wait(100, signal);
        await wait(PAUSE_MS, signal);
      }
    } catch (e) {
      if (!signal.aborted) call.showError(e instanceof Error ? e.message : String(e));
    } finally {
      call.listener = null;
      call.suppressMic(false);
      out.close().catch(() => {});
      if (this.#run === run) {
        this.#run = null;
        this.patch({ at: -1, cue: "" });
      }
    }
  }

  /**
   * Plays your line out loud. `toCall`: the call hears it at the pace a
   * microphone would send it; otherwise only the listening face shows.
   */
  async #playLine(line: SpokenLine, out: AudioContext, toCall: boolean, signal: AbortSignal) {
    const call = this.#call;
    const source = out.createBufferSource();
    source.buffer = line.audio;
    source.connect(out.destination);
    source.start();
    signal.addEventListener("abort", () => source.stop(), { once: true });
    if (toCall) call.utterance.start([]);
    else call.markHearing();
    const size = line.frames[0]?.length ?? Math.round(call.inputRate / 50);
    const frames = [...line.frames, ...Array.from({ length: TAIL_FRAMES }, () => new Int16Array(size))];
    const t0 = performance.now();
    for (let f = 0; f < frames.length && !signal.aborted; f++) {
      if (toCall) call.utterance.frame(frames[f]);
      await wait(t0 + (f + 1) * FRAME_MS - performance.now(), signal);
    }
    if (toCall && !signal.aborted) call.utterance.end();
  }
}
