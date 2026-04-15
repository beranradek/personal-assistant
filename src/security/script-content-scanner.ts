import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validatePath } from "./path-validator.js";

export interface ScriptContentPolicy {
  enabled: boolean;
  /** Max bytes to read from a script file. */
  maxBytes: number;
  /** Block `... | bash` / `bash` with no file operand. */
  denyStdinExecution: boolean;
  /** Block when script file does not exist at validation time. */
  denyMissingScriptFile: boolean;
  /** Scan inline `bash -c '...'` script text. */
  scanInline: boolean;
}

const DEFAULT_POLICY: ScriptContentPolicy = {
  enabled: true,
  maxBytes: 200_000,
  denyStdinExecution: true,
  denyMissingScriptFile: true,
  scanInline: true,
};

function getPolicy(
  security: Record<string, unknown> | undefined,
): ScriptContentPolicy {
  const raw = (security?.scriptContentPolicy ?? {}) as Record<string, unknown>;
  return {
    enabled:
      typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_POLICY.enabled,
    maxBytes:
      typeof raw.maxBytes === "number" && Number.isFinite(raw.maxBytes) && raw.maxBytes > 0
        ? Math.floor(raw.maxBytes)
        : DEFAULT_POLICY.maxBytes,
    denyStdinExecution:
      typeof raw.denyStdinExecution === "boolean"
        ? raw.denyStdinExecution
        : DEFAULT_POLICY.denyStdinExecution,
    denyMissingScriptFile:
      typeof raw.denyMissingScriptFile === "boolean"
        ? raw.denyMissingScriptFile
        : DEFAULT_POLICY.denyMissingScriptFile,
    scanInline:
      typeof raw.scanInline === "boolean" ? raw.scanInline : DEFAULT_POLICY.scanInline,
  };
}

// ---------------------------------------------------------------------------
// Tokenization + segmentation (simple, fail-safe)
// ---------------------------------------------------------------------------

function extractSegments(commandString: string): string[] {
  const segments: string[] = [];
  const chainedParts = commandString.split(/\s*(?:&&|\|\|)\s*/);
  for (const part of chainedParts) {
    const semiParts = part.split(/\s*;\s*/);
    for (const semi of semiParts) {
      const pipeParts = semi.split(/\s*\|\s*/);
      for (const pipe of pipeParts) {
        const trimmed = pipe.trim();
        if (trimmed) segments.push(trimmed);
      }
    }
  }
  return segments;
}

function shellTokenize(input: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      i++;
      continue;
    }

    if (inDouble) {
      if (ch === '"') inDouble = false;
      else current += ch;
      i++;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      i++;
      continue;
    }
    current += ch;
    i++;
  }

  if (inSingle || inDouble) return null;
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function basenameMaybe(cmd: string): string {
  try {
    return path.basename(cmd);
  } catch {
    return cmd;
  }
}

// ---------------------------------------------------------------------------
// Content scanning (high-confidence blocklist)
// ---------------------------------------------------------------------------

