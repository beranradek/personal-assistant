# Global CLI Installation Design

## Goal

Make `personal-assistant` installable as a global CLI tool (`pa`) so users can run `pa terminal`, `pa daemon`, and `pa init` from anywhere, with configuration stored in `~/.personal-assistant/settings.json` instead of in the source tree.

## Distribution

Install via `npm link` or `npm install -g .` from a local clone. Not published to npm.

## CLI Entry Point (`src/cli.ts`)

Single entry point compiled to `dist/cli.js` with `#!/usr/bin/env node` shebang.

Subcommands:
- `pa terminal` — interactive REPL
- `pa daemon` — headless service
- `pa init` — create default `settings.json` in config directory

Flag: `--config <path>` overrides settings.json location.

Config directory resolution order:
1. `--config` flag (parent directory of the specified file)
2. `PA_CONFIG` env var
3. `~/.personal-assistant/`

No external CLI parser library — hand-rolled from `process.argv`.

## Config Loading Changes

- Rename `appDir` parameter to `configDir` throughout `loadConfig()`, `createTerminalSession()`, `startDaemon()`
- Config search: look for `settings.json` in `configDir`
- Entry points receive `configDir` from CLI instead of resolving via `import.meta.url`

## Template Bundling

`tsc` doesn't copy non-TS files. Add a `postbuild` step: `cp -r src/templates dist/templates`.

Compiled layout:
```
dist/
├── cli.js
├── core/
│   └── workspace.js
├── templates/
│   ├── AGENTS.md
│   ├── cs/
│   └── ...
```

Existing relative path in `workspace.ts` (`path.resolve(__dirname, "..", "templates")`) resolves correctly from `dist/core/workspace.js`.

## `pa init` Command

- Creates `~/.personal-assistant/settings.json` with pretty-printed defaults
- Skips if file already exists (prints message)
- Ensures workspace directories exist

## package.json Changes

```json
{
  "bin": { "pa": "./dist/cli.js" },
  "scripts": {
    "build": "tsc && cp -r src/templates dist/templates"
  }
}
```

Dev scripts (`npm run terminal`, `npm run daemon`) remain for development with `tsx`.

## Unchanged

- `terminal.ts` and `daemon.ts` keep standalone `main()` + VITEST guards
- Config defaults, Zod validation, deep-merge logic
- Workspace bootstrap, memory, adapters, all subsystems
- No new dependencies
