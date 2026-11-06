// Photo-realistic LAM heads (Gaussian splats on a FLAME rig), drawn by
// @myned-ai/gsplat-flame-avatar-renderer. The face follows the 52 ARKit shapes
// from LAM A2E: each chunk's frames are placed where its audio starts on the
// player's clock, and the renderer reads the current frame every animation
// frame. The head's own clips play the idle, listening, thinking and speaking motion.

import { GaussianSplatRenderer } from "@myned-ai/gsplat-flame-avatar-renderer";
import type { Emotion, FaceFrames } from "../../../shared/protocol";
import { Player, type Speaker } from "../audio/player";
import { ARKIT, type Avatar, type AvatarMood } from "./catalog";
import { Mood } from "./mood";

type ChatState = "Idle" | "Listening" | "Thinking" | "Responding";

type Renderer = {
  dispose(): void;
  getCamera(): { setViewOffset(fw: number, fh: number, x: number, y: number, w: number, h: number): void; updateProjectionMatrix(): void } | undefined;
};

/** `create` is the documented constructor (v1.0.6+); the bundled types only list getInstance. */
const create = (GaussianSplatRenderer as unknown as {
  create(
    container: HTMLDivElement,
    assetPath: string,
    options: { backgroundColor?: string; getChatState?: () => string; getExpressionData?: () => Record<string, number> },
  ): Promise<Renderer>;
}).create;

/**
 * The renderer frames the whole bust small in the middle; for the round,
 * video-call frame the camera is cropped to head and shoulders (a sub-view, so
 * it stays sharp): the crop's size and centre as fractions.
 */
const CROP = { size: 0.52, x: 0.5, y: 0.4 };
/** Gaze stays with the head's own animation; the model drives the rest of the face. */
const FACE_SHAPES = ARKIT.map((name, i) => [name, i] as const).filter(([name]) => !name.startsWith("eyeLook"));
const MOOD_STATE: Record<AvatarMood, ChatState> = { listening: "Listening", hearing: "Listening", thinking: "Thinking" };

export class LamHead implements Avatar {
  readonly ready: Promise<void>;
  readonly #mood: Mood;
  #renderer: Renderer | null = null;
  #disposed = false;
  #state: ChatState = "Idle";
  #player: Player | null = null;
  /** Face frames for chunks queued to play, by start time on the player's clock. */
  #segments: { at: number; face: FaceFrames }[] = [];
  /** A feeling waiting for its speech to arrive, then the ones queued on the player's clock. */
  #nextFeeling: Emotion | null = null;
  #feelings: { at: number; emotion: Emotion }[] = [];

  constructor(node: HTMLDivElement, url: string, { emotions }: { emotions: boolean }) {
    this.#mood = new Mood(emotions);
    this.ready = create(node, url, {
      backgroundColor: "0x1b2233",
      getChatState: () => (this.#player?.playing ? "Responding" : this.#state),
      getExpressionData: () => this.#expression(),
    }).then((r) => {
      if (this.#disposed) return r.dispose();
      this.#renderer = r;
      const camera = r.getCamera();
      const w = node.clientWidth || 1;
      const h = node.clientHeight || 1;
      const side = Math.min(w, h) * CROP.size;
      camera?.setViewOffset(w, h, w * CROP.x - side / 2, h * CROP.y - side / 2, side, side);
      camera?.updateProjectionMatrix();
    });
  }

  async speaker(rate: number): Promise<Speaker> {
    await this.ready;
    const player = new Player(rate);
    this.#player = player;
    let pending: FaceFrames | null = null;
    const clear = () => {
      this.#segments = [];
      this.#feelings = [];
      this.#nextFeeling = null;
      pending = null;
    };
    return {
      push: (bytes) => {
        const at = player.push(bytes);
        if (pending?.n) this.#segments.push({ at, face: pending });
        pending = null;
        if (this.#nextFeeling) this.#feelings.push({ at, emotion: this.#nextFeeling });
        this.#nextFeeling = null;
      },
      get playing() {
        return player.playing;
      },
      face: (face) => {
        pending = face;
      },
      flush: () => {
        player.flush();
        clear();
      },
      close: () => {
        player.close();
        clear();
        if (this.#player === player) this.#player = null;
      },
      resume: () => player.resume(),
    };
  }

  /** Speech often arrives well ahead of when it plays, so the face changes when that audio starts. */
  setEmotion(emotion: Emotion) {
    this.#nextFeeling = emotion;
  }

  setMood(mood: AvatarMood) {
    this.#state = MOOD_STATE[mood];
    this.#mood.setRest(mood === "thinking" ? "thinking" : "listening");
  }

  dispose() {
    this.#disposed = true;
    this.#renderer?.dispose();
    this.#renderer = null;
    this.#player = null;
  }

  /** The face right now: the playing chunk's current frame, plus the feeling and blinks. */
  #expression(): Record<string, number> {
    const out: Record<string, number> = {};
    const t = this.#player?.time ?? 0;
    const segments = this.#segments;
    while (segments.length && segments[0].at + segments[0].face.n / segments[0].face.fps < t) segments.shift();
    const seg = segments[0];
    if (seg && t >= seg.at) {
      const f = Math.min(seg.face.n - 1, Math.floor((t - seg.at) * seg.face.fps));
      for (const [name, k] of FACE_SHAPES) out[name] = seg.face.values[f * 52 + k] / 1000;
    }
    while (this.#feelings.length && this.#feelings[0].at <= t) this.#mood.set(this.#feelings.shift()!.emotion);
    this.#mood.apply(out, !!this.#player?.playing);
    return out;
  }
}
