#!/usr/bin/env node
/**
 * `pa-remote-hook <mode>` - tiny bin for the remote session hooks.
 *
 * It imports only remote-hook.ts (which imports process-tree and protocol), not the whole `pa` CLI. This keeps the start
 * time low, because Claude Code starts this command for many hook events. Same logic as `pa claude-remote-hook`.
 * Never writes to stdout. Always exits 0 or 2.
 */

import { runRemoteHookEntry } from "./remote-hook.js";

process.exitCode = await runRemoteHookEntry(process.argv.slice(2));
