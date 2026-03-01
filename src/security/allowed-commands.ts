/**
 * Command Extraction & Validation
 * ================================
 *
 * Extracts command names from shell command strings and validates them
 * against an allowlist. This is a security component used as part of a
 * defense-in-depth approach alongside path validation.
 *
 * Design principles:
 * - When in doubt, be conservative (block rather than allow)
 * - Practical regex-based parsing (not a full shell parser)
 * - Handles common patterns: pipes, chaining, substitutions, keywords
 */

import * as path from "node:path";

// ---------------------------------------------------------------------------
// Shell keywords to skip (not commands)
// ---------------------------------------------------------------------------

const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "select",
  "do",
  "done",
  "while",
  "until",
  "case",
  "esac",
  "in",
  "function",
  "!",
  "{",
  "}",
]);

// ---------------------------------------------------------------------------
// Privilege escalation detection
// ---------------------------------------------------------------------------

/**
 * Detect `sudo` anywhere in a raw command string.
 *
 * Checks the **original** command text (before substitution stripping) so
 * that bypass attempts like `$(echo sudo) rm -rf /` are caught.
 * Uses word-boundary matching to avoid false positives on substrings
 * (e.g. "pseudocode" won't match).
 *
 * @param commandString - The raw, unprocessed shell command string
 * @returns Object with `found` boolean and `reason` when found
 */
export function containsSudo(commandString: string): {
  found: boolean;
  reason?: string;
} {
  if (/\bsudo\b/.test(commandString)) {
    return {
      found: true,
      reason:
        "Use of 'sudo' is not allowed. The assistant must operate without elevated privileges.",
    };
  }
  return { found: false };
}

// ---------------------------------------------------------------------------
// Dangerous rm targets
// ---------------------------------------------------------------------------

const DANGEROUS_RM_PATTERNS = [
  "/*",
  "../*",
  "/..",
  "/.",
  ".*",
  "**/",
  "~/*",
  "/home",
  "/etc",
  "/usr",
  "/var",
  "/bin",
  "/sbin",
  "/lib",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/root",
];

// ---------------------------------------------------------------------------
// File-manipulating commands whose arguments we extract as paths
// ---------------------------------------------------------------------------

const FILE_OPERATION_COMMANDS = new Set([
  "cp",
  "mv",
  "rm",
  "rmdir",
  "mkdir",
  "chmod",
  "touch",
  "ln",
  "tee",
]);

// Commands whose output-flag arguments are file paths
const OUTPUT_FLAG_COMMANDS: Record<string, string[]> = {
  curl: ["-o", "--output"],
  wget: ["-O", "--output-document"],
  unzip: ["-d"],
};

// ---------------------------------------------------------------------------
// Helpers: simple shell tokenizer
// ---------------------------------------------------------------------------

/**
 * Split a string into shell-like tokens.
 *
 * Handles single and double quoting. This is intentionally simple -- it
 * does not handle every edge case of POSIX shell quoting, but covers the
 * common patterns we need for security validation.
 *
 * Returns `null` if the input is malformed (e.g. unclosed quotes) to
 * signal fail-safe blocking.
 */
