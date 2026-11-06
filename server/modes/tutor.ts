// English tutor: a patient speaking partner. It opens the call by asking what
// the user would like to talk about, follows the topic they choose (and any
// change of topic), and gently corrects one clear mistake at a time. Each
// sentence the user says is checked by its own focused request, run alongside
// the reply: one small model asked to chat and proofread at once missed most
// mistakes and buried the tip mid-reply. Between calls it remembers a few facts
// about the user (written by the model) and their recent mistakes (exactly as
// corrected), so the next call can pick up from the last.

import type { Brain } from "../models/brain.ts";
import { JsonStore } from "../store.ts";
import { asMessages, SPOKEN, type Line, type ModeContext, type ModeDefinition } from "./mode.ts";

type Correction = { said: string; fixed: string };
type Memory = { facts?: string[]; mistakes?: Correction[]; calls?: number; updated?: number };
const store = new JsonStore<Memory>("tutor-memory.json", {});
const MAX_FACTS = 6;
const MAX_MISTAKES = 6;
/** The few mistakes the tutor is told about at the start of a call. */
const RECENT_MISTAKES = 3;
/** Shorter answers ("Travel", "Yes, sure") aren't worth correcting. */
const MIN_CHECK_WORDS = 4;

// Small models follow examples better than rules. Answering with the sentence
// unchanged when it's correct (rather than "OK") kept it from chatting back.
const CHECK = `You are an English teacher checking the last sentence a student said out loud. Use the conversation only to know whether the student is talking about the past.
If the sentence has a clear grammar mistake, reply with the corrected sentence only, changing as little as possible.
If it is correct, reply with the sentence unchanged.

Examples:
I go to the cinema yesterday. -> I went to the cinema yesterday.
He play football every weekend. -> He plays football every weekend.
(about last summer) We go to the beach and swim every day. -> We went to the beach and swam every day.
I am going to the gym every morning. -> I go to the gym every morning.
I really enjoyed the concert. -> I really enjoyed the concert.
What do you like to eat? -> What do you like to eat?`;

const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}']+/gu) ?? [];

