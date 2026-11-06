// A small JSON file store. Writes are atomic (temp file, then rename).

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

export class JsonStore<T extends object> {
  readonly #file: string;
  readonly #fallback: T;

  constructor(name: string, fallback: T) {
    this.#file = path.join(config.dataDir, name);
    this.#fallback = fallback;
  }

  read(): T {
    try {
      return JSON.parse(fs.readFileSync(this.#file, "utf8"));
    } catch {
      return structuredClone(this.#fallback);
    }
  }

  write(value: T) {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.writeFileSync(`${this.#file}.tmp`, JSON.stringify(value, null, 2));
    fs.renameSync(`${this.#file}.tmp`, this.#file);
  }

  update(change: (value: T) => void) {
    const value = this.read();
    change(value);
    this.write(value);
  }
}
