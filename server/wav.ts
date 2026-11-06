// PCM16 mono <-> WAV.

/** Wraps PCM16 mono samples in a WAV file. */
export function toWav(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** The samples of a WAV file (finds the data chunk; assumes PCM16 mono). */
export function pcmOf(wav: Buffer): Buffer {
  const at = wav.indexOf("data");
  return at >= 0 ? wav.subarray(at + 8) : wav.subarray(44);
}
