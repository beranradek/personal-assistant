export interface SanitizeResult {
  text: string;
  didSanitize: boolean;
}

const FORBIDDEN_MARKERS: RegExp[] = [
  /\bplanning\b/i,
  /\bthinking\b/i,
  /\bimplementing\b/i,
  /\bworklog\b/i,
  /\binternal worklog\b/i,
  /\binternal notes\b/i,
  /\bassessing\b/i,
  /\breviewing\b/i,
  /\bevaluating\b/i,
  /\bsearching\b/i,
  /\bdesigning\b/i,
  /\bexecuting\b/i,
  /\bupdating\b/i,
  /\bi need to\b/i,
  /\bi'?m considering\b/i,
  /\bi will now\b/i,
  /\blet'?s get started\b/i,
  /\bstill working\b/i,
  /\bworking on\b/i,
];

function isForbiddenText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return FORBIDDEN_MARKERS.some((re) => re.test(trimmed));
}

function extractHeadingText(paragraph: string): string | null {
  const trimmed = paragraph.trim();

  const mdHeading = /^#{1,6}\s+(.+)$/.exec(trimmed);
  if (mdHeading) return mdHeading[1]?.trim() ?? null;

  const boldOnly = /^\*\*([^*]+)\*\*$/.exec(trimmed);
  if (boldOnly) return boldOnly[1]?.trim() ?? null;

  return null;
}

function looksForbiddenParagraph(p: string): boolean {
  const trimmed = p.trim();
  if (!trimmed) return false;

  const headingText = extractHeadingText(trimmed);
  if (headingText != null) {
    return isForbiddenText(headingText);
  }

  return isForbiddenText(trimmed);
}

function splitParagraphs(text: string): string[] {
  return text
    .replaceAll("\r\n", "\n")
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter(Boolean);
}

function looksLikeAnswerStart(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  if (!trimmed) return false;
  if (looksForbiddenParagraph(trimmed)) return false;

  if (/\bradku\b/i.test(trimmed)) return true;

  // Prefer an actual sentence intro rather than a bare bullet list.
  const startsWithBullet =
    /^[-*]\s/.test(trimmed) ||
    /^\d+[\).\]]\s/.test(trimmed);
  if (startsWithBullet) return false;

  return trimmed.length >= 20;
}

/**
 * Best-effort sanitizer for Telegram final replies.
 *
 * If the model output contains internal worklog markers (Planning/Reviewing…),
 * try to keep only the tail portion that looks like the final answer.
 *
 * This is deterministic (no extra LLM calls) and intentionally conservative:
 * if we can't confidently extract a usable tail, we fall back to a short
 * “internal error” message instead of leaking a worklog.
 */
export function sanitizeTelegramFinalResponse(text: string): SanitizeResult {
  const raw = text.trim();
  if (!raw) return { text: "", didSanitize: false };

  const paragraphs = splitParagraphs(raw);
  const looksContaminated = paragraphs.some((p) => looksForbiddenParagraph(p));
  if (!looksContaminated) return { text: raw, didSanitize: false };

  const lastNonForbiddenIndex = (() => {
    for (let i = paragraphs.length - 1; i >= 0; i--) {
      if (!looksForbiddenParagraph(paragraphs[i] ?? "")) return i;
    }
    return null;
  })();

  if (lastNonForbiddenIndex == null) {
    return {
      text: "Omlouvám se, narazila jsem na interní chybu při generování odpovědi. Pošli prosím dotaz znovu.",
      didSanitize: true,
    };
  }

  let startIndex: number | null = null;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i] ?? "";
    if (looksLikeAnswerStart(p)) {
      startIndex = i;
      break;
    }
  }

  // If we couldn't find a confident "answer start" intro, fall back to the
  // last non-forbidden paragraph (e.g., bullet-only answers).
  if (startIndex == null) startIndex = lastNonForbiddenIndex;

  const extracted = paragraphs
    .slice(startIndex)
    .filter((p) => !looksForbiddenParagraph(p))
    .join("\n\n")
    .trim();

  if (extracted && !looksForbiddenParagraph(extracted)) {
    return { text: extracted, didSanitize: true };
  }

  return {
    text: "Omlouvám se, narazila jsem na interní chybu při generování odpovědi. Pošli prosím dotaz znovu.",
    didSanitize: true,
  };
}
