// Per-browser preferences in localStorage. Storage can be unavailable (private
// windows, blocked site data), so every read falls back and every write is best effort.

import { SPEECH_ENGINES, type SpeechEngine } from "../../shared/protocol";
import { isAvatarId, type AvatarId } from "./avatar/catalog";

type Pref<T> = { get(): T; set(value: T): void };

function pref<T>(key: string, fallback: T, valid: (v: unknown) => v is T): Pref<T> {
  return {
    get() {
      try {
        const raw = localStorage.getItem(key);
        const value = raw === null ? fallback : JSON.parse(raw);
        return valid(value) ? value : fallback;
      } catch {
        return fallback;
      }
    },
    set(value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
  };
}

const isString = (v: unknown): v is string => typeof v === "string";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

export type SelfPos = { x: number; y: number } | null;
export type ScriptVoice = "ai" | "me";

export const prefs = {
  mode: pref("live.mode", "assistant", isString),
  avatar: pref<AvatarId>("live.avatar", "aria", (v): v is AvatarId => isAvatarId(v)),
  emotions: pref("live.emotions", true, isBoolean),
  camera: pref("live.camera", false, isBoolean),
  /** Who speaks the replies: Omni's voice or a Woof voice (when the server has Woof). */
  speech: pref<SpeechEngine>("live.speech", "juno", (v): v is SpeechEngine => SPEECH_ENGINES.includes(v as SpeechEngine)),
  /** Live web search for news questions (Assistant), when the server has a Tavily key. */
  search: pref("live.search", true, isBoolean),
  /** Where you dragged your camera tile: 0..1 across and down the free space; null for the corner. */
  selfPos: pref<SelfPos>("live.selfPos", null, (v): v is SelfPos => v === null || (typeof v === "object" && typeof (v as { x: unknown }).x === "number")),
  script: pref("live.script", "", isString),
  scriptVoice: pref<ScriptVoice>("live.scriptVoice", "ai", (v): v is ScriptVoice => v === "ai" || v === "me"),
};
