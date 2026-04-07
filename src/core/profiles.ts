import type { Config } from "./types.js";

export type ProfileName = string;

export interface ResolvedProfile {
  name: ProfileName;
  backend: "claude" | "codex" | "local_llama";
  model: Config["profiles"][string]["model"];
  tools: Config["profiles"][string]["tools"];
}

export function resolveProfile(config: Config, name: ProfileName): ResolvedProfile {
  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(`Unknown profile '${name}'.`);
  }
  return { name, backend: profile.backend, model: profile.model, tools: profile.tools };
}

export function resolvePrimaryModelRef(model: ResolvedProfile["model"]): string | null {
  if (model === null) return null;
  if (typeof model === "string") return model;
  if ("primary" in model) return model.primary;
  return null;
}

export function resolveFallbackModelRefs(model: ResolvedProfile["model"]): string[] {
  if (model === null) return [];
  if (typeof model === "string") return [];
  if ("fallbacks" in model) return model.fallbacks ?? [];
  return [];
}
