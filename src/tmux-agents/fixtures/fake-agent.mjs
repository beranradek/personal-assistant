#!/usr/bin/env node
// Fake coding agent for the tmux integration test (no dependencies).
// Usage: node fake-agent.mjs <message-log-file> [work-ms]
//
// - Draws a Claude-like screen (spinner line, `esc to interrupt` footer only while busy, done line, empty `❯` prompt).
// - Enables bracketed paste; text between ESC[200~ and ESC[201~ is ONE message (CR inside counts as a newline).
// - Appends every submitted message as one JSON line to the log file.
// - `/exit` ends the process, except after the message `HANG`: then `/exit` and the first Ctrl-C are ignored.
import { appendFileSync } from "node:fs";

const logFile = process.argv[2];
const workMs = Number(process.argv[3] ?? 2000);
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const transcript = [];
let typed = "";
let pasted = "";
let pasting = false;
let busy = false;
let worked = false;
let hang = false;
let ignoredInterrupts = 0;
let workTimer;

function render() {
  const lines = [...transcript.slice(-15), ""];
  if (busy) lines.push("* Working… (1s)");
  else if (worked) lines.push("✻ Worked for 2s · done 12:00");
  lines.push("", `❯ ${typed.replace(/[\r\n]+/g, " ⏎ ")}`);
  lines.push(busy ? "  esc to interrupt" : "  ? for shortcuts");
  process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}\n`);
}

function finish(code) {
  process.stdout.write("\x1b[?2004l\x1b[?1049l");
  process.exit(code);
}

function submit(raw) {
  const message = raw.replace(/\r/g, "\n").trim();
  if (message === "") return;
  appendFileSync(logFile, `${JSON.stringify({ message })}\n`);
  if (message === "/exit") {
    if (!hang) finish(0);
    transcript.push("(ignoring /exit)");
    render();
    return;
  }
  if (message === "HANG") hang = true;
  busy = true;
  render();
  workTimer = setTimeout(() => {
    transcript.push(`● echo: ${message.replace(/\n/g, " | ")}`);
    busy = false;
    worked = true;
    render();
  }, workMs);
}

function interrupt() {
  if (hang && ignoredInterrupts++ === 0) return;
  if (busy) {
    clearTimeout(workTimer);
    busy = false;
    transcript.push("(interrupted)");
    render();
  }
}

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  let rest = chunk;
  while (rest.length > 0) {
    if (pasting) {
      const end = rest.indexOf(PASTE_END);
      if (end === -1) {
        pasted += rest;
        return;
      }
      pasted += rest.slice(0, end);
      typed += pasted;
      pasted = "";
      pasting = false;
      rest = rest.slice(end + PASTE_END.length);
    } else if (rest.startsWith(PASTE_START)) {
      pasting = true;
      rest = rest.slice(PASTE_START.length);
    } else {
      const ch = rest[0];
      rest = rest.slice(1);
      if (ch === "\r") {
        const message = typed;
        typed = "";
        submit(message);
      } else if (ch === "\x03") interrupt();
      else if (ch === "\x7f") typed = typed.slice(0, -1);
      else if (ch >= " " || ch === "\t") typed += ch;
    }
  }
  if (!busy) render();
});
process.on("SIGTERM", () => finish(0));

// Alternate screen: a full redraw leaves no stale lines in the tmux history that `capture-pane -S -N` reads.
process.stdout.write("\x1b[?1049h\x1b[?2004h");
render();
