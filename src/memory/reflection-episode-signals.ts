import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { createEpisodeStore } from "./episodes/store.js";
import type { EpisodeRecord } from "./episodes/types.js";

const log = createLogger("reflection-episode-signals");

export type ReflectionEpisodeSignalsDeps = {
  createEpisodeStore?: typeof createEpisodeStore;
};

function takeTopCounts(values: Array<string | null | undefined>, maxItems: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxItems)
    .map(([value, count]) => `${value} (${count})`);
}

function collectEpisodeToolSignals(episodes: EpisodeRecord[], maxItems: number): string[] {
  return takeTopCounts(
    episodes.flatMap((episode) => episode.toolsUsed),
    maxItems,
  );
}

function collectEpisodeBlockerSignals(episodes: EpisodeRecord[], maxItems: number): string[] {
  return takeTopCounts(
    episodes.flatMap((episode) => [...episode.blockers, ...episode.errors]),
    maxItems,
  );
}

function collectPromotionHints(episodes: EpisodeRecord[], maxItems: number): string[] {
  const hints: string[] = [];

  const repeatedBlockers = takeTopCounts(
    episodes
      .flatMap((episode) => [...episode.blockers, ...episode.errors]),
    maxItems,
  ).filter((value) => {
    const match = value.match(/\((\d+)\)$/);
    return Number(match?.[1] ?? "0") >= 2;
  });

  for (const blocker of repeatedBlockers) {
    hints.push(`repeated blocker/error: ${blocker}`);
  }

  const successfulWorkflowCounts = new Map<string, number>();
  for (const episode of episodes) {
    if (episode.outcome !== "success") continue;
    const normalizedTools = [...new Set(
      episode.toolsUsed.map((tool) => tool.trim()).filter(Boolean),
    )].sort();
    const workflowKey = [
      episode.projectName?.trim(),
      episode.jobName?.trim(),
      ...normalizedTools,
    ]
      .filter(Boolean)
      .join(" | ");
    if (!workflowKey) continue;
    successfulWorkflowCounts.set(workflowKey, (successfulWorkflowCounts.get(workflowKey) ?? 0) + 1);
  }

  const repeatedSuccessfulWorkflows = [...successfulWorkflowCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxItems)
    .map(([workflowKey, count]) => `repeated successful workflow: ${workflowKey} (${count})`);

  hints.push(...repeatedSuccessfulWorkflows);
  return hints.slice(0, maxItems);
}

export function buildReflectionWindowBounds(startDate: string, endDate: string): {
  startedAtTo: string;
  endedAtFrom: string;
} {
  return {
    startedAtTo: `${endDate}T23:59:59.999Z`,
    endedAtFrom: `${startDate}T00:00:00.000Z`,
  };
}

export function buildEpisodeSignalsSummary(args: {
  label: string;
  episodes: EpisodeRecord[];
  maxTopItems: number;
}): string {
  if (args.episodes.length === 0) {
    return "";
  }

  const outcomeCounts = takeTopCounts(args.episodes.map((episode) => episode.outcome), 10);
  const sourceSignals = takeTopCounts(args.episodes.map((episode) => episode.source), args.maxTopItems);
  const categorySignals = takeTopCounts(args.episodes.map((episode) => episode.category), args.maxTopItems);
  const whySignals = takeTopCounts(args.episodes.map((episode) => episode.why), args.maxTopItems);
  const projectSignals = takeTopCounts(args.episodes.map((episode) => episode.projectName), args.maxTopItems);
  const jobSignals = takeTopCounts(args.episodes.map((episode) => episode.jobName), args.maxTopItems);
  const toolSignals = collectEpisodeToolSignals(args.episodes, args.maxTopItems);
  const blockerSignals = collectEpisodeBlockerSignals(args.episodes, args.maxTopItems);

  const lines = [
    `Structured episodic signals for ${args.label} from a bounded recent episode window:`,
    `- episodes: ${args.episodes.length}`,
    `- outcomes: ${outcomeCounts.join(", ") || "none"}`,
  ];

  if (sourceSignals.length > 0) {
    lines.push(`- sources: ${sourceSignals.join(", ")}`);
  }
  if (categorySignals.length > 0) {
    lines.push(`- categories: ${categorySignals.join(", ")}`);
  }
  if (whySignals.length > 0) {
    lines.push(`- why themes: ${whySignals.join(", ")}`);
  }
  if (projectSignals.length > 0) {
    lines.push(`- projects: ${projectSignals.join(", ")}`);
  }
  if (jobSignals.length > 0) {
    lines.push(`- jobs: ${jobSignals.join(", ")}`);
  }
  if (toolSignals.length > 0) {
    lines.push(`- tools: ${toolSignals.join(", ")}`);
  }
  if (blockerSignals.length > 0) {
    lines.push(`- blockers/errors: ${blockerSignals.join(", ")}`);
  }
  const promotionHints = collectPromotionHints(args.episodes, args.maxTopItems);
  if (promotionHints.length > 0) {
    lines.push(`- promotion hints: ${promotionHints.join("; ")}`);
    lines.push("- promotion hints are advisory only; no automatic semantic/procedural promotion is applied");
  }

  return lines.join("\n");
}

export async function loadEpisodeSignalsSummary(args: {
  config: Config;
  label: string;
  startDate: string;
  endDate: string;
  deps?: ReflectionEpisodeSignalsDeps;
}): Promise<string> {
  if (!args.config.reflection.episodeSignals.enabled) {
    log.info(
      { label: args.label, reason: "disabled" },
      "Skipping episode-derived reflection signals",
    );
    return "";
  }

  const dbPath = path.join(args.config.security.dataDir, "episodes.db");
  try {
    await fs.access(dbPath);
  } catch {
    log.info(
      { label: args.label, dbPath, reason: "missing_db" },
      "Skipping episode-derived reflection signals",
    );
    return "";
  }

  const createEpisodeStoreImpl = args.deps?.createEpisodeStore ?? createEpisodeStore;
  try {
    const store = createEpisodeStoreImpl(dbPath);
    try {
      const episodes = store.listEpisodes({
        ...buildReflectionWindowBounds(args.startDate, args.endDate),
        limit: args.config.reflection.episodeSignals.maxRecentEpisodes,
      });
      log.info(
        {
          label: args.label,
          dbPath,
          episodeCount: episodes.length,
          maxRecentEpisodes: args.config.reflection.episodeSignals.maxRecentEpisodes,
        },
        "Loaded episode-derived reflection signals",
      );
      return buildEpisodeSignalsSummary({
        label: args.label,
        episodes,
        maxTopItems: args.config.reflection.episodeSignals.maxTopItems,
      });
    } finally {
      try {
        store.close();
      } catch (err) {
        log.warn(
          { err, label: args.label, dbPath },
          "Failed to close episode-derived reflection store after loading",
        );
      }
    }
  } catch (err) {
    log.warn(
      { err, startDate: args.startDate, endDate: args.endDate, label: args.label },
      "Failed to load episode-derived reflection signals — continuing",
    );
    return "";
  }
}
