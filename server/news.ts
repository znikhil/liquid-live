// Live web search with Tavily (https://tavily.com), for news and other things
// that change: today's headlines, scores, weather, prices. Optional: it is off
// unless TAVILY_API_KEY is set, and it is the only part of the app that sends
// anything off this computer (the question being searched).
//
// "fast" depth answered in 0.7-0.85 s from a laptop, against 1.6-3.3 s for
// "basic", with equally relevant results for short spoken questions.

import { config } from "./config.ts";

export type SearchResult = { title: string; content: string; url: string; published?: string };

const ENDPOINT = "https://api.tavily.com/search";
const RESULTS = 3;
const TIMEOUT_MS = 6000;

export const newsAvailable = () => config.tavilyKey !== "";

/** Searches the web; `news` uses Tavily's news index (fresher headlines). Returns [] on any failure. */
export async function searchWeb(
  query: string,
  { news = false, timeRange = "week", signal }: { news?: boolean; timeRange?: "day" | "week"; signal?: AbortSignal } = {},
): Promise<SearchResult[]> {
  if (!newsAvailable()) return [];
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.tavilyKey}` },
      // Recent news only (the past week, or day), so old headlines don't come back as "latest".
      body: JSON.stringify({ query, topic: news ? "news" : "general", search_depth: "fast", max_results: RESULTS, ...(news ? { time_range: timeRange } : {}) }),
      signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { results?: { title?: string; content?: string; url?: string; published_date?: string }[] };
    return (body.results ?? []).map((r) => ({ title: r.title ?? "", content: r.content ?? "", url: r.url ?? "", published: r.published_date }));
  } catch {
    return [];
  }
}
