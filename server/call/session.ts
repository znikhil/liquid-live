// One live call. The browser streams microphone audio; Omni's realtime session
// listens and talks back. Around it, each turn is routed:
//
//   only a filler sound ("um", "ah")  -> dropped, no answer
//   about the camera, camera on       -> Omni, with a note of what it sees
//   the mode writes the reply         -> the everyday model, then spoken word for word
//   anything else                     -> Omni straight from the audio (fastest)
//
// Speech goes back through SpeechOut (with face frames for LAM heads). The
// user can talk over a reply at any time: `#epoch` goes up, and work that
// finishes for an older epoch is dropped.

import fs from "node:fs";
import path from "node:path";
import type { RawData, WebSocket } from "ws";
import { config } from "../config.ts";
import type { ClientMessage, ServerMessage, ServerPhase, SpeechEngine, StartMessage, Voice } from "../../shared/protocol.ts";
import { faceAvailable } from "../face/a2e.ts";
import { Feelings } from "../face/emotion.ts";
import type { Brain } from "../models/brain.ts";
import { parakeetAvailable, transcribe } from "../models/asr.ts";
import { speak } from "../models/omni.ts";
import { isWoofVoice, woof } from "../models/woof.ts";
import type { Router } from "../models/router.ts";
import type { ModelRuntime } from "../models/runtime.ts";
import { findMode } from "../modes/index.ts";
import { newsAvailable } from "../news.ts";
import type { CallMode, Line } from "../modes/mode.ts";
import { toWav } from "../wav.ts";
import { Camera, CAMERA_INSTRUCTIONS } from "./camera.ts";
import { BrainResponder } from "./brain-responder.ts";
import { OmniRealtime, type RealtimeEvent, type RealtimeHandlers, type Responder } from "./realtime.ts";
import { SentenceSpeaker, SpeechOut, type SayFn } from "./speech.ts";

/** A turn that is only a filler sound gets no answer: Omni would reply to "Ah." as if asked something. */
const FILLER = /^\W*((a+h+|u+[hm]+|h*m+|o+h+|e+r+|e+h+|hu+h|mhm|uh-huh|ha+)\W*)+$/i;
/**
 * What speech recognition "hears" in noise or the assistant's own voice coming
 * back through the speakers: it fills near-silence with the phrases that end
 * countless videos. Only dropped when the audio was also quiet (QUIET_PEAK),
 * so a clearly spoken "thank you" still gets an answer.
 */
const NOISE_PHRASE = /^\W*(thank you( so much| very much)?|thanks( for watching)?|thank you for watching|bye( bye)?|you|okay)\W*$/i;
/**
 * Loudest 200 ms of an utterance (RMS, 0..1) below which it was probably not
 * the user talking. Measured: a phantom "Thank you" peaked at 0.018, real speech
 * at 0.08-0.15.
 */
const QUIET_PEAK = 0.04;
/**
 * Sentences that sound unfinished ("…how to explain something to"): no closing
 * punctuation from the recogniser, or a last word that needs more after it.
 */
const UNFINISHED = /(^|\s)(to|the|a|an|and|or|but|about|of|for|with|in|on|at|my|your|our|their|because|so|that|if|like|than|from|into|is|are|was|were)\W*$/i;
const unfinished = (text: string) => !/[.?!…]["')]?\s*$/.test(text) || UNFINISHED.test(text);
/** How long an unfinished sentence waits for the rest before it is answered anyway. */
const FINISH_WAIT_MS = 1500;
/** Talked over before any reply was heard, a turn's audio is kept this long to join what the user says next. */
const CARRY_MS = 8000;
/** Silence put between joined pieces of audio. */
const JOIN_GAP_S = 0.3;
/** Shorter utterances are noise. */
const MIN_UTTERANCE_S = 0.3;
const READ_OUT = "Read this reply out loud exactly as written, word for word, adding nothing before or after it:";

export type CallDeps = { runtime: ModelRuntime; brain: Brain; router: Router };

/** One exchange: what the user said and the reply. */
type Turn = { user: Line; reply: Line };

/** RMS of the loudest 200 ms window of PCM16 audio, 0..1. */
function peakLevel(pcm: Buffer, rate: number) {
  const window = Math.max(1, Math.round(rate * 0.2));
  let peak = 0;
  for (let start = 0; start + 1 < pcm.length; start += window * 2) {
    let sum = 0;
    let n = 0;
    for (let i = start; i + 1 < pcm.length && n < window; i += 2, n++) sum += (pcm.readInt16LE(i) / 0x8000) ** 2;
    if (n) peak = Math.max(peak, Math.sqrt(sum / n));
  }
  return peak;
}

/** Whether a spoken turn's words are only noise: a filler sound, or a typical phantom phrase from quiet audio. */
const isNoise = (text: string, level: number) => FILLER.test(text) || (NOISE_PHRASE.test(text) && level < QUIET_PEAK);

/**
 * Debug only (LIVE_DEBUG=1): keeps each utterance and what was heard in
 * <data>/debug/, to compare recognisers on a real voice. Never sent anywhere.
 */
function saveUtterance(pcm: Buffer, rate: number, heard: string) {
  try {
    const dir = path.join(config.dataDir, "debug");
    fs.mkdirSync(dir, { recursive: true });
    const name = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(dir, `${name}.wav`), toWav(pcm, rate));
    fs.appendFileSync(path.join(dir, "heard.tsv"), `${name}.wav\t${heard.replace(/\s+/g, " ")}\n`);
  } catch {}
}

