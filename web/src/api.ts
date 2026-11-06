// Talks to the local server. Every request carries the per-launch token the
// server put in the page, so other websites can't use it.

import type { Status, Voice } from "../../shared/protocol";

const token = document.querySelector<HTMLMetaElement>('meta[name="live-token"]')?.content ?? "";

async function request(path: string, init: RequestInit = {}) {
  const res = await fetch(path, { ...init, headers: { "X-Live-Token": token, ...init.headers } });
  if (res.status === 401) {
    location.reload(); // the server restarted with a new token
    throw new Error("Reconnecting…");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Something went wrong (${res.status}).`);
  }
  return res;
}

export const fetchStatus = async (): Promise<Status> => (await request("/api/status")).json();

/** Omni's TTS: a WAV of `text` in `voice`. */
export async function speakAudio(text: string, voice: Voice, signal?: AbortSignal): Promise<Blob> {
  const res = await request("/api/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice }),
    signal,
  });
  return res.blob();
}

export const callURL = () => `ws://${location.host}/call?t=${token}`;
