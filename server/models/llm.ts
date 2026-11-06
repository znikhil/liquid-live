// Client for llama.cpp's OpenAI-compatible chat API. Only local addresses are allowed.

import { isLocal } from "../config.ts";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: "wav" } };

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] };

export type CompletionOptions = {
  url: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

/** Streams the text of a chat completion. Thinking is always off: calls need quick answers. */
export async function* stream({ url, model, messages, temperature = 0.3, maxTokens = 512, signal }: CompletionOptions) {
  if (!isLocal(url)) throw new Error("Refusing a model address that isn't on this computer.");
  const res = await fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
      cache_prompt: true,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`The model returned an error (HTTP ${res.status}). ${body}`.slice(0, 400));
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      // Some servers (LM Studio) report a failure as a stream event rather than an HTTP error.
      if (event.error) throw new Error(`The model returned an error: ${String(event.error.message ?? event.error).slice(0, 300)}`);
      const delta = event.choices?.[0]?.delta;
      if (delta?.content) yield delta.content as string;
    }
  }
}

/** A whole completion as text. */
export async function complete(options: CompletionOptions) {
  let text = "";
  for await (const part of stream(options)) text += part;
  return text.trim();
}
