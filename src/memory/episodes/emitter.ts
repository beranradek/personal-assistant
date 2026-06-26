import * as path from "node:path";
import type { AuditEntry, Config } from "../../core/types.js";
import { createLogger } from "../../core/logger.js";
import { buildEpisodeFromAuditEntries, type BuildEpisodeOptions } from "./builder.js";
import { createEpisodeStore, type EpisodeStore } from "./store.js";
import type { EpisodeRecord, EpisodeSource } from "./types.js";

const log = createLogger("episode-emitter");
const DEFAULT_AUTO_WRITE = {
  enabled: false,
  dryRun: false,
  sources: ["github"] as EpisodeSource[],
  requireTaskContext: true,
  maxWindowEntries: 200,
};

type LoggerLike = Pick<typeof log, "debug" | "warn">;

interface EpisodeEmitterDeps {
  readAuditEntries: (workspaceDir: string, date: string) => Promise<AuditEntry[]>;
  createEpisodeStore: (dbPath: string) => EpisodeStore;
  buildEpisode: (entries: AuditEntry[], options?: BuildEpisodeOptions) => EpisodeRecord;
  log: LoggerLike;
}

export type EpisodeEmitResult =
  | { status: "disabled"; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "dry_run"; reason: string; episode: EpisodeRecord }
  | { status: "duplicate"; reason: string; episodeId: string }
  | { status: "inserted"; reason: string; episodeId: string }
  | { status: "error"; reason: string; error: string };

function logTerminalState(
  logger: LoggerLike,
  finalEntry: AuditEntry,
  result: Exclude<EpisodeEmitResult, { status: "error"; reason: string; error: string }>,
): void {
  const episodeId =
    "episodeId" in result
      ? result.episodeId
      : "episode" in result
        ? result.episode.id
        : undefined;
  logger.debug(
    {
      status: result.status,
      reason: result.reason,
      source: finalEntry.source,
      sessionKey: finalEntry.sessionKey,
      episodeId,
    },
    "episodic auto-write result",
  );
}

function dateFromTimestamp(timestamp: string): string {
  const match = timestamp.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : new Date().toISOString().slice(0, 10);
}

function isSameFinalEntry(left: AuditEntry, right: AuditEntry): boolean {
  return (
    left.timestamp === right.timestamp &&
    left.source === right.source &&
    left.sessionKey === right.sessionKey &&
    left.type === right.type &&
    left.userMessage === right.userMessage &&
    left.assistantResponse === right.assistantResponse
  );
}

function selectBoundedWindow(
  entries: AuditEntry[],
  finalEntry: AuditEntry,
  maxWindowEntries: number,
): AuditEntry[] {
  let targetIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isSameFinalEntry(entries[index], finalEntry)) {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex === -1) return [];

  let startIndex = 0;
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const candidate = entries[index];
    if (candidate.sessionKey !== finalEntry.sessionKey) continue;
    if (candidate.type === "interaction") {
      startIndex = index + 1;
      break;
    }
  }

  const sessionWindow = entries
    .slice(startIndex, targetIndex + 1)
    .filter((entry) => entry.sessionKey === finalEntry.sessionKey);

  return sessionWindow.slice(-maxWindowEntries);
}

export async function maybeAutoWriteEpisode(
  config: Config,
  finalEntry: AuditEntry,
  deps: Partial<EpisodeEmitterDeps> = {},
): Promise<EpisodeEmitResult> {
  const readAuditEntriesDep = deps.readAuditEntries ?? await (async () => {
    const dailyLogModule = await import("../daily-log.js");
    return "readAuditEntries" in dailyLogModule &&
      typeof dailyLogModule.readAuditEntries === "function"
      ? dailyLogModule.readAuditEntries
      : null;
  })();
  const mergedDeps: EpisodeEmitterDeps = {
    readAuditEntries: readAuditEntriesDep ?? (async () => []),
    createEpisodeStore,
    buildEpisode: buildEpisodeFromAuditEntries,
    log,
    ...deps,
  };
  const autoWrite = {
    ...DEFAULT_AUTO_WRITE,
    ...(config.memory as Partial<Config["memory"]> & {
      episodicMemory?: {
        autoWrite?: Partial<typeof DEFAULT_AUTO_WRITE>;
      };
    }).episodicMemory?.autoWrite,
  };

  if (!autoWrite.enabled) {
    const result = { status: "disabled", reason: "episodic auto-write disabled" } as const;
    logTerminalState(mergedDeps.log, finalEntry, result);
    return result;
  }
  if (finalEntry.type !== "interaction" || !finalEntry.assistantResponse?.trim()) {
    const result = {
      status: "skipped",
      reason: "finalized interaction required for episodic auto-write",
    } as const;
    logTerminalState(mergedDeps.log, finalEntry, result);
    return result;
  }
  if (!autoWrite.sources.includes(finalEntry.source as never)) {
    const result = {
      status: "skipped",
      reason: "source not enabled for episodic auto-write",
    } as const;
    logTerminalState(mergedDeps.log, finalEntry, result);
    return result;
  }
  if (autoWrite.requireTaskContext && !finalEntry.taskContext) {
    const result = {
      status: "skipped",
      reason: "taskContext required for episodic auto-write",
    } as const;
    logTerminalState(mergedDeps.log, finalEntry, result);
    return result;
  }
  if (!readAuditEntriesDep) {
    const result = {
      status: "skipped",
      reason: "audit reader unavailable for episodic auto-write",
    } as const;
    logTerminalState(mergedDeps.log, finalEntry, result);
    return result;
  }

  try {
    const entries = await mergedDeps.readAuditEntries(
      config.security.workspace,
      dateFromTimestamp(finalEntry.timestamp),
    );
    const windowEntries = selectBoundedWindow(entries, finalEntry, autoWrite.maxWindowEntries);
    if (windowEntries.length === 0) {
      const result = { status: "skipped", reason: "bounded audit window not found" } as const;
      logTerminalState(mergedDeps.log, finalEntry, result);
      return result;
    }

    const episode = mergedDeps.buildEpisode(windowEntries);
    if (autoWrite.dryRun) {
      const result = {
        status: "dry_run",
        reason: "episode candidate built but dry-run enabled",
        episode,
      } as const;
      logTerminalState(mergedDeps.log, finalEntry, result);
      return result;
    }

    const store = mergedDeps.createEpisodeStore(path.join(config.security.dataDir, "episodes.db"));
    try {
      if (store.getEpisodeById(episode.id)) {
        const result = {
          status: "duplicate",
          reason: "episode already exists",
          episodeId: episode.id,
        } as const;
        logTerminalState(mergedDeps.log, finalEntry, result);
        return result;
      }

      store.insertEpisode(episode);
      const result = {
        status: "inserted",
        reason: "episode inserted",
        episodeId: episode.id,
      } as const;
      logTerminalState(mergedDeps.log, finalEntry, result);
      return result;
    } finally {
      try {
        store.close();
      } catch (err) {
        mergedDeps.log.warn(
          { err, sessionKey: finalEntry.sessionKey, source: finalEntry.source },
          "episodic auto-write store cleanup failed",
        );
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    mergedDeps.log.warn(
      { err, sessionKey: finalEntry.sessionKey, source: finalEntry.source },
      "episodic auto-write failed",
    );
    return {
      status: "error",
      reason: "episodic auto-write failed",
      error,
    };
  }
}
