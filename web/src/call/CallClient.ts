// One live call from the browser's side: microphone in, speech out, captions,
// camera frames and the turn-taking rules. It holds no React code; components
// read its state through useStore and call its methods.

import type { ClientMessage, ServerMessage, SpeechEngine } from "../../../shared/protocol";
import { callURL } from "../api";
import { SpeechDetector, type Utterance } from "../audio/detector";
import { Mic } from "../audio/mic";
import { Player, type Speaker } from "../audio/player";
import type { VoiceProbe } from "../audio/vad";
import type { Avatar, AvatarProfile } from "../avatar/catalog";
import { Store } from "../store";

export type Phase = "connecting" | "listening" | "hearing" | "thinking" | "speaking" | "ended";

export type TranscriptTurn = { you: string; agent: string };

export type CallState = {
  phase: Phase;
  /** Live captions: the user's last words and the reply so far. */
  you: string;
  agent: string;
  error: string;
  muted: boolean;
  camera: MediaStream | null;
  transcript: TranscriptTurn[];
};

export type CallOptions = {
  mode: string;
  profile: AvatarProfile;
  emotions: boolean;
  search: boolean;
  speech: SpeechEngine;
  camera: boolean;
  /** Send camera pictures to the AI (only when a model that sees is on); otherwise the camera is a self-view only. */
  shareCamera: boolean;
  /** The face on screen (null if it failed to load); it plays the speech so it can move in time with it. */
  avatar: Avatar | null;
};

type CallEvent = "spoken" | "turnEnd";

/** Longest side of a camera frame sent to the server, and how often. */
const FRAME_SIZE = 640;
const FRAME_MS = 1000;
/** While a reply plays, it takes this much louder sound to count as the user. */
const INTERRUPT_BOOST = 2.5;

export class CallClient extends Store<CallState> {
  readonly #options: CallOptions;
  #ws: WebSocket | null = null;
  #mic: Mic | null = null;
  /** The voice model (Silero VAD); null if it couldn't load, and then loudness alone decides. */
  #voice: VoiceProbe | null = null;
  #speaker: Speaker | null = null;
  #inputRate = 16000;
  /** The user's speech is streaming to the server. */
  #streaming = false;
  /** The server has sent all of the current reply's speech. */
  #audioDone = true;
  #userMuted = false;
  #micSuppressed = false;
  #current: TranscriptTurn = { you: "", agent: "" };
  #camera: { stream: MediaStream; timer: number } | null = null;
  #watch = 0;
  readonly #listeners: Record<CallEvent, Set<() => void>> = { spoken: new Set(), turnEnd: new Set() };

  /**
   * While set, speech the detector finds is reported here instead of going to
   * the call (a script listening for you to say your line).
   */
  listener: { start(): void; end(): void } | null = null;

  constructor(options: CallOptions) {
    super({ phase: "connecting", you: "", agent: "", error: "", muted: false, camera: null, transcript: [] });
    this.#options = options;
  }

  get inputRate() {
    return this.#inputRate;
  }

  get playing() {
    return this.#speaker?.playing ?? false;
  }

  get live() {
    const { phase } = this.state;
    return phase !== "connecting" && phase !== "ended";
  }

  on(event: CallEvent, listener: () => void) {
    this.#listeners[event].add(listener);
    return () => this.#listeners[event].delete(listener);
  }

  // ---- Lifecycle ----

