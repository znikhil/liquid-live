// `npm run setup [-- --size small|balanced|best]`: downloads the llama.cpp
// engine and the models once. Parts already on disk are skipped, and an
// interrupted download resumes. Everything goes to the data folder.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { download, type Progress } from "./download.ts";
import { findFile, isSize, PARTS, SIZES, type Size } from "./parts.ts";

const ENGINE_ASSET =
  process.platform === "darwin" ? `bin-macos-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz` : `bin-ubuntu-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`;

function sizeArg(): Size {
  const i = process.argv.indexOf("--size");
  const value = i >= 0 ? process.argv[i + 1] : "balanced";
  if (!isSize(value)) {
    console.error(`Unknown size "${value}". Use one of: ${Object.keys(SIZES).join(", ")}.`);
    process.exit(1);
  }
  return value;
}

/** A one-line progress bar that redraws in place. */
function bar(name: string): Progress {
  let last = 0;
  return (done, total) => {
    if (Date.now() - last < 200 && done < total) return;
    last = Date.now();
    const pct = total ? Math.floor((done / total) * 100) : 0;
    const filled = Math.round(pct / 4);
    process.stdout.write(`\r    ${name.padEnd(36).slice(0, 36)} [${"#".repeat(filled)}${" ".repeat(25 - filled)}] ${String(pct).padStart(3)}%  ${(done / 1e6).toFixed(0)} MB`);
  };
}

async function installEngine() {
  const res = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10", { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`Couldn't reach GitHub (HTTP ${res.status}).`);
  const releases = (await res.json()) as { assets?: { name: string; browser_download_url: string }[] }[];
  const asset = releases.flatMap((r) => r.assets ?? []).find((a) => a.name.endsWith(ENGINE_ASSET));
  if (!asset) throw new Error(`No llama.cpp build (${ENGINE_ASSET}) was found for this computer.`);
  const archive = path.join(config.dataDir, "llama.tar.gz");
  await download(asset.browser_download_url, archive, bar(asset.name));
  process.stdout.write("\n");
  fs.rmSync(config.engineDir, { recursive: true, force: true });
  fs.mkdirSync(config.engineDir, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", config.engineDir]);
  fs.rmSync(archive, { force: true });
  if (!findFile(config.engineDir, "llama-server")) throw new Error("The download didn't contain llama-server.");
}

/** Downloads a .tar.bz2 and unpacks it into `into`. */
async function installArchive({ url, into }: { url: string; into: string }) {
  const archive = path.join(config.dataDir, path.basename(new URL(url).pathname));
  await download(url, archive, bar(path.basename(archive)));
  process.stdout.write("\n    Unpacking…\n");
  fs.mkdirSync(into, { recursive: true });
  execFileSync("tar", ["-xjf", archive, "-C", into]);
  fs.rmSync(archive, { force: true });
}

async function main() {
  const size = sizeArg();
  console.log(`Setting up Samvad AI in ${config.dataDir}`);
  console.log(`Model size: ${SIZES[size].label}\n`);
  for (const part of PARTS) {
    if (part.needed && !part.needed()) {
      console.log(`  – ${part.title}: not needed with this setup`);
      continue;
    }
    if (part.installed()) {
      console.log(`  ✓ ${part.title}`);
      continue;
    }
    console.log(`  ↓ ${part.title}`);
    if (part.id === "engine") await installEngine();
    else if (part.archive) await installArchive(part.archive);
    else
      for (const file of part.files(size)) {
        await download(file.url, file.dest, bar(path.basename(file.dest)));
        process.stdout.write("\n");
      }
  }
  // Woof runs in Python; say how to get numpy rather than failing later.
  try {
    execFileSync(config.python, ["-I", "-c", "import numpy"], { stdio: "ignore" });
  } catch {
    console.log(`\n  Note: the Woof voice needs ${config.python} with numpy (pip install numpy).`);
  }
  console.log("\nAll set. Start the app with: npm start");
}

main().catch((e) => {
  console.error(`\n\nSetup stopped: ${e instanceof Error ? e.message : e}`);
  console.error("Run `npm run setup` again to continue where it left off.");
  process.exit(1);
});
