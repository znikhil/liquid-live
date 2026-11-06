// LFM3 Omni 2B outside the realtime session: hearing (ASR), seeing and speaking (TTS).
// These requests use Omni's second slot, so they run alongside a call.

import { isLocal } from "../config.ts";
import type { Voice } from "../../shared/protocol.ts";
import { complete } from "./llm.ts";
import { modelName, modelURL } from "./runtime.ts";

const omni = () => ({ url: modelURL("omni"), model: modelName("omni"), temperature: 0 });

/** The words in a WAV recording (16 kHz mono is best). */
export async function transcribe(wav: Buffer, { signal }: { signal?: AbortSignal } = {}) {
  const text = await complete({
    ...omni(),
    signal,
    maxTokens: 512,
    messages: [
      { role: "system", content: "Perform ASR in English." },
      { role: "user", content: [{ type: "input_audio", input_audio: { data: wav.toString("base64"), format: "wav" } }] },
    ],
  });
  return text.replace(/^["“]|["”]$/g, "").trim();
}

/** Answers `question` about a picture. */
export function look(jpeg: Buffer, question: string, { signal }: { signal?: AbortSignal } = {}) {
  return complete({
    ...omni(),
    signal,
    maxTokens: 300,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
          { type: "text", text: question },
        ],
      },
    ],
  });
}

/** Speaks `text`. Returns a 24 kHz mono WAV. */
export async function speak(text: string, voice: Voice, { signal }: { signal?: AbortSignal } = {}) {
  const base = new URL(modelURL("omni")).origin;
  if (!isLocal(base)) throw new Error("Refusing a model address that isn't on this computer.");
  const res = await fetch(`${base}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, voice }),
    signal,
  });
  if (!res.ok) throw new Error(`Speech failed (HTTP ${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}