  start() {
    if (this.#ws) return;
    const { mode, profile, emotions, search, speech } = this.#options;
    const ws = new WebSocket(callURL());
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    ws.onopen = () =>
      this.#send({ type: "start", mode, name: profile.name, voice: profile.voice, face: true, emotions, search, speech });
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) this.#speaker?.push(event.data);
      else this.#onMessage(JSON.parse(event.data));
    };
    ws.onclose = () => {
      if (this.state.phase === "connecting" && !this.state.error) this.patch({ error: "Couldn't connect to the call." });
      this.end();
    };
    this.#watch = window.setInterval(() => this.#settle(), 150);
  }

  end() {
    if (this.state.phase === "ended") return;
    clearInterval(this.#watch);
    this.#stopCamera();
    this.#send({ type: "stop" });
    this.#ws?.close();
    this.#mic?.stop();
    this.#voice?.close();
    this.#speaker?.close();
    this.#commitTurn();
    this.#setPhase("ended");
  }

  // ---- Controls ----

  setMuted(muted: boolean) {
    this.#userMuted = muted;
    this.#applyMute();
    this.patch({ muted });
  }

  /** Mutes the microphone without showing it as muted (a script reading your lines aloud). */
  suppressMic(suppressed: boolean) {
    this.#micSuppressed = suppressed;
    this.#applyMute();
  }

  async setCamera(on: boolean) {
    if (on) await this.#startCamera();
    else this.#stopCamera();
  }

  sendText(text: string) {
    this.#speaker?.flush();
    this.#send({ type: "text", text });
    this.showLine(text);
  }

  /** A scripted turn: the assistant replies to `user` with exactly `text`. */
  say(user: string, text: string) {
    this.#send({ type: "say", user, text });
  }

  /** Shows `text` as what the user just said. */
  showLine(text: string) {
    this.#current.you = text;
    this.patch({ you: text, agent: "" });
  }

  showError(message: string) {
    this.patch({ error: message });
  }

  /** Shows that the user is talking (a script saying their line). */
  markHearing() {
    this.#setPhase("hearing");
  }

  /** Speech to the call. The detector feeds it from the microphone; scripts feed it spoken lines. */
  readonly utterance: Utterance = {
    start: (preroll) => {
      // Talking over the reply interrupts it.
      if (this.playing || this.#streaming) {
        this.#send({ type: "cancel" });
        this.#speaker?.flush();
        this.#emit("spoken"); // anything waiting on that reply moves on
      }
      this.#streaming = true;
      this.#setPhase("hearing");
      for (const frame of preroll) this.#ws?.send(frame);
    },
    frame: (pcm) => this.#ws?.send(pcm),
    end: () => {
      this.#send({ type: "commit" });
      this.#setPhase("thinking");
    },
  };

  // ---- Server messages ----

  async #onMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "ready":
        return this.#onReady(msg.inputRate, msg.outputRate);
      case "state":
        if (msg.state === "listening") this.#streaming = false;
        if (msg.state === "thinking") this.#audioDone = false;
        // While the user talks, "listening" from the server doesn't change what's shown.
        if (!(this.state.phase === "hearing" && msg.state === "listening")) this.#setPhase(msg.state);
        return;
      case "user":
        this.#current.you = msg.text;
        return this.patch({ you: msg.text });
      case "assistant":
        this.#current.agent = msg.text;
        return this.patch({ agent: msg.text });
      case "turn.done":
        this.#streaming = false;
        return this.#commitTurn();
      case "audio.done":
        this.#audioDone = true;
        return this.#emit("spoken");
      case "face":
        return this.#speaker?.face?.(msg);
      case "emotion":
        return this.#options.avatar?.setEmotion(msg.emotion);
      case "error":
        return this.patch({ error: msg.message });
    }
  }

  async #onReady(inputRate: number, outputRate: number) {
    this.#inputRate = inputRate;
    // The voice model loads (lazily: its runtime is big) while the speaker gets ready.
    const voice = import("../audio/vad")
      .then((m) => m.VoiceProbe.load(inputRate))
      .catch((e) => (console.warn("Voice detection model unavailable; using loudness only.", e), null));
    const avatar = this.#options.avatar;
    this.#speaker = avatar ? await avatar.speaker(outputRate).catch(() => new Player(outputRate)) : new Player(outputRate);
    await this.#speaker.resume();
    this.#voice = await voice;
    const detector = new SpeechDetector({
      start: (preroll) => (this.listener ? this.listener.start() : this.utterance.start(preroll)),
      frame: (pcm) => !this.listener && this.utterance.frame(pcm),
      end: () => {
        if (this.listener) return this.listener.end();
        this.utterance.end();
        this.#emit("turnEnd");
      },
    }, this.#voice);
    this.#mic = new Mic(inputRate, (frame) => {
      this.#voice?.push(frame.pcm);
      // Raise the bar while it talks so its own voice doesn't count as the user.
      detector.push(frame, this.playing ? INTERRUPT_BOOST : 1);
    });
    try {
      await this.#mic.start();
    } catch {
      this.patch({ error: "I can't use the microphone. Allow it in your browser's site settings, then try again." });
      return this.end();
    }
    this.#applyMute();
    if (this.state.phase === "connecting") this.#setPhase("listening");
    if (this.#options.camera) await this.#startCamera();
  }

  // ---- Helpers ----

  /** A reply whose speech has all arrived and finished playing hands the turn back. */
  #settle() {
    if (this.state.phase === "speaking" && this.#audioDone && !this.playing) this.#setPhase("listening");
  }

  #setPhase(phase: Phase) {
    if (phase === this.state.phase) return;
    const avatar = this.#options.avatar;
    if (phase === "listening" || phase === "hearing" || phase === "thinking") avatar?.setMood(phase);
    this.patch({ phase });
  }

  #commitTurn() {
    const turn = this.#current;
    this.#current = { you: "", agent: "" };
    if (turn.you || turn.agent) this.patch({ transcript: [...this.state.transcript, turn] });
  }

  #applyMute() {
    if (this.#mic) this.#mic.muted = this.#userMuted || this.#micSuppressed;
  }

  async #startCamera() {
    if (this.#camera || !this.live) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch {
      return this.patch({ error: "I can't use the camera. Allow it in your browser's site settings, then try again." });
    }
    if (!this.live) return stream.getTracks().forEach((t) => t.stop()); // the call ended while asking
    // Self-view only: the page shows the camera, and no picture leaves the browser.
    if (!this.#options.shareCamera) {
      this.#camera = { stream, timer: 0 };
      return this.patch({ camera: stream });
    }
    // An off-screen copy of the video for grabbing frames; the page shows its own.
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    void video.play().catch(() => {});
    const canvas = document.createElement("canvas");
    const timer = window.setInterval(() => {
      if (video.readyState < 2 || !video.videoWidth) return;
      const scale = Math.min(1, FRAME_SIZE / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      this.#send({ type: "frame", jpeg: canvas.toDataURL("image/jpeg", 0.75).split(",")[1] });
    }, FRAME_MS);
    this.#camera = { stream, timer };
    this.patch({ camera: stream });
  }

  #stopCamera() {
    const camera = this.#camera;
    if (!camera) return;
    this.#camera = null;
    clearInterval(camera.timer);
    camera.stream.getTracks().forEach((t) => t.stop());
    if (this.#options.shareCamera) this.#send({ type: "camera", on: false });
    this.patch({ camera: null });
  }

  #send(message: ClientMessage) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(message));
  }

  #emit(event: CallEvent) {
    for (const listener of [...this.#listeners[event]]) listener();
  }
}
