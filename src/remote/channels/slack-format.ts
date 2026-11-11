/**
 * Slack text helpers for the remote channel: markdown -> mrkdwn converter, chunker and inbound decoder.
 * Slack docs: https://docs.slack.dev/messaging/formatting-message-text (escape `&`, `<`, `>` as `&amp;`, `&lt;`, `&gt;`;
 * links are `<url|label>`; bold is `*text*`; recommended text limit 4,000 chars).
 * Escaping `<` makes `<!channel>`, `<@U1>` and `<https://..>` in model text inert (no workspace-wide notification).
 */

/** Chunk size limit (Slack recommends at most 4,000 chars per message; margin for the fence repair). */
export const SLACK_CHUNK_LIMIT = 3500;

const FENCE = "```";

/** Escape the three control characters of Slack text. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inverse of `escapeSlack` plus Slack link and mention syntax, for text received from Slack. */
export function decodeSlackInbound(text: string): string {
  return text
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]*)>/g, (_m, url: string, label: string) => (label ? `${label} (${url})` : url))
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, "@$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Number of fence markers on a line: a fence opens or closes only on an odd count. */
const fenceCount = (line: string): number => line.split(FENCE).length - 1;

/** Convert one raw line outside code fences: escape everything; inline code spans are only escaped, other text is converted. */
function convertLine(line: string): string {
  return line
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? escapeSlack(part) : convertInline(escapeSlack(part))))
    .join("");
}

function convertInline(s: string): string {
  return s
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)|]+)\)/g, "<$2|$1>")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/__([^_\n]+)__/g, "*$1*");
}

/**
 * Markdown -> Slack mrkdwn: headings and `**bold**` -> `*bold*`, `[a](url)` -> `<url|a>`, `- item` -> bullet. Text inside code
 * fences and inline code keeps its formatting but `& < >` are escaped everywhere (Slack renders the entities as the characters),
 * so `<!channel>` is inert in code too. A line with fence markers is split at the markers. An unbalanced fence is closed at the end.
 */
export function toSlackMrkdwn(text: string): string {
  let inFence = false;
  const out = text.split("\n").map((line) => {
    const markers = fenceCount(line);
    if (markers > 0 || inFence) {
      // Segments alternate between code and text; the first one is code when a fence is already open.
      const converted = line
        .split(FENCE)
        .map((part, i) => ((i % 2 === 1) !== inFence ? escapeSlack(part) : convertLine(part)))
        .join(FENCE);
      if (markers % 2 === 1) inFence = !inFence;
      return converted;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) return `*${convertLine(heading[1]!).replace(/\*+/g, "").trim()}*`;
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) return `${bullet[1]}• ${convertLine(bullet[2]!)}`;
    return convertLine(line);
  });
  if (inFence) out.push(FENCE);
  return out.join("\n");
}

/** Move a cut point back so it is not inside an `&amp;`-style entity or a `<url|label>` link (when that leaves a non-empty chunk). */
function safeCut(rest: string, cut: number): number {
  const body = rest.slice(0, cut);
  let safe = cut;
  const lt = body.lastIndexOf("<");
  if (lt >= 0 && body.indexOf(">", lt) === -1) safe = lt;
  else {
    const entity = /&[a-z]{0,3}$/.exec(body);
    if (entity) safe = cut - entity[0].length;
  }
  return safe > 0 ? safe : cut;
}

/**
 * Split text into chunks of at most `limit` chars: at the last newline, else the last space, else a hard cut. A code fence open
 * at a cut is closed in that chunk and reopened in the next. The break character stays at the end of its chunk, so the chunks
 * joined equal the input (modulo the fence repair). Whitespace-only chunks are dropped.
 */
export function chunkSlackText(text: string, limit: number = SLACK_CHUNK_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  let inFence = false;
  while (rest.trim().length > 0) {
    const prefix = inFence ? `${FENCE}\n` : "";
    if (prefix.length + rest.length <= limit) {
      chunks.push(prefix + rest);
      break;
    }
    const budget = limit - prefix.length - FENCE.length - 1; // room to close a fence
    const window = rest.slice(0, budget);
    const nl = window.lastIndexOf("\n");
    const sp = window.lastIndexOf(" ");
    const cut = safeCut(rest, nl > 0 ? nl + 1 : sp > 0 ? sp + 1 : budget);
    let body = rest.slice(0, cut);
    rest = rest.slice(cut);
    for (const line of body.split("\n")) if (fenceCount(line) % 2 === 1) inFence = !inFence;
    if (inFence) body += `${body.endsWith("\n") ? "" : "\n"}${FENCE}`;
    if (body.trim().length > 0) chunks.push(prefix + body);
  }
  return chunks;
}
