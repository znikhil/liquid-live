// Resumable downloads: data goes to `<dest>.part`, which is renamed when complete,
// so an interrupted setup picks up where it stopped.

import fs from "node:fs";
import path from "node:path";

export type Progress = (done: number, total: number) => void;

export async function download(url: string, dest: string, onProgress?: Progress) {
  if (fs.existsSync(dest)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let start = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const res = await fetch(url, { headers: start ? { Range: `bytes=${start}-` } : {} });
  if (res.status === 416) return fs.renameSync(part, dest); // the .part was already complete
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
  if (res.status !== 206) start = 0;
  const total = start + (Number(res.headers.get("content-length")) || 0);
  const file = fs.createWriteStream(part, { flags: start ? "a" : "w" });
  let done = start;
  try {
    for await (const chunk of res.body) {
      done += chunk.length;
      if (!file.write(chunk)) await new Promise<void>((r) => file.once("drain", () => r()));
      onProgress?.(done, total);
    }
    await new Promise<void>((resolve, reject) => file.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) {
    file.destroy();
    throw e;
  }
  fs.renameSync(part, dest);
}
