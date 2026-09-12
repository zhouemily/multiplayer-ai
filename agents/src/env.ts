import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function loadDotEnv(): void {
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      for (const line of readFileSync(candidate, "utf8").split("\n")) {
        const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

loadDotEnv();

export function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}
