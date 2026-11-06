// The face's feelings: a light expression layered over the lip sync. The lip
// sync keeps the mouth (only a soft smile or frown is added, softer while
// talking); brows, eyes, cheeks and nose get the expression. Changes ease in
// over about 300 ms, a reply's feeling fades after it ends, and the eyes blink
// every 2-6 s.

import type { Emotion } from "../../../shared/protocol";

/** What the face does between replies. */
export type Rest = "neutral" | "listening" | "thinking";

type Shape = Record<string, number>;

const PRESETS: Record<Emotion | "listening", Shape> = {
  neutral: {},
  listening: { browInnerUp: 0.08, mouthSmileLeft: 0.06, mouthSmileRight: 0.06 },
  happy: { mouthSmileLeft: 0.32, mouthSmileRight: 0.32, cheekSquintLeft: 0.22, cheekSquintRight: 0.22, eyeSquintLeft: 0.12, eyeSquintRight: 0.12 },
  sad: { browInnerUp: 0.38, browDownLeft: 0.08, browDownRight: 0.08, mouthFrownLeft: 0.18, mouthFrownRight: 0.18, eyeSquintLeft: 0.06, eyeSquintRight: 0.06 },
  surprised: { browInnerUp: 0.32, browOuterUpLeft: 0.38, browOuterUpRight: 0.38, eyeWideLeft: 0.28, eyeWideRight: 0.28 },
  angry: { browDownLeft: 0.38, browDownRight: 0.38, eyeSquintLeft: 0.18, eyeSquintRight: 0.18, noseSneerLeft: 0.14, noseSneerRight: 0.14, mouthPressLeft: 0.08, mouthPressRight: 0.08 },
  thinking: { browDownLeft: 0.16, browOuterUpRight: 0.24, browInnerUp: 0.06, eyeSquintLeft: 0.1, eyeSquintRight: 0.06, mouthPressLeft: 0.06, mouthPressRight: 0.06 },
};
/** One knob for how strong every expression is (1 = the table above). */
const STRENGTH = 1.6;
const MOUTH = /^mouth/;
const TALKING_MOUTH = 0.5;
const EASE_S = 0.1;
/** How long a reply's feeling stays after its speech ends. */
const HOLD_S = 1.2;
const BLINK_S = 0.16;
const BLINK_GAP_S = [2, 6];
const DOUBLE_BLINK = 0.15;

export class Mood {
  /** Whether feelings are shown; blinks happen either way. */
  readonly #expressive: boolean;
  #emotion: Emotion = "neutral";
  #rest: Rest = "neutral";
  #quietSince = 0;
  #current: Shape = {};
  #last = 0;
  #nextBlink = 0;
  #blinks: number[] = [];

  constructor(expressive: boolean) {
    this.#expressive = expressive;
  }

  set(emotion: Emotion) {
    if (this.#expressive) this.#emotion = emotion;
  }

  setRest(rest: Rest) {
    if (this.#expressive) this.#rest = rest;
  }

  /** Adds the expression and blinks to `face` (the lip-sync frame, 0..1), in place. */
  apply(face: Shape, talking: boolean) {
    const now = performance.now() / 1000;
    const dt = this.#last ? Math.min(0.1, now - this.#last) : 0;
    this.#last = now;
    if (talking) this.#quietSince = now;
    else if (this.#emotion !== "neutral" && now - this.#quietSince > HOLD_S) this.#emotion = "neutral";

    const feeling = this.#emotion !== "neutral" ? this.#emotion : this.#rest;
    const preset = PRESETS[feeling];
    const k = dt ? 1 - Math.exp(-dt / EASE_S) : 1;
    const target: Shape = {};
    for (const [name, v] of Object.entries(preset)) target[name] = v * STRENGTH;
    for (const name of new Set([...Object.keys(this.#current), ...Object.keys(target)])) {
      const v = (this.#current[name] ?? 0) + ((target[name] ?? 0) - (this.#current[name] ?? 0)) * k;
      if (v < 0.001 && !target[name]) delete this.#current[name];
      else this.#current[name] = v;
    }
    for (const [name, v] of Object.entries(this.#current)) {
      const add = MOUTH.test(name) && talking ? v * TALKING_MOUTH : v;
      face[name] = Math.min(1, (face[name] ?? 0) + add);
    }

    const blink = this.#blink(now);
    face.eyeBlinkLeft = Math.max(face.eyeBlinkLeft ?? 0, blink);
    face.eyeBlinkRight = Math.max(face.eyeBlinkRight ?? 0, blink);
  }

  /** How closed the eyes are right now. */
  #blink(now: number) {
    if (now >= this.#nextBlink) {
      this.#blinks = Math.random() < DOUBLE_BLINK ? [now, now + BLINK_S + 0.08] : [now];
      this.#nextBlink = now + BLINK_GAP_S[0] + Math.random() * (BLINK_GAP_S[1] - BLINK_GAP_S[0]);
    }
    for (const at of this.#blinks) {
      const p = (now - at) / BLINK_S;
      if (p >= 0 && p < 1) return Math.sin(p * Math.PI);
    }
    return 0;
  }
}