function shellTokenize(input: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      i++;
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else {
        current += ch;
      }
      i++;
      continue;
    }

    // Outside quotes
    if (ch === "'") {
      inSingle = true;
      i++;
    } else if (ch === '"') {
      inDouble = true;
      i++;
    } else if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      i++;
    } else {
      current += ch;
      i++;
    }
  }

  // Unclosed quotes -> malformed
  if (inSingle || inDouble) {
    return null;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Helpers: strip substitutions
// ---------------------------------------------------------------------------

/**
 * Remove $(...) and backtick substitutions from a command string,
 * replacing them with empty strings. This prevents the substitution
 * text from being parsed as a top-level command.
 */
function stripSubstitutions(input: string): string {
  let result = input;

  // Strip $(...) with nesting support
  let changed = true;
  while (changed) {
    changed = false;
    let i = 0;
    let out = "";
    while (i < result.length) {
      if (
        result[i] === "$" &&
        i + 1 < result.length &&
        result[i + 1] === "("
      ) {
        let depth = 1;
        let j = i + 2;
        let inSQ = false;
        let inDQ = false;
        while (j < result.length && depth > 0) {
          const ch = result[j];
          if (ch === "'" && !inDQ) inSQ = !inSQ;
          else if (ch === '"' && !inSQ) inDQ = !inDQ;
          else if (!inSQ && !inDQ) {
            if (
              ch === "$" &&
              j + 1 < result.length &&
              result[j + 1] === "("
            ) {
              depth++;
              j++;
            } else if (ch === ")") {
              depth--;
            }
          }
          j++;
        }
        if (depth === 0) {
          // Replace the entire $(...) with empty string
          out += result.slice(i, i); // nothing
          i = j;
          changed = true;
        } else {
          out += result[i];
          i++;
        }
      } else {
        out += result[i];
        i++;
      }
    }
    result = out;
  }

  // Strip backtick substitutions
  result = result.replace(/`[^`]*`/g, "");

  return result;
}

// ---------------------------------------------------------------------------
// extractCommands
// ---------------------------------------------------------------------------

/**
 * Extract command names from a shell command string.
 *
 * Splits on `&&`, `||`, `;`, `|`. Handles `$(...)` and backtick
 * substitutions. Skips shell keywords and variable assignments.
 * Extracts the basename of each command (strips directory path).
 *
 * @param commandString - The shell command string
 * @returns Array of command names found
 */
export function extractCommands(commandString: string): string[] {
  const trimmed = commandString.trim();
  if (!trimmed) {
    return [];
  }

  const commands: string[] = [];

  // 1. Extract commands from $(...) and backtick substitutions
  commands.push(...extractSubstitutionCommands(trimmed));

  // 2. Strip substitutions from the string before segment parsing
  //    so that e.g. "$(whoami)" doesn't get treated as a command token.
  const stripped = stripSubstitutions(trimmed);

  // 3. Split on ;, &&, || to get segments
  const segments = stripped.split(/\s*(?:&&|\|\|)\s*/);

  const allSegments: string[] = [];
  for (const seg of segments) {
    const subSegs = seg.split(/\s*;\s*/);
    for (const sub of subSegs) {
      const s = sub.trim();
      if (s) {
        allSegments.push(s);
      }
    }
  }

  // 3. Process each segment: split on | for pipes
  for (const segment of allSegments) {
    const pipeSegments = segment.split(/\s*\|\s*/);

    for (const pipeSeg of pipeSegments) {
      const s = pipeSeg.trim();
      if (!s) continue;

      // Tokenize the segment
      const tokens = shellTokenize(s);
      if (!tokens || tokens.length === 0) continue;

      // Walk through tokens to find the command
      let expectCommand = true;
      let skipNextAsVariable = false;

      for (let ti = 0; ti < tokens.length; ti++) {
        let token = tokens[ti];

        // Handle trailing semicolons (sometimes not split cleanly)
        const hasTrailingSemicolon = token.endsWith(";");
        if (hasTrailingSemicolon) {
          token = token.slice(0, -1);
          if (!token) {
            expectCommand = true;
            continue;
          }
        }

        // Skip variable names after 'for'/'select'
        if (skipNextAsVariable) {
          skipNextAsVariable = false;
          expectCommand = false;
          if (hasTrailingSemicolon) {
            expectCommand = true;
          }
          continue;
        }

        // Shell operators indicate new command follows
        if (
          token === "|" ||
          token === "||" ||
          token === "&&" ||
          token === "&" ||
          token === ";"
        ) {
          expectCommand = true;
          continue;
        }

        // 'for' and 'select' -- next token is a variable name
        // 'function' -- next token is the function name, not a command
        if (token === "for" || token === "select" || token === "function") {
          skipNextAsVariable = true;
          continue;
        }

        // Skip shell keywords
        if (SHELL_KEYWORDS.has(token)) {
          // Keywords like 'do', 'then', 'else', '{' signal a new command follows
          if (
            token === "do" ||
            token === "then" ||
            token === "else" ||
            token === "elif" ||
            token === "{" ||
            token === "!"
          ) {
            expectCommand = true;
          }
          if (hasTrailingSemicolon) {
            expectCommand = true;
          }
          continue;
        }

        // Skip flags/options
        if (token.startsWith("-")) {
          if (hasTrailingSemicolon) {
            expectCommand = true;
          }
          continue;
        }

        // Skip variable assignments (VAR=value)
        if (token.includes("=") && !token.startsWith("=")) {
          // Make sure it looks like a variable assignment (word chars before =)
          const eqIndex = token.indexOf("=");
          const beforeEq = token.slice(0, eqIndex);
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(beforeEq)) {
            if (hasTrailingSemicolon) {
              expectCommand = true;
            }
            continue;
          }
        }

        if (expectCommand) {
          // Extract basename (handle /usr/bin/python -> python)
          const cmd = path.basename(token);
          if (cmd) {
            commands.push(cmd);
          }
          // When the command is "sudo", the next non-flag token is
          // the actual command — keep expectCommand true so it gets
          // extracted (and validated) as well.
          if (cmd === "sudo") {
            continue; // stay in expectCommand mode
          }
          expectCommand = false;
        }

        if (hasTrailingSemicolon) {
          expectCommand = true;
        }
      }
    }
  }

  return commands;
}

// ---------------------------------------------------------------------------
// extractSubstitutionCommands (internal)
// ---------------------------------------------------------------------------

/**
 * Extract command names hidden inside $(...) and backtick substitutions.
 *
 * Recursively calls extractCommands on the inner content so nested
 * commands are also discovered.
 */
function extractSubstitutionCommands(commandString: string): string[] {
  const commands: string[] = [];

  // --- $(...) substitutions (with nesting support) ---
  let i = 0;
  while (i < commandString.length) {
    if (
      commandString[i] === "$" &&
      i + 1 < commandString.length &&
      commandString[i + 1] === "("
    ) {
      let depth = 1;
      const start = i + 2;
      let j = start;
      let inSQ = false;
      let inDQ = false;

      while (j < commandString.length && depth > 0) {
        const ch = commandString[j];
        if (ch === "'" && !inDQ) {
          inSQ = !inSQ;
        } else if (ch === '"' && !inSQ) {
          inDQ = !inDQ;
        } else if (!inSQ && !inDQ) {
          if (
            ch === "$" &&
            j + 1 < commandString.length &&
            commandString[j + 1] === "("
          ) {
            depth++;
            j++; // skip the '(' so we don't double-count
          } else if (ch === ")") {
            depth--;
          }
        }
        j++;
      }

      if (depth === 0) {
        const inner = commandString.slice(start, j - 1);
        // Extract commands from the inner substitution
        // We call the top-level function which handles both regular
        // segments and further nested substitutions.
        commands.push(...extractCommandsFromInner(inner));
      }
      i = j;
    } else {
      i++;
    }
  }

  // --- Backtick substitutions ---
  const backtickRe = /`([^`]*)`/g;
  let match: RegExpExecArray | null;
  while ((match = backtickRe.exec(commandString)) !== null) {
    commands.push(...extractCommandsFromInner(match[1]));
  }

  return commands;
}

/**
 * Extract commands from the inner content of a substitution.
 *
 * This is a helper to avoid infinite recursion: it only does segment
 * splitting + keyword skipping, without re-entering substitution extraction
 * (the parent already handles nesting).
 */
function extractCommandsFromInner(inner: string): string[] {
  const trimmed = inner.trim();
  if (!trimmed) return [];

  const commands: string[] = [];

  // Split on ;, &&, ||
  const segments = trimmed.split(/\s*(?:&&|\|\|)\s*/);
  const allSegments: string[] = [];
  for (const seg of segments) {
    const subSegs = seg.split(/\s*;\s*/);
    for (const sub of subSegs) {
      const s = sub.trim();
      if (s) allSegments.push(s);
    }
  }

  for (const segment of allSegments) {
    const pipeSegments = segment.split(/\s*\|\s*/);
    for (const pipeSeg of pipeSegments) {
      const s = pipeSeg.trim();
      if (!s) continue;

      const tokens = shellTokenize(s);
      if (!tokens || tokens.length === 0) continue;

      // Find the first non-keyword, non-assignment, non-flag token
      let skipNextAsVariable = false;
      for (const token of tokens) {
        if (skipNextAsVariable) {
          skipNextAsVariable = false;
          continue;
        }
        if (token === "for" || token === "select") {
          skipNextAsVariable = true;
          continue;
        }
        if (SHELL_KEYWORDS.has(token)) continue;
        if (token.startsWith("-")) continue;
        if (token.includes("=") && !token.startsWith("=")) {
          const eqIndex = token.indexOf("=");
          const beforeEq = token.slice(0, eqIndex);
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(beforeEq)) continue;
        }

        commands.push(path.basename(token));
        break; // Only get the first command per pipe segment
      }
    }
  }

  return commands;
}

// ---------------------------------------------------------------------------
// validateCommand
// ---------------------------------------------------------------------------

/**
 * Check if a command is in the provided allowlist.
 *
 * @param cmd - The command name to validate
 * @param allowlist - Set of allowed command names
 * @returns Object with `allowed` boolean and optional `reason` string
 */
export function validateCommand(
  cmd: string,
  allowlist: Set<string>,
): { allowed: boolean; reason?: string } {
  if (allowlist.has(cmd)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `Command '${cmd}' is not in the allowed commands list`,
  };
}

// ---------------------------------------------------------------------------
// validateRmCommand
// ---------------------------------------------------------------------------

/**
 * Validate rm commands -- block dangerous recursive/root operations.
 *
 * Security checks:
 * 1. Require at least one target
 * 2. Block dangerous patterns like /*, system directories, hidden files
 * 3. Block recursive deletion with wildcards
 *
 * @param segment - The full rm command segment (e.g. "rm -rf /")
 * @returns Object with `allowed` boolean and optional `reason` string
 */
export function validateRmCommand(
  segment: string,
): { allowed: boolean; reason?: string } {
  const tokens = shellTokenize(segment);
  if (!tokens) {
    return { allowed: false, reason: "Could not parse rm command" };
  }

  if (tokens.length === 0 || tokens[0] !== "rm") {
    return { allowed: false, reason: "Not an rm command" };
  }

  // Separate flags from targets
  const flags: string[] = [];
  const targets: string[] = [];
  let isRecursive = false;

  for (const token of tokens.slice(1)) {
    if (token.startsWith("-")) {
      flags.push(token);
      if (
        token.includes("r") ||
        token.includes("R") ||
        token === "--recursive"
      ) {
        isRecursive = true;
      }
    } else {
      targets.push(token);
    }
  }

  if (targets.length === 0) {
    return { allowed: false, reason: "rm requires at least one target" };
  }

  // Check each target against dangerous patterns
  for (const target of targets) {
    // Exact match "/"
    if (target === "/") {
      return { allowed: false, reason: `rm blocked: dangerous target '/'` };
    }

    for (const pattern of DANGEROUS_RM_PATTERNS) {
      if (
        target === pattern ||
        target.endsWith(pattern) ||
        target.startsWith(pattern)
      ) {
        return {
          allowed: false,
          reason: `rm blocked: dangerous pattern '${target}'`,
        };
      }
    }

    // Block recursive deletion of hidden files/directories
    if (isRecursive && (target.startsWith(".*") || target.includes("/.."))) {
      return {
        allowed: false,
        reason: `rm blocked: recursive deletion of hidden files/directories not allowed: ${target}`,
      };
    }
  }

  // Block recursive deletion with wildcards
  if (isRecursive) {
    for (const target of targets) {
      if (target.includes("*")) {
        return {
          allowed: false,
          reason: `rm blocked: recursive deletion with wildcard not allowed: ${target}`,
        };
      }
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// validateKillCommand
// ---------------------------------------------------------------------------

/**
 * Validate kill commands -- block killing PID 1 and system processes.
 *
 * Security checks:
 * 1. Allow `kill -l` (list signals) unconditionally
 * 2. Require at least one PID
 * 3. Block PID 1 (init)
 * 4. Block negative PIDs (process groups)
 * 5. Block very low PIDs (< 100, system processes)
 *
 * @param segment - The full kill command segment (e.g. "kill -9 1")
 * @returns Object with `allowed` boolean and optional `reason` string
 */
export function validateKillCommand(
  segment: string,
): { allowed: boolean; reason?: string } {
  const tokens = shellTokenize(segment);
  if (!tokens) {
    return { allowed: false, reason: "Could not parse kill command" };
  }

  if (tokens.length === 0 || tokens[0] !== "kill") {
    return { allowed: false, reason: "Not a kill command" };
  }

  const pids: string[] = [];
  let i = 1;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token.startsWith("-")) {
      // kill -l or --list: harmless listing of signals
      if (token === "-l" || token === "--list") {
        return { allowed: true };
      }

      // kill -s SIGNAL: skip the next token (it is the signal name)
      if (token === "-s" && i + 1 < tokens.length) {
        i += 2;
        continue;
      }

      // -9, -TERM, -SIGKILL etc. are signal flags, skip them
      i++;
      continue;
    }

    // Non-flag token: this is a PID or job spec
    pids.push(token);
    i++;
  }

  if (pids.length === 0) {
    return { allowed: false, reason: "kill requires at least one PID" };
  }

  // Validate each PID
  for (const pid of pids) {
    // Job specs like %1 are allowed
    if (pid.startsWith("%")) {
      continue;
    }

    const pidNum = parseInt(pid, 10);
    if (!isNaN(pidNum)) {
      if (pidNum === 1) {
        return {
          allowed: false,
          reason: "kill blocked: cannot kill PID 1 (init)",
        };
      }
      if (pidNum < 0) {
        return {
          allowed: false,
          reason: `kill blocked: negative PID (process group) not allowed: ${pid}`,
        };
      }
      if (pidNum < 100) {
        return {
          allowed: false,
          reason: `kill blocked: system process PID not allowed: ${pid}`,
        };
      }
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// extractFilePathsFromCommand
// ---------------------------------------------------------------------------

/**
 * Extract file paths from a bash command.
 *
 * Handles:
 * - File operation commands (cp, mv, mkdir, rm, touch, chmod, ln, tee, rmdir)
 * - Output flag commands (curl -o, unzip -d)
 * - Output redirection (>, >>, 2>)
 *
 * Skips flags (args starting with -). For cp/mv/ln, extracts both source
 * and destination.
 *
 * @param commandString - The bash command string
 * @returns Array of file paths found in the command
 */
export function extractFilePathsFromCommand(commandString: string): string[] {
  const trimmed = commandString.trim();
  if (!trimmed) {
    return [];
  }

  const tokens = shellTokenize(trimmed);
  if (!tokens || tokens.length === 0) {
    return [];
  }

  const paths: string[] = [];

  // Get the base command
  const cmd = path.basename(tokens[0]);

  // --- Handle output flag commands (curl -o, unzip -d, etc.) ---
  if (cmd in OUTPUT_FLAG_COMMANDS) {
    const outputFlags = OUTPUT_FLAG_COMMANDS[cmd];
    for (let i = 1; i < tokens.length; i++) {
      if (outputFlags.includes(tokens[i]) && i + 1 < tokens.length) {
        paths.push(tokens[i + 1]);
        i++; // skip the value we just consumed
      }
    }
  }

  // --- Handle file operation commands ---
  if (FILE_OPERATION_COMMANDS.has(cmd)) {
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];

      // Skip flags
      if (token.startsWith("-")) {
        continue;
      }

      // Skip redirection operators (handled separately below)
      if (token === ">" || token === ">>" || token === "2>" || token === "&>") {
        // The next token is the redirect target -- handled below
        i++;
        continue;
      }

      // Everything else is a path argument for file operation commands
      paths.push(token);
    }
  }

  // --- Handle redirections in ANY command (>, >>, 2>) ---
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (
      (token === ">" || token === ">>" || token === "2>" || token === "&>") &&
      i + 1 < tokens.length
    ) {
      paths.push(tokens[i + 1]);
    }
  }

  return paths;
}
