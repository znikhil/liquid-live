// Scripted conversations: rehearse a dialogue line by line. "You:" lines are
// yours, "Agent:" lines are what the assistant says back word for word; leave
// an Agent line out and the assistant answers on its own.

import type { Voice } from "../../../shared/protocol";
import { speakAudio } from "../api";

export type ScriptTurn = { you: string; reply?: string };

const REPLY = /^\s*(agent|ai|avatar|bot|assistant|a)\s*:\s*/i;
const YOU = /^\s*(you|me|user|q)\s*:\s*/i;

export const SAMPLE_SCRIPT = `# "You:" lines are yours; "Agent:" lines are what the assistant says back.
# Leave out an Agent line and it answers on its own.
Agent: Hi! Welcome to the café. What can I get you today?
You: Could I have a medium latte, please?
Agent: Of course. Would you like regular milk or oat milk?
You: Oat milk, please. How much is that?
Agent: That's four dollars fifty. Anything else?
You: No, that's all. Thank you!
Agent: You're welcome. Have a lovely day!`;

/**
 * Reads a script. "Agent:" (or AI:, Avatar:, Bot:, A:) lines reply to the line
 * before; any other line, with or without "You:", is yours. Blank lines and #
 * comments are skipped. A reply before any line of yours opens the conversation.
 */
export function parseScript(text: string): ScriptTurn[] {
  const turns: ScriptTurn[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (REPLY.test(line)) {
      const reply = line.replace(REPLY, "").trim();
      const last = turns.at(-1);
      if (!last) turns.push({ you: "", reply });
      else last.reply = last.reply === undefined ? reply : `${last.reply} ${reply}`;
    } else turns.push({ you: line.replace(YOU, "").trim() });
  }
  return turns.filter((t) => t.you || t.reply);
}

/** One spoken line: 20 ms PCM16 frames at the call's input rate, and the audio to play. */
export type SpokenLine = { frames: Int16Array[]; audio: AudioBuffer };

/** Speaks `text` in `voice` and cuts it into microphone-sized frames at `rate`. */
export async function speakLine(text: string, voice: Voice, rate: number, signal: AbortSignal): Promise<SpokenLine> {
  const blob = await speakAudio(text, voice, signal);
  // A context at the call's input rate makes the browser do the resampling.
  const audio = await new OfflineAudioContext(1, 1, rate).decodeAudioData(await blob.arrayBuffer());
  const samples = audio.getChannelData(0);
  const size = Math.round(rate / 50);
  const frames: Int16Array[] = [];
  for (let i = 0; i < samples.length; i += size) {
    const frame = new Int16Array(size);
    for (let j = 0; j < size && i + j < samples.length; j++) {
      const s = Math.max(-1, Math.min(1, samples[i + j]));
      frame[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    frames.push(frame);
  }
  return { frames, audio };
}

/** Resolves after `ms`, or at once when `signal` aborts. */
export function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
}
