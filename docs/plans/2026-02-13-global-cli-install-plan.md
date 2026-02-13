# Global CLI Installation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the personal-assistant installable as a global CLI (`pa`) with config in `~/.personal-assistant/settings.json`.

**Architecture:** New `src/cli.ts` entry point parses subcommands (`terminal`, `daemon`, `init`) and resolves a `configDir`. Existing entry points (`terminal.ts`, `daemon.ts`) and config loader receive `configDir` instead of `appDir`. Templates are copied to `dist/` during build.

**Tech Stack:** Node.js 22+, TypeScript, ESM, hand-rolled CLI arg parsing (no new dependencies)

---

### Task 1: Rename `appDir` → `configDir` in config loader

**Files:**
- Modify: `src/core/config.ts:121-143` (rename parameter)
- Test: `src/core/config.test.ts` (no changes needed — tests pass `tmpDir` which works as either name)

**Step 1: Rename `appDir` parameter to `configDir` in `loadConfig()`**

In `src/core/config.ts`, change the function signature and internal usage:

```typescript
export function loadConfig(configDir: string): Config {
  const settingsPath = path.join(configDir, "settings.json");
```

That's the only reference — `appDir` is only used once to build `settingsPath`.

**Step 2: Run tests to verify nothing breaks**

Run: `npx vitest run src/core/config.test.ts`
Expected: All 6 tests PASS (tests pass a `tmpDir`, the parameter name doesn't matter)

**Step 3: Commit**

```bash
git add src/core/config.ts
git commit -m "refactor: rename appDir to configDir in loadConfig"
```

---

### Task 2: Rename `appDir` → `configDir` in terminal.ts

**Files:**
- Modify: `src/terminal.ts:82-107` (rename parameter in `createTerminalSession`)
- Modify: `src/terminal.ts:113-114` (rename local var in `main()`)
- Test: `src/terminal.test.ts` (no changes needed — tests mock `loadConfig` and pass a string)

**Step 1: Rename in `createTerminalSession` and `main()`**

In `src/terminal.ts`, rename the parameter:

```typescript
export async function createTerminalSession(
  configDir: string,
): Promise<TerminalSession> {
  const config = loadConfig(configDir);
```

And in `main()`:

```typescript
async function main() {
  const configDir = new URL("..", import.meta.url).pathname;
  const { config, agentOptions, sessionKey } =
    await createTerminalSession(configDir);
```

**Step 2: Run tests**

Run: `npx vitest run src/terminal.test.ts`
Expected: All 8 tests PASS

**Step 3: Commit**

```bash
git add src/terminal.ts
git commit -m "refactor: rename appDir to configDir in terminal.ts"
```

---

### Task 3: Rename `appDir` → `configDir` in daemon.ts

**Files:**
- Modify: `src/daemon.ts:57-58` (rename parameter in `startDaemon`)
- Modify: `src/daemon.ts:223-224` (rename local var in `main()`)
- Test: `src/daemon.test.ts` (no changes needed)

**Step 1: Rename in `startDaemon` and `main()`**

In `src/daemon.ts`:

```typescript
export async function startDaemon(configDir: string): Promise<void> {
  const config = loadConfig(configDir);
```

And in `main()`:

```typescript
async function main() {
  const configDir = new URL("..", import.meta.url).pathname;
  await startDaemon(configDir);
}
```

**Step 2: Run tests**

Run: `npx vitest run src/daemon.test.ts`
Expected: All 6 tests PASS

**Step 3: Commit**

```bash
git add src/daemon.ts
git commit -m "refactor: rename appDir to configDir in daemon.ts"
```

---

### Task 4: Create `resolveConfigDir()` helper

**Files:**
- Modify: `src/core/config.ts` (add `resolveConfigDir` function)
- Test: `src/core/config.test.ts` (add tests for the new function)

**Step 1: Write failing tests for `resolveConfigDir`**

Add to `src/core/config.test.ts`:

```typescript
describe("resolveConfigDir", () => {
  it("returns parent directory of --config path", () => {
    const result = resolveConfigDir(["node", "cli.js", "--config", "/home/user/my-settings.json"]);
    expect(result).toBe("/home/user");
  });

  it("returns PA_CONFIG env var when set and no --config flag", () => {
    const original = process.env["PA_CONFIG"];
    process.env["PA_CONFIG"] = "/custom/config/dir";
    try {
      const result = resolveConfigDir(["node", "cli.js", "terminal"]);
      expect(result).toBe("/custom/config/dir");
    } finally {
      if (original === undefined) delete process.env["PA_CONFIG"];
      else process.env["PA_CONFIG"] = original;
    }
  });

  it("returns ~/.personal-assistant as default when no flag or env", () => {
    const original = process.env["PA_CONFIG"];
    delete process.env["PA_CONFIG"];
    try {
      const result = resolveConfigDir(["node", "cli.js", "terminal"]);
      expect(result).toBe(path.join(os.homedir(), ".personal-assistant"));
    } finally {
      if (original !== undefined) process.env["PA_CONFIG"] = original;
    }
  });

  it("--config flag takes precedence over PA_CONFIG env var", () => {
    const original = process.env["PA_CONFIG"];
    process.env["PA_CONFIG"] = "/env/config";
    try {
      const result = resolveConfigDir(["node", "cli.js", "--config", "/flag/settings.json"]);
      expect(result).toBe("/flag");
    } finally {
      if (original === undefined) delete process.env["PA_CONFIG"];
      else process.env["PA_CONFIG"] = original;
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/config.test.ts`
Expected: FAIL — `resolveConfigDir` is not exported

**Step 3: Implement `resolveConfigDir`**

Add to `src/core/config.ts` after the path helpers section:

```typescript
/**
 * Resolve the configuration directory from CLI args, env var, or default.
 *
 * Priority:
 * 1. `--config <path>` flag → parent directory of the specified file
 * 2. `PA_CONFIG` env var → that directory
 * 3. Default → `~/.personal-assistant/`
 */
export function resolveConfigDir(argv: string[]): string {
  const configIdx = argv.indexOf("--config");
  if (configIdx !== -1 && configIdx + 1 < argv.length) {
    return path.dirname(argv[configIdx + 1]);
  }

  const envConfig = process.env["PA_CONFIG"];
  if (envConfig) {
    return envConfig;
  }

  return path.join(os.homedir(), ".personal-assistant");
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/config.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/core/config.ts src/core/config.test.ts
git commit -m "feat: add resolveConfigDir for CLI config directory resolution"
```

---

### Task 5: Create `src/cli.ts` entry point

**Files:**
- Create: `src/cli.ts`
- Test: `src/cli.test.ts`

**Step 1: Write failing tests for CLI argument parsing**

Create `src/cli.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./core/config.js", () => ({
  loadConfig: vi.fn(),
  resolveConfigDir: vi.fn(() => "/mock/config"),
  resolveUserPath: vi.fn((p: string) => p),
  DEFAULTS: {},
}));

vi.mock("./core/workspace.js", () => ({
  ensureWorkspace: vi.fn(),
}));

vi.mock("./terminal.js", () => ({
  createTerminalSession: vi.fn(),
}));

vi.mock("./daemon.js", () => ({
  startDaemon: vi.fn(),
}));

vi.mock("./core/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { parseCommand } from "./cli.js";

describe("cli", () => {
  describe("parseCommand", () => {
    it('parses "terminal" subcommand', () => {
      const result = parseCommand(["node", "cli.js", "terminal"]);
      expect(result).toBe("terminal");
    });

    it('parses "daemon" subcommand', () => {
      const result = parseCommand(["node", "cli.js", "daemon"]);
      expect(result).toBe("daemon");
    });

    it('parses "init" subcommand', () => {
      const result = parseCommand(["node", "cli.js", "init"]);
      expect(result).toBe("init");
    });

    it("returns null for unknown subcommand", () => {
      const result = parseCommand(["node", "cli.js", "unknown"]);
      expect(result).toBeNull();
    });

    it("returns null when no subcommand given", () => {
      const result = parseCommand(["node", "cli.js"]);
      expect(result).toBeNull();
    });

    it("ignores --config flag when finding subcommand", () => {
      const result = parseCommand(["node", "cli.js", "--config", "/path/settings.json", "terminal"]);
      expect(result).toBe("terminal");
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli.test.ts`
Expected: FAIL — module not found

**Step 3: Implement `src/cli.ts`**

```typescript
#!/usr/bin/env node

/**
 * CLI Entry Point
 * ===============
 *
 * Global entry point for the personal-assistant CLI.
 *
 * Usage:
 *   pa terminal              Interactive REPL
 *   pa daemon                Headless service
 *   pa init                  Create default settings.json
 *   pa --config <path> ...   Override settings.json location
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { resolveConfigDir, loadConfig, DEFAULTS } from "./core/config.js";
import { ensureWorkspace } from "./core/workspace.js";
import { createTerminalSession, handleLine } from "./terminal.js";
import { startDaemon } from "./daemon.js";
import { createLogger } from "./core/logger.js";

const log = createLogger("cli");

const VALID_COMMANDS = ["terminal", "daemon", "init"] as const;
type Command = (typeof VALID_COMMANDS)[number];

/**
 * Parse the subcommand from argv, skipping --config and its value.
 * Returns the command string or null if not found/invalid.
 */
export function parseCommand(argv: string[]): Command | null {
  const args = argv.slice(2); // skip node and script path
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config") {
      i++; // skip the next arg (the path)
      continue;
    }
    if (VALID_COMMANDS.includes(args[i] as Command)) {
      return args[i] as Command;
    }
  }
  return null;
}

function printUsage(): void {
  console.log(`Usage: pa <command> [options]

Commands:
  terminal              Start interactive terminal mode
  daemon                Start headless daemon mode
  init                  Create default settings.json in config directory

Options:
  --config <path>       Path to settings.json (default: ~/.personal-assistant/settings.json)

Environment:
  PA_CONFIG             Config directory path (overridden by --config flag)`);
}

async function runInit(configDir: string): Promise<void> {
  const settingsPath = path.join(configDir, "settings.json");

  if (fs.existsSync(settingsPath)) {
    console.log(`Settings file already exists: ${settingsPath}`);
    console.log("Edit it to customize your configuration.");
    return;
  }

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(DEFAULTS, null, 2) + "\n");
  console.log(`Created default settings: ${settingsPath}`);
  console.log("Edit this file to customize your configuration.");

  // Also ensure workspace directories exist
  const config = loadConfig(configDir);
  await ensureWorkspace(config);
  console.log(`Workspace initialized: ${config.security.workspace}`);
}

async function runTerminal(configDir: string): Promise<void> {
  const { config, agentOptions, sessionKey } =
    await createTerminalSession(configDir);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.setPrompt("You> ");
  rl.prompt();

  rl.on("line", async (input) => {
    const result = await handleLine(input, sessionKey, agentOptions, config);

    if (result === null) {
      rl.prompt();
      return;
    }

    if (result.error) {
      console.error("Error:", result.error);
    } else {
      console.log(`\nAssistant: ${result.response}\n`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    log.info("Terminal session ended");
    process.exit(0);
  });
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv);

  if (!command) {
    printUsage();
    process.exit(1);
  }

  const configDir = resolveConfigDir(process.argv);

  switch (command) {
    case "init":
      await runInit(configDir);
      break;
    case "terminal":
      await runTerminal(configDir);
      break;
    case "daemon":
      await startDaemon(configDir);
      break;
  }
}

if (!process.env["VITEST"]) {
  main().catch((err) => {
    log.error({ err }, "Fatal error");
    console.error("Fatal:", err);
    process.exit(1);
  });
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli.test.ts`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat: add CLI entry point with terminal/daemon/init subcommands"
```

---

### Task 6: Update package.json with `bin` and build script

**Files:**
- Modify: `package.json`

**Step 1: Add `bin` field and update `build` script**

In `package.json`:

1. Add `"bin": { "pa": "./dist/cli.js" }` after `"private": true`
2. Change `"build"` script to `"tsc && cp -r src/templates dist/templates"`

**Step 2: Run the build**

Run: `npm run build`
Expected: TypeScript compiles successfully, `dist/cli.js` exists, `dist/templates/` contains markdown files

**Step 3: Verify shebang in compiled output**

Run: `head -1 dist/cli.js`
Expected: `#!/usr/bin/env node`

Note: TypeScript strips shebangs during compilation. If missing, we need to add it via a post-build step. Check the output — if the shebang is missing, update the build script to:
`"build": "tsc && cp -r src/templates dist/templates && sed -i '1i#!/usr/bin/env node' dist/cli.js"`

**Step 4: Run all tests to verify nothing is broken**

Run: `npx vitest run`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add package.json
git commit -m "feat: add bin field and template copy to build script"
```

---

### Task 7: Test global installation end-to-end

**Files:** None (manual verification)

**Step 1: Build the project**

Run: `npm run build`

**Step 2: Link globally**

Run: `npm link`

**Step 3: Verify `pa` command is available**

Run: `pa`
Expected: Prints usage help text

**Step 4: Test `pa init`**

Run: `pa init`
Expected: Creates `~/.personal-assistant/settings.json` (or says it already exists)

**Step 5: Test `pa init` idempotency**

Run: `pa init` again
Expected: "Settings file already exists" message

**Step 6: Verify `pa --config` works**

Run: `pa --config /tmp/test-settings.json init`
Expected: Creates `/tmp/test-settings.json` with defaults

**Step 7: Run full test suite one more time**

Run: `npx vitest run`
Expected: All tests PASS

**Step 8: Commit any fixes needed**

---

### Task 8: Update CLAUDE.md with new commands

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update the Commands section**

Add the global CLI commands to the Commands section:

```markdown
## Commands

```bash
# Development (from source)
npm run terminal         # Run interactive terminal mode
npm run daemon           # Run headless daemon mode
npm run build            # TypeScript compilation (tsc → dist/) + template copy
npm test                 # Run tests (vitest, watch mode)
npm run test:coverage    # Run tests with coverage (70% threshold)
npx vitest run src/path/to/file.test.ts   # Run a single test file

# Global CLI (after npm run build && npm link)
pa terminal              # Interactive terminal mode
pa daemon                # Headless daemon mode
pa init                  # Create default ~/.personal-assistant/settings.json
pa --config <path> ...   # Override settings.json location
```
```

Also update the Configuration section to mention `~/.personal-assistant/settings.json` as the primary config location.

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with global CLI commands"
```
