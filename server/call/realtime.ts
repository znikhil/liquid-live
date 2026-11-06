// What answers in a call (the Responder): Omni's realtime session, which hears
// and speaks itself, or the brain (brain-responder.ts), which answers the
// transcript in text for a text-to-speech voice. Both follow one rule: only one
// response at a time; asking for another while one runs queues it until the
// current one ends.
//
// OmniRealtime is a thin, typed wrapper around Omni's realtime WebSocket
// (llama.cpp's OpenAI-style /v1/realtime).

import WebSocket from "ws";

/** The upstream events the call reacts to; the rest are ignored. */
export type RealtimeEvent =
  | { type: "session.created"; session?: { audio?: { input?: { format?: { rate?: number } }; output?: { format?: { rate?: number } } } } }
  | { type: "response.output_text.delta"; delta?: string }
  | { type: "response.output_audio.delta"; delta?: string }
  | { type: "response.done"; response?: { status?: string } }
  | { type: "error"; error?: { message?: string } };

export type RealtimeHandlers = {
  event(event: RealtimeEvent): void;
  /** A response was requested (now, or when a queued one starts). */
  responseStarted(): void;
  error(message: string): void;
  closed(): void;
};

export type SessionConfig = {
  instructions: string;
  output_modalities: ("text" | "audio")[];
  max_output_tokens: number;
};

/** What the call needs from whatever answers it. */
export interface Responder {
  readonly responding: boolean;
  configure(session: SessionConfig): void;
  appendAudio(pcm: Buffer): void;
  /** The appended audio becomes the user's turn. */
  commitAudio(): void;
  clearAudio(): void;
  addUserText(text: string): void;
  /** A reply was given without the responder (read by a text-to-speech voice): keep it in mind. */
  noteExchange(heard: string, reply: string): void;
  respond(): void;
  cancel(): void;
  /** Call on response.done. Returns true when a queued response started in its place. */
  settle(): boolean;
  close(): void;
}

export class OmniRealtime implements Responder {
  readonly #ws: WebSocket;
  readonly #on: RealtimeHandlers;
  #responding = false;
  #queued = false;

  constructor(url: string, handlers: RealtimeHandlers) {
    this.#on = handlers;
    this.#ws = new WebSocket(url);
    this.#ws.on("message", (data) => {
      try {
        this.#on.event(JSON.parse(String(data)));
      } catch (e) {
        this.#on.error(e instanceof Error ? e.message : String(e));
      }
    });
    this.#ws.on("error", () => this.#on.error("Couldn't reach Omni's voice service."));
    this.#ws.on("close", () => this.#on.closed());
  }

  get responding() {
    return this.#responding;
  }

  configure(session: SessionConfig) {
    this.#send({ type: "session.update", session });
  }

  appendAudio(pcm: Buffer) {
    this.#send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
  }

  /** The appended audio becomes the user's turn. */
  commitAudio() {
    this.#send({ type: "input_audio_buffer.commit" });
  }

  clearAudio() {
    this.#send({ type: "input_audio_buffer.clear" });
  }

  addUserText(text: string) {
    this.#send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  }

  noteExchange(heard: string, reply: string) {
    this.addUserText(`(${heard ? `The user said: "${heard}"\n` : ""}You replied: "${reply}")`);
  }

  /** Asks for a reply now, or right after the current one. */
  respond() {
    if (this.#responding) {
      this.#queued = true;
      return;
    }
    this.#responding = true;
    this.#send({ type: "response.create" });
    this.#on.responseStarted();
  }

  cancel() {
    this.#queued = false;
    if (this.#responding) this.#send({ type: "response.cancel" });
  }

  /** Call on response.done. Returns true when a queued response started in its place. */
  settle() {
    this.#responding = false;
    if (!this.#queued) return false;
    this.#queued = false;
    this.respond();
    return true;
  }

  close() {
    this.#ws.close();
  }

  #send(event: object) {
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(event));
  }
}