const FORBIDDEN_PATH_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\/etc\/passwd\b/, label: "/etc/passwd" },
  { re: /\/etc\/shadow\b/, label: "/etc/shadow" },
  { re: /\/etc\/sudoers\b/, label: "/etc/sudoers" },
  { re: /\/etc\/ssh\/ssh_host_[A-Za-z0-9_]+_key\b/, label: "/etc/ssh/ssh_host_*_key" },
  { re: /\/etc\/ssh\/sshd_config\b/, label: "/etc/ssh/sshd_config" },
  { re: /\/etc\/ssh\/ssh_config\b/, label: "/etc/ssh/ssh_config" },

  // SSH user keys (match with or without leading ~/$HOME)
  { re: /(?:^|[^A-Za-z0-9_])\.ssh\/id_(?:rsa|ed25519|ecdsa|dsa)\b/i, label: "~/.ssh/id_*" },
  { re: /\/root\/\.ssh\//, label: "/root/.ssh/" },
  { re: /(?:^|[^A-Za-z0-9_])\.ssh\/authorized_keys\b/i, label: "~/.ssh/authorized_keys" },

  // Common credential stores
  { re: /(?:^|[^A-Za-z0-9_])\.aws\/credentials\b/i, label: "~/.aws/credentials" },
  { re: /(?:^|[^A-Za-z0-9_])\.kube\/config\b/i, label: "~/.kube/config" },
  { re: /(?:^|[^A-Za-z0-9_])\.docker\/config\.json\b/i, label: "~/.docker/config.json" },
  { re: /(?:^|[^A-Za-z0-9_])\.npmrc\b/i, label: "~/.npmrc" },
  { re: /(?:^|[^A-Za-z0-9_])\.pypirc\b/i, label: "~/.pypirc" },
  { re: /(?:^|[^A-Za-z0-9_])\.netrc\b/i, label: "~/.netrc" },
  { re: /(?:^|[^A-Za-z0-9_])\.git-credentials\b/i, label: "~/.git-credentials" },
];

const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/, label: "private key block" },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, label: "OpenAI API key" },
  { re: /\bghp_[A-Za-z0-9]{30,}\b/, label: "GitHub token" },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/, label: "GitLab token" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, label: "Slack token" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key id" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, label: "Google API key" },
  { re: /\bya29\.[0-9A-Za-z\-_]+\b/, label: "Google OAuth access token" },
];

