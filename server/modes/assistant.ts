// A friendly everyday assistant. Where each request goes is decided by d1-2B,
// Liquid's decision model, with word lists as the fallback when it isn't running.
// Small talk goes to Omni, which answers as soon as you stop talking. Questions that need working out (numbers, times, dates)
// or a careful answer (what, who, why, how) are answered by the everyday model
// from the transcript, so Omni can't mishear them ("Node.js" as "Not.js").
// With a Tavily key, questions about news and other things that change
// (scores, weather, prices) are searched on the web first; a short line is
// spoken at once so the search (~1 s) doesn't feel like silence.

import { config } from "../config.ts";
import type { Intent, Router } from "../models/router.ts";
import { searchWeb, type SearchResult } from "../news.ts";
import { asMessages, now, SPOKEN, type ModeDefinition, type Line, type ModeContext } from "./mode.ts";

/** Clock and calendar questions: answered from the computer's clock, never searched. */
const CLOCK = /\b(what time|time is it|what('s| is) the (time|date)|what day|today'?s date|how (long|many \w+) (until|till|left))\b/i;
/** Things that change and need a web search: news, results, weather, prices. */
const NEWS =
  /\b(news|headlines?|latest|right now|this (week|morning)|scores?|who won|winners?|elections?|weather|forecast|stocks?|price|market|happen(ed|ing)|box office|collections?|released?|launch(ed)?|trending|match(es)?|tournament|going on|twitter|reviews?|ratings?|rated)\b/i;
/** Asked for news itself (rather than, say, a price): search the news index, which is fresher. */
const HEADLINES = /\b(news|headlines?)\b/i;
/** Said at once while a search runs; varied so it doesn't sound canned. */
const HOLD_LINES = { news: ["Let me check the latest news.", "Let me see what's in the news."], other: ["One moment, let me look that up.", "Let me check that for you."] };
const pick = (lines: string[]) => lines[Math.floor(Math.random() * lines.length)];

/** Asked what's trending on a social network, whose live trends no web search can see. */
const SOCIAL_TRENDS = /\b(twitter|on x|tweets?|instagram|tiktok|reddit|youtube|social media)\b[\s\S]*\b(trend\w*|going on|happening|viral|latest|buzz)\b|\b(trend\w*|going on|happening|viral|buzz)\b[\s\S]*\b(twitter|on x|tweets?|instagram|tiktok|reddit|youtube|social media)\b/i;

type SearchPlan = { query: string; news: boolean; timeRange?: "day" | "week"; note?: string };

/**
 * What to search for a spoken question. Searched word for word, "Can you tell
 * me what is going on, Twitter?" found a tweet with that exact sentence, and
 * "trending on X today" found SEO pages listing evergreen "trending topics"
 * that the brain then read out as today's trends: social trend questions get
 * today's top news instead, with the brain told to say so.
 */
function searchPlan(text: string): SearchPlan {
  if (SOCIAL_TRENDS.test(text))
    return {
      query: "top news stories today",
      news: true,
      timeRange: "day",
      note: "The user asked what is trending on a social network. You can't see its live trends: say so in a few words, then name one or two of today's top stories from the results below as what people are talking about.",
    };
  const query =
    text
      .replace(/\b(can|could|would) you (please )?(tell me|let me know|check|find out)\b|\b(do you know|i want to know|please|hey|hi)\b/gi, "")
      .replace(/^[\s,]+|[\s,]+$/g, "")
      .trim() || text;
  return { query, news: HEADLINES.test(text) };
}

/** Words that mean the answer has to be worked out. */
const NEEDS_WORK =
  /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|twenty|hundred|thousand|million|half|quarter|how (many|much|long|far|old|fast)|calculate|math|percent|plus|minus|times|divided|multipl\w*|sum|total|average|time|o'clock|hours?|minutes?|seconds?|days?|weeks?|months?|years?|date|tomorrow|yesterday|midnight|noon|older|younger|convert|compare|difference|cheaper|faster|bigger|smaller)\b/i;
/** Questions to explain or look up. */
const QUESTION =
  /^\W*(and |so |but |okay,? |ok,? )?(what|who|whom|whose|which|why|how|when|where|explain|define|describe|tell me|can you (explain|tell))\b|\b(what|who|which|how) (is|are|was|were|does|do|did)\b/i;
/** Greetings and thanks (the whole sentence) stay with Omni, which answers them instantly. */
const SMALL_TALK =
  /^\W*((hi|hello|hey)\W*)?(hi|hello|hey|thanks|thank you( so much)?|okay|ok|bye|good (morning|afternoon|evening|night)|how are you( doing)?( today)?|how('s| is) (it going|your day)|what'?s up)?\W*$/i;

type Kind = "math" | "facts" | "news";

/** What each router intent means here; null: Omni answers (small talk, and the camera, which only Omni sees). */
const BY_INTENT: Record<Intent, (search: boolean) => Kind | null> = {
  small_talk: () => null,
  camera: () => null,
  math_time: () => "math",
  knowledge: () => "facts",
  current: (search) => (search ? "news" : "facts"),
};

/** `search`: live web search is on for this call. Asks the d1 router; word lists when it isn't running. */
async function kindOf(text: string, search: boolean, router: Router): Promise<Kind | null> {
  if (!text) return null;
  const decision = await router.decide(text);
  return decision ? BY_INTENT[decision.intent](search) : kindByWords(text, search);
}

/** The fallback without the router: word lists, which miss requests worded in new ways. */
function kindByWords(text: string, search: boolean): Kind | null {
  if (SMALL_TALK.test(text)) return null;
  if (CLOCK.test(text)) return "math";
  if (search && NEWS.test(text)) return "news";
  if (NEEDS_WORK.test(text)) return "math";
  if (QUESTION.test(text)) return "facts";
  return null;
}

/** The clock, worked out here: the small model often gets "time left today" wrong. */
function clockFacts() {
  const d = new Date();
  const left = 24 * 60 - (d.getHours() * 60 + d.getMinutes());
  return `Now: ${now()}. Time left until midnight: ${Math.floor(left / 60)} hours and ${left % 60} minutes.`;
}

const PROMPTS: Record<Kind, string> = {
  // Thinking mode is too slow for a call (12-22 s), so it writes a few lines of
  // working instead and only the part after "Answer:" is spoken.
  math: "You are a careful voice assistant. Solve the question in two parts:\nWork: a few short lines of step-by-step arithmetic.\nAnswer: one or two short spoken sentences with the result, plain words only.",
  facts: `You are a friendly, accurate voice assistant. Answer in one or two short spoken sentences. ${SPOKEN} If you aren't sure, say so.`,
  // Kept short on purpose: during a call the model shares the GPU with Omni and writes ~25 tokens/s.
  news: `You are a friendly voice assistant. Answer the question in at most two short spoken sentences (under 35 words), using only the web search results below. Give the answer directly: no lists, and never talk about the search or the results themselves. Only mention a date if the user asked when. If the results don't answer the question, say you couldn't find it. ${SPOKEN}`,
};

/** The search results as the everyday model reads them. */
const resultsBlock = (results: SearchResult[]) =>
  results.map((r, i) => `[${i + 1}] ${r.title}${r.published ? ` (${r.published})` : ""}\n${r.content.slice(0, 500)}`).join("\n\n");

/** The part of the model's answer worth saying out loud. */
function speakable(answer: string, kind: Kind) {
  const marked = /answer:/i.test(answer);
  const said = (marked ? answer.split(/answer:\s*/i).at(-1)! : answer)
    .replace(/^\s*(based on|according to) (the )?(web )?(search )?results,?\s*/i, "")
    .replace(/^\s*[-•]\s*/gm, "")
    .replace(/[*_`#]+/g, "")
    .replace(/\s*×\s*/g, " times ")
    .replace(/\s*÷\s*/g, " divided by ")
    .replace(/%/g, " percent")
    .replace(/\s*=\s*/g, " equals ")
    .replace(/\s+/g, " ")
    .trim();
  // Sentences end at . ! or ? followed by a space, so "416.5" stays whole.
  let sentences = said.split(/(?<=[.!?]["')]?)\s+/);
  if (kind === "news") {
    // The model sometimes talks about its sources ("Looking at result [3]") or reads out when a page was updated.
    const META = /\bresults?\b|\[\d+\]|\bI need to\b|\b(last )?updated\b|\bsearch\b/i;
    // Only talk about its sources: the results didn't give a clear answer.
    sentences = sentences.filter((s) => !META.test(s));
    if (!sentences.length) return "Sorry, I couldn't find a clear answer to that right now.";
    // A last sentence cut off by the token limit ("…Liverpool Wol") isn't said; a lone one is cut back to its last whole part.
    const finished = (s: string) => /[.!?]["')]?$/.test(s);
    if (sentences.length > 1 && !finished(sentences.at(-1)!)) sentences = sentences.slice(0, -1);
    else if (!finished(sentences[0])) sentences[0] = `${sentences[0].replace(/\s*\([^)]*$/, "").replace(/\s+\S*$/, "").replace(/[,;:\s]+$/, "")}.`;
    sentences = sentences.map((s) => s.replace(/\s*\[\d+\]/g, "").replace(/\p{Extended_Pictographic}/gu, "").trim());
    // A sentence that followed a dropped one may start "However," or "Also,".
    sentences[0] = sentences[0].replace(/^(however|also|so|but),?\s+(\w)/i, (_, __, c: string) => c.toUpperCase());
  }
  // Working without "Answer:" comes first, so the result is at the end.
  return (marked || kind !== "math" ? sentences.slice(0, 2) : sentences.slice(-2)).join(" ").trim();
}

export const assistant: ModeDefinition = {
  info: {
    id: "assistant",
    title: "Assistant",
    // The camera needs Omni, the only model here that sees.
    description: config.omniEnabled ? "Chat about anything, ask questions, or show it something on camera." : "Chat about anything, ask questions, or catch up on the news.",
    needsBrain: false,
  },

  open({ name, brain, router, search, signal }: ModeContext) {
    return {
      instructions: [
        `You are ${name}, a friendly voice assistant running privately on the user's computer.`,
        `${SPOKEN} Answer in one or two short sentences.`,
        // Asked "how are you", Omni tends to recite its model card.
        `Talk like a friendly person. When the user greets you or asks how you are, answer warmly and briefly, and don't describe yourself. Only when asked what you are, say you're ${name}, an assistant that runs on this computer.`,
        `Now: ${now()}.`,
      ].join("\n"),
      answers: brain.available,

      holdLine: async (text: string) =>
        brain.available && (await kindOf(text, search, router)) === "news" ? pick(HEADLINES.test(text) ? HOLD_LINES.news : HOLD_LINES.other) : null,

      async answer(text: string, history: Line[]) {
        const kind = await kindOf(text, search, router);
        if (!kind || !brain.available) return null;
        let system = `${PROMPTS[kind]}\n${clockFacts()}`;
        if (kind === "news") {
          const plan = searchPlan(text);
          const results = await searchWeb(plan.query, { news: plan.news, timeRange: plan.timeRange, signal });
          if (!results.length) return "Sorry, I couldn't find anything about that right now.";
          if (plan.note) system += `\n${plan.note}`;
          system += `\n\nWeb search results:\n${resultsBlock(results)}`;
        }
        const out = await brain.ask(
          [{ role: "system", content: system }, ...asMessages(history, 6), { role: "user", content: text }],
          { signal, temperature: kind === "math" ? 0 : 0.2, maxTokens: kind === "math" ? 400 : kind === "news" ? 90 : 160 },
        );
        return out ? speakable(out, kind) || null : null;
      },
    };
  },
};
