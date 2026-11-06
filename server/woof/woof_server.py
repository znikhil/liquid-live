"""Underdog Woof text-to-speech as a tiny local HTTP service for Samvad AI.

Woof (https://huggingface.co/ConwayResearch/Underdog-Woof, non-commercial licence) runs on the CPU with numpy
only. The Node server starts this with: python3 -I woof_server.py --model <woof dir> --port <port>

  GET  /health                        -> 200 once the default voice is loaded
  POST /tts {"text": ..., "voice": ...} -> audio/wav (24 kHz mono PCM16), or 204 when no usable take was made

Requests are handled one at a time: a Woof model keeps state while it speaks, so it isn't safe to share between
threads, and one sentence takes ~0.3 s anyway.
"""
import argparse
import io
import json
import sys
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("--model", required=True, help="folder holding underdog_woof/ and woof_int8.npz")
ap.add_argument("--port", type=int, required=True)
args = ap.parse_args()
sys.path.insert(0, args.model)

import numpy as np  # noqa: E402
from underdog_woof import SR, VOICES, Woof  # noqa: E402

DEFAULT_VOICE = "juno"
MAX_TEXT = 600
# Woof sometimes doesn't stop (seen: 30 s of noise for a 62-character sentence). A take longer than this is redone
# with another seed; ~0.06 s per character is normal speech.
SECONDS_PER_CHAR = 0.11
SEEDS = (1, 7, 23)

voices = {}


def model(voice):
    if voice not in voices:
        voices[voice] = Woof(voice=voice)
    return voices[voice]


def speak(text, voice):
    """The first take of a sane length, or None."""
    limit = 1.0 + SECONDS_PER_CHAR * len(text)
    for seed in SEEDS:
        wav = model(voice)(text, seed=seed)
        if len(wav) / SR <= limit:
            return wav
    return None


def wav_bytes(x):
    pcm = (np.clip(x, -1, 1) * 32767).round().astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body=b"", kind="text/plain"):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send(200, b"ok") if self.path == "/health" else self._send(404)

    def do_POST(self):
        if self.path != "/tts":
            return self._send(404)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
            text = str(body.get("text", "")).strip()[:MAX_TEXT]
            voice = body.get("voice") if body.get("voice") in VOICES else DEFAULT_VOICE
        except (ValueError, TypeError):
            return self._send(400, b"bad request")
        if not text:
            return self._send(400, b"nothing to say")
        wav = speak(text, voice)
        if wav is None:
            return self._send(204)
        self._send(200, wav_bytes(wav), "audio/wav")


model(DEFAULT_VOICE)  # load before answering /health, so the first sentence isn't slow
HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
