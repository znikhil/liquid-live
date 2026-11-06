// The faces a call can have. Kept apart from lamHead.ts so the lobby can list
// them without loading the renderer (three.js).
//
// Both are photo-realistic Gaussian-splat heads made with LAM (Large Avatar
// Model), on the FLAME head model (non-commercial use only). Aria was generated
// for this app with LAM on our own GPU from a single AI-generated portrait;
// Marble is a sample from Alibaba's OpenAvatarChat.
// Their faces are driven by LAM A2E on the server.

import type { Emotion, Voice } from "../../../shared/protocol";
import type { Speaker } from "../audio/player";

export type AvatarProfile = {
  name: string;
  label: string;
  voice: Voice;
  /** The LAM head ZIP. */
  url: string;
};

export const AVATARS = {
  aria: { name: "Aria", label: "Aria", voice: "female", url: "/avatars/aria.zip" },
  marble: { name: "Marble", label: "Marble statue", voice: "female", url: "/avatars/marble.zip" },
} as const satisfies Record<string, AvatarProfile>;

export type AvatarId = keyof typeof AVATARS;
export const AVATAR_IDS = Object.keys(AVATARS) as AvatarId[];
export const isAvatarId = (id: unknown): id is AvatarId => typeof id === "string" && id in AVATARS;

/** What the call shows: listening between turns, hearing you talk, thinking before a reply. */
export type AvatarMood = "listening" | "hearing" | "thinking";

/** What a call needs from a face. */
export interface Avatar {
  readonly ready: Promise<void>;
  /** Plays the call's speech, moving the face in time with it. */
  speaker(rate: number): Promise<Speaker>;
  setMood(mood: AvatarMood): void;
  /** The feeling of the speech that comes next. */
  setEmotion(emotion: Emotion): void;
  dispose(): void;
}

/** ARKit's 52 face shapes, in the order LAM A2E outputs them. */
export const ARKIT = [
  "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
  "cheekPuff", "cheekSquintLeft", "cheekSquintRight",
  "eyeBlinkLeft", "eyeBlinkRight", "eyeLookDownLeft", "eyeLookDownRight",
  "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
  "eyeLookUpLeft", "eyeLookUpRight", "eyeSquintLeft", "eyeSquintRight",
  "eyeWideLeft", "eyeWideRight",
  "jawForward", "jawLeft", "jawOpen", "jawRight",
  "mouthClose", "mouthDimpleLeft", "mouthDimpleRight", "mouthFrownLeft", "mouthFrownRight",
  "mouthFunnel", "mouthLeft", "mouthLowerDownLeft", "mouthLowerDownRight",
  "mouthPressLeft", "mouthPressRight", "mouthPucker", "mouthRight",
  "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper",
  "mouthSmileLeft", "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight",
  "mouthUpperUpLeft", "mouthUpperUpRight",
  "noseSneerLeft", "noseSneerRight", "tongueOut",
] as const;