/** The corrected sentence in the checker's answer, without any note it adds after it. */
function correctedSentence(answer: string) {
  // It sometimes copies the examples' "sentence -> fix" form: keep what follows the arrow.
  const line = answer.trim().split("\n")[0].split(/->|→/).at(-1)!.trim();
  // ...and drop an echo of the question's label ("Student's last sentence:").
  const answerOnly = line.replace(/^.*\blast sentence:\s*/i, "").replace(/^["“]/, "");
  const sentence = answerOnly.split(/\s\(/)[0].match(/^.*?[.!?](?=\s|$)/)?.[0] ?? answerOnly;
  return sentence.replace(/[*_`"“”]+/g, "").trim();
}

/** A correction changes a few words in place; more edits than this is a rephrase of a sentence that was fine. */
const MAX_EDITS = 3;
/** "don't" -> "does not" adds a word; more than that means the model added its own words. */
const MAX_ADDED_WORDS = 1;
/** Swapping only these is a change of point of view ("my" -> "your"), never a grammar fix. */
const PRONOUNS = new Set(["i", "me", "my", "mine", "you", "your", "yours", "we", "us", "our", "he", "him", "his", "she", "her", "they", "them", "their"]);

/** Word-level edit distance: how many words to insert, delete or replace to turn `a` into `b`. */
function edits(a: string[], b: string[]) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** Whether `fixed` is a real correction of `said`: a few words changed in place, nothing added, not just a pronoun swap. */
function corrects(fixed: string, said: string) {
  const before = words(said);
  const after = words(fixed);
  const n = edits(before, after);
  if (n === 0 || n > MAX_EDITS || after.length - before.length > MAX_ADDED_WORDS) return false;
  const changed = [...before.filter((w) => !after.includes(w)), ...after.filter((w) => !before.includes(w))];
  return !changed.every((w) => PRONOUNS.has(w));
}

/** The checker's version of `sentence` (unchanged when it found nothing). */
async function check(sentence: string, context: string, brain: Brain, signal: AbortSignal) {
  const answer = await brain.ask(
    [{ role: "system", content: CHECK }, { role: "user", content: `Conversation so far:\n${context || "(none)"}\n\nStudent's last sentence: ${sentence}` }],
    { signal, temperature: 0, maxTokens: 80 },
  );
  return correctedSentence(answer) || sentence;
}

/**
 * The corrected sentence when the user's sentence has a clear mistake, else
 * null. A correction is checked once more, because the small model sometimes
 * fixes one verb of two ("We visited Kyoto and we eat").
 */
async function correctionFor(text: string, history: Line[], brain: Brain, signal: AbortSignal): Promise<Correction | null> {
  if (words(text).length < MIN_CHECK_WORDS) return null;
  const context = history.slice(-3).map((l) => `${l.role === "user" ? "Student" : "Teacher"}: ${l.text.slice(0, 300)}`).join("\n");
  let fixed = await check(text, context, brain, signal);
  if (!corrects(fixed, text)) return null;
  const again = await check(fixed, context, brain, signal);
  if (corrects(again, text) && edits(words(again), words(fixed)) > 0) fixed = again;
  return { said: text, fixed: fixed.replace(/[.!]+$/, "") };
}

const FACTS = `You keep short notes about a student for their English teacher. Merge the old notes and the new conversation into at most ${MAX_FACTS} short lines. Only write what the student said about their own life and interests. Never copy the teacher's questions or tips, and leave out grammar.
Write every line about "the student", like these examples:
- The student went to Japan with a brother last year and loved the ramen in Kyoto.
- The student works as a nurse and wants to work abroad.
Reply with the lines only.`;

/**
 * The model's lines about the student. Lines that copy the student's own words
 * ("I", "my"), guess the student's gender, or slip in a question, a tip or a
 * mistake are dropped.
 */
const factLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim().replace(/^-\s*/, ""))
    .filter((l) => /^the student\b/i.test(l) && !/\?|\b(i|my|me|we|our|he|him|his|she|her|hers|tips?|teacher|mistakes?|correct\w*)\b/i.test(l))
    .slice(0, MAX_FACTS);

/** Keeps a reply short in code, since the model drifts longer as a call goes on: up to its first question, at most three sentences. */
function shorten(reply: string) {
  const sentences = reply.match(/[^.!?]+[.!?]+["')]*\s*/g) ?? [reply];
  const question = sentences.findIndex((s) => s.trim().endsWith("?"));
  const keep = question >= 0 && question < 3 ? question + 1 : 2;
  return sentences.slice(0, keep).join("").trim() || reply;
}

/** What the tutor remembers, as it reads it at the start of a call ("" for a first call). */
function remembered({ facts = [], mistakes = [] }: Memory) {
  const parts = [];
  if (facts.length) parts.push(`What you remember about the user from earlier calls:\n${facts.map((f) => `- ${f}`).join("\n")}`);
  const recent = mistakes.slice(-RECENT_MISTAKES);
  if (recent.length) parts.push(`Mistakes the user made before (help them practise these naturally):\n${recent.map((m) => `- "${m.said}" should be "${m.fixed}"`).join("\n")}`);
  return parts.join("\n");
}

function persona(name: string, memory: string) {
  return [
    `You are ${name}, a warm, patient English speaking partner. The user is practising spoken English with you.`,
    "At the start of the call you ask what the user would like to talk about. Talk about the topic they choose, and if they want to change topic, follow them.",
    "Keep every reply to one or two short spoken sentences so the user does most of the talking, and end with exactly one simple question that keeps the conversation going.",
    "Don't correct the user's English yourself: corrections are added separately.",
    SPOKEN,
    memory || "This is your first call together.",
  ].join("\n");
}

export const tutor: ModeDefinition = {
  info: {
    id: "tutor",
    title: "English tutor",
    description: "Practise speaking on any topic you like. It corrects one mistake at a time and remembers you.",
    needsBrain: true,
  },

  open({ name, brain, signal }: ModeContext) {
    const memory = store.read();
    const known = remembered(memory);
    const system = persona(name, known);
    /** This call's corrections, saved for the next call. */
    const corrections: Correction[] = [];
    return {
      instructions: system,
      answers: true,

      opener: () =>
        brain.say(
          [
            { role: "system", content: system },
            {
              role: "user",
              content: known
                ? "(The call just started. Greet the user warmly and briefly, and ask what they would like to talk about today. You may mention one thing you remember about them.)"
                : "(The call just started. Greet the user warmly and briefly, say you'll practise speaking English together, and ask what they would like to talk about today, for example their day, travel, food or work.)",
            },
          ],
          { signal },
        ),

      async answer(text: string, history: Line[]) {
        const [correction, reply] = await Promise.all([
          correctionFor(text, history, brain, signal),
          brain.say([{ role: "system", content: system }, ...asMessages(history), { role: "user", content: text }], { signal }),
        ]);
        if (!reply) return null;
        if (!correction) return shorten(reply);
        corrections.push(correction);
        return `Small tip: say "${correction.fixed}". ${shorten(reply)}`;
      },

      async end(transcript: Line[]) {
        if (!transcript.some((l) => l.role === "user")) return;
        const said = transcript.map((l) => `${l.role === "user" ? "Student" : "Teacher"}: ${l.text.slice(0, 300)}`).join("\n").slice(-6000);
        const old = (memory.facts ?? []).map((f) => `- ${f}`).join("\n");
        // Runs after the call has closed, so it isn't tied to the call's signal.
        const facts = factLines(await brain.ask([{ role: "system", content: FACTS }, { role: "user", content: `Old notes:\n${old || "(none)"}\n\nNew conversation:\n${said}` }], { maxTokens: 300 }));
        store.update((saved) => {
          if (facts.length) saved.facts = facts;
          saved.mistakes = [...(saved.mistakes ?? []), ...corrections].slice(-MAX_MISTAKES);
          saved.calls = (saved.calls ?? 0) + 1;
          saved.updated = Date.now();
        });
      },
    };
  },
};
