import * as fs from "node:fs/promises";

export type SafeTextFileRead =
  | {
      ok: true;
      content: string;
      stat: { mtimeMs: number; size: number };
    }
  | {
      ok: false;
      reason: "not_regular_file" | "binary" | "unreadable";
    };

export function looksBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

export async function readTextFileSafely(filePath: string): Promise<SafeTextFileRead> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return { ok: false, reason: "not_regular_file" };
    }

    const buffer = await fs.readFile(filePath);
    if (looksBinary(buffer)) {
      return { ok: false, reason: "binary" };
    }

    return {
      ok: true,
      content: buffer.toString("utf-8"),
      stat: { mtimeMs: stat.mtimeMs, size: stat.size },
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}