function looksLikeHardcodedCredentialAssignment(content: string): string | null {
  // Only consider quoted assignments, otherwise false positives explode.
  const re =
    /\b([A-Za-z_][A-Za-z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)\s*=\s*(['"])([^'"]{8,})\2/g;

  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const varName = match[1];
    const value = match[3].trim();
    const lowered = value.toLowerCase();

    // Ignore obvious placeholders.
    if (
      lowered === "changeme" ||
      lowered === "password" ||
      lowered === "secret" ||
      lowered === "token" ||
      lowered === "your_api_key" ||
      lowered.includes("your_") ||
      lowered.includes("example") ||
      lowered.includes("placeholder")
    ) {
      continue;
    }

    // Ignore env expansions / template strings.
    if (value.includes("$") || value.includes("{")) {
      continue;
    }

    // Require some entropy-ish length.
    if (value.length < 16) {
      continue;
    }

    return `${varName}="***"`;
  }

  return null;
}

function scanContentForIssues(content: string): { ok: true } | { ok: false; reason: string } {
  for (const { re, label } of FORBIDDEN_PATH_PATTERNS) {
    if (re.test(content)) {
      return {
        ok: false,
        reason: `Script references sensitive path '${label}', which is not allowed.`,
      };
    }
  }

  for (const { re, label } of SECRET_PATTERNS) {
    if (re.test(content)) {
      return {
        ok: false,
        reason: `Script appears to contain a hardcoded secret (${label}). Refusing to execute.`,
      };
    }
  }

  const assignment = looksLikeHardcodedCredentialAssignment(content);
  if (assignment) {
    return {
      ok: false,
      reason:
        "Script appears to contain a hardcoded credential assignment. Refusing to execute.",
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Public API: validate scripts executed via bash/sh/zsh/dash
// ---------------------------------------------------------------------------

export async function validateScriptContentFromShellCommand(
  command: string,
  opts: {
    workspaceDir: string;
    additionalReadDirs?: string[];
    additionalWriteDirs?: string[];
    security?: Record<string, unknown>;
  },
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const policy = getPolicy(opts.security);
  if (!policy.enabled) return { allowed: true };

  // Fast path: avoid parsing overhead unless a shell interpreter appears.
  if (!/\b(?:bash|sh|zsh|dash)\b/.test(command)) {
    return { allowed: true };
  }

  const segments = extractSegments(command);
  for (const segment of segments) {
    const tokens = shellTokenize(segment);
    if (!tokens || tokens.length === 0) {
      // If we cannot tokenize safely but it contains an interpreter keyword,
      // fail closed.
      if (/\b(?:bash|sh|zsh|dash)\b/.test(segment)) {
        return {
          allowed: false,
          reason: "Malformed shell command (unclosed quotes). Cannot validate script execution safely.",
        };
      }
      continue;
    }

    const interpreterIndex = tokens.findIndex((t) => {
      const base = basenameMaybe(t);
      return base === "bash" || base === "sh" || base === "zsh" || base === "dash";
    });
    if (interpreterIndex < 0) continue;

    const interpreter = basenameMaybe(tokens[interpreterIndex]);
    const args = tokens.slice(interpreterIndex + 1);

    // Parse `-c` inline script (bash/sh)
    const cIndex = args.findIndex((a) => a === "-c" || a.startsWith("-c"));
    if (cIndex >= 0) {
      if (!policy.scanInline) {
        return {
          allowed: false,
          reason: `Inline '${interpreter} -c' execution is not allowed by policy.`,
        };
      }

      const arg = args[cIndex];
      const inline =
        arg === "-c" ? (args[cIndex + 1] ?? "") : arg.slice(2);
      const inlineTrimmed = inline.trim();
      if (!inlineTrimmed) {
        return {
          allowed: false,
          reason: `Inline '${interpreter} -c' was used, but no script content was provided.`,
        };
      }

      const scan = scanContentForIssues(inlineTrimmed);
      if (!scan.ok) {
        return { allowed: false, reason: scan.reason };
      }
      continue;
    }

    // No args / stdin execution.
    if (args.length === 0 || args[0] === "-" || args.includes("-")) {
      if (policy.denyStdinExecution) {
        return {
          allowed: false,
          reason:
            `Executing '${interpreter}' from stdin is not allowed (e.g. 'curl ... | ${interpreter}'). Use a script file that can be validated.`,
        };
      }
      continue;
    }

    // Find script file operand (first non-flag after options, respecting `--`).
    let scriptArg: string | null = null;
    let afterDoubleDash = false;
    for (const a of args) {
      if (!afterDoubleDash && a === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && a.startsWith("-")) {
        continue;
      }
      scriptArg = a;
      break;
    }

    if (!scriptArg) {
      if (policy.denyStdinExecution) {
        return {
          allowed: false,
          reason:
            `No script file operand found for '${interpreter}'. Refusing to execute without a validateable script file.`,
        };
      }
      continue;
    }

    const pathResult = validatePath(scriptArg, {
      workspaceDir: opts.workspaceDir,
      additionalReadDirs: opts.additionalReadDirs ?? [],
      additionalWriteDirs: opts.additionalWriteDirs ?? [],
      operation: "read",
    });
    if (!pathResult.valid || !pathResult.resolvedPath) {
      return {
        allowed: false,
        reason:
          pathResult.reason ??
          `Script path '${scriptArg}' is outside allowed directories`,
      };
    }

    const resolved = pathResult.resolvedPath;
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      if (policy.denyMissingScriptFile) {
        return {
          allowed: false,
          reason:
            `Script file '${scriptArg}' does not exist at validation time. Create it first, then execute it.`,
        };
      }
      continue;
    }

    if (!stat.isFile()) {
      return {
        allowed: false,
        reason: `Script path '${scriptArg}' is not a regular file.`,
      };
    }

    if (stat.size > policy.maxBytes) {
      return {
        allowed: false,
        reason:
          `Script '${scriptArg}' is too large to validate safely (>${policy.maxBytes} bytes).`,
      };
    }

    const buf = await fs.readFile(resolved);
    if (buf.includes(0)) {
      return {
        allowed: false,
        reason: `Script '${scriptArg}' appears to be binary (contains NUL bytes). Refusing to execute.`,
      };
    }

    const content = buf.toString("utf8");
    const scan = scanContentForIssues(content);
    if (!scan.ok) {
      return { allowed: false, reason: scan.reason };
    }
  }

  return { allowed: true };
}