const toBuffer = (data: RawData) => (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer));
const cleanName = (name: unknown) => (typeof name === "string" && name.replace(/[^\p{L} '-]/gu, "").trim().slice(0, 30)) || "Aria";

export class CallSession {
  readonly #client: WebSocket;
  readonly #deps: CallDeps;
  readonly #abort = new AbortController();
  readonly #camera: Camera;
  /** What answers: the brain (no Omni loaded), or Omni's realtime session. */
  #realtime: Responder | null = null;
  /** This call holds Omni loaded (its voice, or the camera). */
  #usingOmni = false;
  #cameraWantsOmni = false;
  #mode: CallMode | null = null;
  #voice: Voice = "female";
  /** Who speaks the replies: Omni's realtime voice, or a Woof voice. */
  #engine: SpeechEngine = "omni";
  #wantFace = false;
  #speech: SpeechOut | null = null;
  /** Male voice only: speaks the reply text sentence by sentence. */
  #tts: SentenceSpeaker | null = null;
  #feelings: Feelings | null = null;
  #inputRate = 16000;
  /** The utterance being streamed by the microphone. */
  #heard: Buffer[] = [];
  #transcript: Line[] = [];
  #turn: Turn | null = null;
  /** Goes up whenever the user talks over a reply. */
  #epoch = 0;
  /** A turn is waiting for its words or for a written reply. */
  #waiting = false;
  /** The last reply was word for word the one before it. */
  #repeated = false;
  /** The current turn's audio, and whether any of its reply has been heard yet. */
  #turnAudio: Buffer | null = null;
  #turnSpoke = false;
  /**
   * A sentence the user wasn't done with: they talked over it before any reply
   * was heard ("…how to negotiate" … "salary"), or it sounded unfinished and is
   * waiting a moment. Its audio is joined to what they say next and transcribed
   * as one, so the recogniser hears the whole sentence.
   */
  #carry: { audio: Buffer; at: number } | null = null;
  #finishTimer: NodeJS.Timeout | undefined;
  /** A turn whose hold line ("Let me check…") is spoken while its real answer is worked out; the reply continues after it. */
  #holding: Turn | null = null;
  #closed = false;

  constructor(client: WebSocket, deps: CallDeps) {
    this.#client = client;
    this.#deps = deps;
    this.#camera = new Camera(() => this.#waiting || !!this.#realtime?.responding, this.#abort.signal);
    client.on("message", (data, binary) => this.#onClient(data, binary));
    client.on("close", () => this.#close());
  }

  // ---- Browser -> server ----

  #onClient(data: RawData, binary: boolean) {
    if (binary) {
      if (!this.#realtime) return;
      const pcm = toBuffer(data);
      this.#heard.push(pcm);
      this.#realtime.appendAudio(pcm);
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === "start") return void (this.#realtime ? undefined : this.#start(msg));
    if (msg.type === "stop") return this.#client.close();
    if (!this.#realtime || !this.#mode) return;
    switch (msg.type) {
      case "commit":
        return this.#commit();
      case "cancel":
        return this.#interrupt();
      case "text": {
        const text = String(msg.text ?? "").trim();
        if (!text) return;
        this.#carry = null; // a typed message starts fresh
        const turn = this.#beginTurn(text);
        void this.#route(turn, text, false);
        return;
      }
      case "say": {
        const text = String(msg.text ?? "").trim();
        const user = String(msg.user ?? "").trim();
        if (!text) return;
        this.#realtime.cancel();
        const turn = this.#beginTurn(user);
        void this.#deliver(turn, text, user);
        return;
      }
      case "frame":
        // Only Omni can see. With Omni turned off, frames are ignored: the camera counts as off.
        if (!config.omniEnabled) return;
        // The camera loads Omni on demand for as long as it's on.
        if (!this.#cameraWantsOmni && !this.#usingOmni) {
          this.#cameraWantsOmni = true;
          void this.#deps.runtime.need("omni");
        }
        return this.#camera.setFrame(msg.jpeg);
      case "camera":
        if (this.#cameraWantsOmni) {
          this.#cameraWantsOmni = false;
          this.#deps.runtime.release("omni");
        }
        return this.#camera.off();
    }
  }

  async #start(msg: StartMessage) {
    const { runtime, brain } = this.#deps;
    const definition = findMode(String(msg.mode));
    const refuse = (message: string) => {
      this.#fail(message);
      this.#client.close();
    };
    if (!definition) return refuse("Unknown mode.");
    if (definition.info.needsBrain && !brain.available) return refuse(`${definition.info.title} needs the brain (${config.brainModel}), which isn't running.`);

    this.#voice = msg.voice === "male" ? "male" : "female";
    // With Omni turned off, Woof Juno speaks whatever voice was asked for.
    const wanted = !config.omniEnabled && !isWoofVoice(msg.speech) ? "juno" : msg.speech;
    if (isWoofVoice(wanted)) {
      if (woof.available) this.#engine = wanted;
      else if (config.omniEnabled) this.#fail("Underdog Woof isn't running, so this call uses Omni's voice.");
      else return refuse("Underdog Woof isn't running, and Omni is turned off, so there is no voice. Check that Python with numpy is installed.");
    }
    this.#wantFace = msg.face === true;
    const signal = this.#abort.signal;
    if (msg.emotions === true) this.#feelings = new Feelings(brain, this.#deps.router, (emotion) => this.#send({ type: "emotion", emotion }), signal);
    this.#mode = definition.open({ name: cleanName(msg.name), brain, router: this.#deps.router, search: msg.search === true && newsAvailable(), signal });
    const handlers: RealtimeHandlers = {
      event: (event) => this.#onRealtime(event),
      responseStarted: () => {
        this.#speech?.begin();
        this.#state("thinking");
      },
      error: (message) => this.#fail(message),
      closed: () => this.#client.close(),
    };
    // With a text-to-speech voice, Parakeet hearing and the brain up, the brain answers and
    // Omni isn't loaded. Otherwise (the Omni voice) Omni is loaded for this call.
    if (this.#engine !== "omni" && parakeetAvailable() && brain.available) {
      this.#realtime = new BrainResponder(brain, () => this.#history(), handlers);
      return;
    }
    if (!config.omniEnabled) return refuse(`The brain (${config.brainModel}) or Parakeet isn't available, and Omni is turned off. Start LM Studio with the model loaded, or run npm run setup.`);
    this.#usingOmni = true;
    if (!runtime.isUp("omni")) this.#fail("Loading Omni for its voice, one moment…");
    if (!(await runtime.need("omni"))) return refuse("LFM3 Omni 2B couldn't start. If you haven't, run npm run setup, then try again.");
    if (this.#closed) return;
    this.#realtime = new OmniRealtime(`${config.omniURL.replace(/^http/, "ws")}/realtime`, handlers);
  }

  /** The user's utterance is complete. */
  #commit() {
    const rt = this.#realtime!;
    let audio = Buffer.concat(this.#heard);
    this.#heard = [];
    if (audio.length < this.#inputRate * 2 * MIN_UTTERANCE_S) return rt.clearAudio();
    const level = peakLevel(audio, this.#inputRate);
    // A turn still waiting for the rest of its sentence is continued by this one.
    if (this.#finishTimer) this.#carryOver();
    const carry = this.#carry;
    this.#carry = null;
    if (carry && Date.now() - carry.at < CARRY_MS) {
      audio = Buffer.concat([carry.audio, Buffer.alloc(Math.round(this.#inputRate * JOIN_GAP_S) * 2), audio]);
    }
    const turn = this.#beginTurn("");
    this.#turnAudio = audio;
    void this.#hear(turn, audio, level);
  }

  /** Transcribes the turn's audio and routes it, inside the turn's trace. */
  #hear(turn: Turn, audio: Buffer, level: number) {
    // The realtime session doesn't say what it heard, so the words come from a separate recogniser.
    const words = transcribe(audio, this.#inputRate, { signal: this.#abort.signal })
      .catch(() => "")
      .then((text) => {
        turn.user.text = text;
        if (text && !isNoise(text, level)) this.#send({ type: "user", text });
        if (process.env.LIVE_DEBUG) saveUtterance(audio, this.#inputRate, text);
        return text;
      });
    // Omni's own transcription is slow, so without Parakeet, a call with no camera and no
    // written replies lets Omni answer from the audio at once instead of waiting for the words.
    if (!parakeetAvailable() && !this.#camera.on && !this.#mode!.answers) return this.#route(turn, "", true, level);
    const epoch = this.#epoch;
    this.#waiting = true;
    this.#state("thinking");
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve(""), config.call.transcriptWaitMs));
    Promise.race([words, timeout]).then((text) => {
      this.#waiting = false;
      if (epoch !== this.#epoch || this.#turn !== turn) return;
      // Unfinished ("…something to"): give the user a moment to go on. If they do, this
      // turn is carried into theirs; if not, it is answered as it is.
      if (text && unfinished(text) && !isNoise(text, level)) {
        this.#finishTimer = setTimeout(() => {
          this.#finishTimer = undefined;
          if (epoch === this.#epoch && this.#turn === turn) this.#route(turn, text, true, level);
        }, FINISH_WAIT_MS);
        return;
      }
      this.#route(turn, text, true, level);
    });
  }

  #interrupt() {
    this.#carryOver();
    this.#heard = [];
    this.#epoch++;
    this.#waiting = false;
    this.#holding = null;
    this.#speech?.reset();
    this.#tts?.interrupt();
    this.#feelings?.reset();
    this.#realtime?.cancel();
    this.#finishTurn();
    this.#state("listening");
  }

  /**
   * The current turn hasn't been answered aloud yet (talked over while thinking, or waiting
   * for the rest of an unfinished sentence): keep its audio for the next utterance and drop
   * its half-sentence from the transcript.
   */
  #carryOver() {
    clearTimeout(this.#finishTimer);
    this.#finishTimer = undefined;
    const turn = this.#turn;
    if (!turn || this.#turnSpoke || !this.#turnAudio) return;
    this.#carry = { audio: this.#turnAudio, at: Date.now() };
    this.#transcript = this.#transcript.filter((l) => l !== turn.user && l !== turn.reply);
    this.#turnAudio = null;
  }

  // ---- Routing a turn ----

  /**
   * `text`: what the user said or typed; `spoken`: their audio is in Omni's
   * input buffer; `level`: how loud that audio was at its loudest.
   */
  #route(turn: Turn, text: string, spoken: boolean, level = 1) {
    if (spoken && process.env.LIVE_DEBUG) console.log(`  Heard "${text}" (peak level ${level.toFixed(3)})`);
    if (spoken ? isNoise(text, level) : FILLER.test(text)) {
      if (!FILLER.test(text)) console.log(`  Ignored "${text}" as noise (peak level ${level.toFixed(3)})`);
      return this.#drop(turn);
    }
    const epoch = this.#epoch;
    this.#waiting = true;
    this.#state("thinking");
    // d1 says whether the words are about the camera (~0.1 s); without it, word lists do.
    void this.#deps.router.decide(text).then((decision) => {
      if (epoch !== this.#epoch || this.#turn !== turn) return;
      this.#waiting = false;
      this.#answer(turn, text, spoken, decision ? decision.intent === "camera" : undefined);
    });
  }

  /** `aboutCamera`: the router's verdict, or undefined when word lists decide. */
  #answer(turn: Turn, text: string, spoken: boolean, aboutCamera: boolean | undefined) {
    const omni = () => this.#omniAnswers(text, spoken, aboutCamera);
    const mode = this.#mode!;
    if (!text || !mode.answer || !mode.answers || this.#camera.asksAbout(text, aboutCamera)) return omni();

    const epoch = this.#epoch;
    this.#waiting = true;
    this.#state("thinking");
    // Something slow (a web search): say a short line now, and the answer when it's ready.
    void Promise.resolve(mode.holdLine?.(text) ?? null).then((hold) => {
      // Only while the answer is still being worked out.
      if (!hold || !this.#waiting || epoch !== this.#epoch || this.#turn !== turn) return;
      if (spoken) this.#realtime!.clearAudio();
      this.#holding = turn;
      this.#deliver(turn, hold, text);
    });
    mode
      .answer(text, this.#history())
      .catch(() => null)
      .then((answer) => {
        this.#waiting = false;
        if (epoch !== this.#epoch || this.#turn !== turn) return; // talked over, or a newer turn began
        const held = this.#holding === turn;
        this.#holding = null;
        // After a hold line the audio is gone, so Omni answers from the words.
        if (!answer) return held ? this.#omniAnswers(text, false, aboutCamera) : omni();
        if (spoken && !held) this.#realtime!.clearAudio();
        this.#deliver(turn, answer, held ? "" : text);
      });
  }

  #omniAnswers(text: string, spoken: boolean, aboutCamera?: boolean) {
    const rt = this.#realtime!;
    const notes = [this.#repeated && "You just repeated your previous answer word for word. Don't repeat it; answer what the user says now.", this.#camera.noteFor(text, aboutCamera)].filter(Boolean);
    this.#repeated = false;
    if (notes.length) rt.addUserText(`(${notes.join(" ")})`);
    // With the words in hand, Omni answers from them rather than from its own, less
    // reliable, hearing ("box office collection" heard as "box of fixed collection").
    if (spoken && text) {
      rt.clearAudio();
      rt.addUserText(text);
    } else if (spoken) rt.commitAudio();
    else rt.addUserText(text);
    rt.respond();
  }

  /** Speaks `answer` word for word as the reply to `heard`, in the call's voice. */
  #deliver(turn: Turn, answer: string, heard: string) {
    const rt = this.#realtime!;
    const said = heard ? `The user said: "${heard}"\n` : "";
    if (!this.#tts) {
      // Omni reads it in its own realtime voice, so the call keeps one voice.
      rt.addUserText(`${said}${READ_OUT}\n${answer}`);
      rt.respond();
      return;
    }
    // Male voice: the TTS speaks it directly; Omni only notes the exchange for context.
    rt.noteExchange(heard, answer);
    const epoch = this.#epoch;
    turn.reply.text = answer;
    this.#send({ type: "assistant", text: answer });
    this.#state("thinking");
    this.#speech!.begin();
    void this.#tts.speakAll(answer).then(() => {
      if (epoch !== this.#epoch || this.#holding === turn) return; // a hold line: the answer follows
      if (this.#turn === turn) this.#finishTurn();
      this.#afterSpeech(epoch);
    });
  }

  #drop(turn: Turn) {
    this.#realtime!.clearAudio();
    this.#transcript = this.#transcript.filter((l) => l !== turn.user && l !== turn.reply);
    this.#turn = null;
    this.#send({ type: "turn.done" });
    this.#state("listening");
  }

  /** The mode opens the call (the tutor does). */
  #open() {
    const mode = this.#mode!;
    if (!mode.opener) return;
    const epoch = this.#epoch;
    this.#state("thinking");
    mode
      .opener()
      .catch(() => "")
      .then((line) => {
        if (epoch !== this.#epoch || this.#turn || this.#realtime?.responding) return; // the user spoke first
        if (!line) return this.#state("listening");
        const turn = this.#beginTurn("");
        void this.#deliver(turn, line, "");
      });
  }

  // ---- Omni -> browser ----

  #onRealtime(event: RealtimeEvent) {
    switch (event.type) {
      case "session.created":
        return this.#onSessionCreated(event);
      case "response.output_text.delta": {
        const turn = this.#turn;
        if (!turn) return;
        turn.reply.text += event.delta ?? "";
        this.#send({ type: "assistant", text: turn.reply.text });
        if (this.#tts) this.#tts.follow(turn.reply.text, false);
        else this.#feelings?.follow(turn.reply.text, false);
        return;
      }
      case "response.output_audio.delta":
        if (this.#turn) this.#speech?.push(Buffer.from(event.delta ?? "", "base64"));
        return;
      case "response.done":
        return this.#onResponseDone();
      case "error":
        this.#fail(event.error?.message ?? "Voice error.");
        if (!this.#realtime?.responding) this.#state("listening");
        return;
    }
  }

  #onSessionCreated(event: Extract<RealtimeEvent, { type: "session.created" }>) {
    const audio = event.session?.audio;
    this.#inputRate = audio?.input?.format?.rate ?? 16000;
    const outputRate = audio?.output?.format?.rate ?? 24000;
    // Omni speaks in its own voice, or writes text for a text-to-speech voice to read sentence by sentence.
    const say = this.#textToSpeech();
    this.#realtime!.configure({
      instructions: `${this.#mode!.instructions}\n${CAMERA_INSTRUCTIONS}`,
      output_modalities: say ? ["text"] : ["text", "audio"],
      max_output_tokens: 400,
    });
    const face = this.#wantFace && faceAvailable();
    if (this.#wantFace && !face) this.#fail("The LAM A2E face model isn't downloaded, so the avatar's lips won't move.");
    this.#speech = new SpeechOut(
      outputRate,
      { json: (m) => this.#send(m), binary: (pcm) => this.#client.readyState === 1 && this.#client.send(pcm) },
      {
        face,
        started: () => {
          this.#turnSpoke = true;
          this.#state("speaking");
        },
        overflow: () => this.#realtime?.cancel(),
      },
    );
    if (say) this.#tts = new SentenceSpeaker(say, this.#speech, this.#feelings, this.#abort.signal);
    this.#send({ type: "ready", inputRate: this.#inputRate, outputRate, face });
    this.#state("listening");
    this.#open();
  }

  /** The voice that reads text replies, or null when Omni speaks them itself. */
  #textToSpeech(): SayFn | null {
    const engine = this.#engine;
    if (engine !== "omni") return (text, signal) => woof.speak(text, engine, { signal });
    if (this.#voice === "male") return (text, signal) => speak(text, "male", { signal });
    return null;
  }

  #onResponseDone() {
    const text = this.#turn?.reply.text ?? "";
    const spoken = this.#tts ? this.#tts.follow(text, true) : Promise.resolve();
    if (!this.#tts) {
      this.#speech?.flush();
      if (this.#turn) this.#feelings?.follow(text, true);
    }
    if (this.#realtime!.settle()) return; // a queued response took over this turn
    if (this.#holding && this.#holding === this.#turn) {
      this.#turn.reply.text += " "; // the answer follows the hold line in the same reply
      return;
    }
    this.#finishTurn();
    const epoch = this.#epoch;
    void spoken.then(() => epoch === this.#epoch && this.#afterSpeech(epoch));
  }

  /** All of a reply's speech is queued: flush the face analysis, then tell the browser it has everything. */
  #afterSpeech(epoch: number) {
    if (this.#tts) this.#speech?.flush();
    void this.#speech?.drained.then(() => epoch === this.#epoch && this.#send({ type: "audio.done" }));
  }

  // ---- Turns and transcript ----

  #beginTurn(userText: string): Turn {
    this.#finishTurn();
    const turn: Turn = { user: { role: "user", text: userText }, reply: { role: "assistant", text: "" } };
    this.#turn = turn;
    this.#turnSpoke = false;
    this.#turnAudio = null;
    this.#transcript.push(turn.user, turn.reply);
    this.#tts?.restart();
    this.#feelings?.reset();
    return turn;
  }

  #finishTurn() {
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = null;
    turn.reply.text = turn.reply.text.trim();
    const before = this.#transcript.findLast((l) => l.role === "assistant" && l !== turn.reply && l.text);
    if (turn.reply.text && before?.text === turn.reply.text) this.#repeated = true;
    this.#send({ type: "turn.done" });
  }

  /** What was said before the current turn. */
  #history() {
    const turn = this.#turn;
    return this.#transcript.filter((l) => l.text && l !== turn?.user && l !== turn?.reply);
  }

  // ---- Plumbing ----

  #send(message: ServerMessage) {
    if (this.#client.readyState === 1) this.#client.send(JSON.stringify(message));
  }

  #state(state: ServerPhase) {
    this.#send({ type: "state", state });
  }

  #fail(message: string) {
    this.#send({ type: "error", message });
  }

  #close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#finishTurn();
    this.#camera.stop();
    this.#abort.abort();
    this.#speech?.reset();
    this.#tts?.interrupt();
    this.#realtime?.close();
    if (this.#usingOmni) this.#deps.runtime.release("omni");
    if (this.#cameraWantsOmni) this.#deps.runtime.release("omni");
    const transcript = this.#transcript.filter((l) => l.text);
    this.#mode?.end?.(transcript).catch(() => {});
  }
}
