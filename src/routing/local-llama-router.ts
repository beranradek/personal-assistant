import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getLlama, LlamaChatSession, resolveModelFile } from "node-llama-cpp";

export interface RouterDecision {
  profile: string;
  confidence: number;
  reason: string;
  flags: {
    has_code: boolean;
    needs_web: boolean;
    needs_tools: boolean;
  };
}

interface RouterRuntime {
  session: LlamaChatSession;
  grammar: { parse: (text: string) => unknown };
}

function resolveUserPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function resolveGgufPath(modelPath: string): Promise<string> {
  if (modelPath.startsWith("hf:")) return resolveModelFile(modelPath);
  return resolveUserPath(modelPath);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}

function parseDecision(parsed: unknown, candidates: string[]): RouterDecision | null {
  if (!isRecord(parsed)) return null;
  if (typeof parsed["profile"] !== "string") return null;
  if (!candidates.includes(parsed["profile"])) return null;
  if (typeof parsed["confidence"] !== "number") return null;
  if (typeof parsed["reason"] !== "string") return null;

  const flags = parsed["flags"];
  if (!isRecord(flags)) return null;
  const has_code = flags["has_code"];
  const needs_web = flags["needs_web"];
  const needs_tools = flags["needs_tools"];
  if (typeof has_code !== "boolean") return null;
  if (typeof needs_web !== "boolean") return null;
  if (typeof needs_tools !== "boolean") return null;

  return {
    profile: parsed["profile"],
    confidence: parsed["confidence"],
    reason: parsed["reason"],
    flags: { has_code, needs_web, needs_tools },
  };
}

const runtimeByResolvedPath = new Map<string, Promise<RouterRuntime>>();

async function getRuntime(modelPath: string, candidates: string[]): Promise<RouterRuntime> {
  const resolvedPath = await resolveGgufPath(modelPath);
  const cached = runtimeByResolvedPath.get(resolvedPath);
  if (cached) return cached;

  const promise = (async (): Promise<RouterRuntime> => {
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Router GGUF model not found: ${resolvedPath}`);
    }

    const llama = await getLlama();
    const model = await llama.loadModel({
      modelPath: resolvedPath,
      useMmap: true,
      gpuLayers: 0,
    });

    const context = await model.createContext({ contextSize: { max: 4096 } });
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt:
        "You are a router. Select the best target profile for handling the user's message.\n" +
        "Return ONLY a JSON object that matches the schema.\n" +
        "Be conservative: if unsure, choose the safest general profile.",
      forceAddSystemPrompt: true,
    });

    const grammar = await llama.createGrammarForJsonSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        profile: { type: "string", enum: candidates },
        confidence: { type: "number" },
        reason: { type: "string" },
        flags: {
          type: "object",
          additionalProperties: false,
          properties: {
            has_code: { type: "boolean" },
            needs_web: { type: "boolean" },
            needs_tools: { type: "boolean" },
          },
          required: ["has_code", "needs_web", "needs_tools"],
        },
      },
      required: ["profile", "confidence", "reason", "flags"],
    });

    return { session, grammar: grammar as unknown as { parse: (text: string) => unknown } };
  })();

  runtimeByResolvedPath.set(resolvedPath, promise);
  return promise;
}

export async function routeWithLocalLlama(options: {
  modelPath: string;
  message: string;
  candidates: string[];
  defaultProfile: string;
  timeoutMs: number;
}): Promise<RouterDecision | null> {
  const { modelPath, message, candidates, defaultProfile, timeoutMs } = options;
  if (candidates.length === 0) return null;

  const effectiveCandidates = candidates.includes(defaultProfile)
    ? candidates
    : [defaultProfile, ...candidates];

  const runtimePromise = getRuntime(modelPath, effectiveCandidates);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("router_timeout")), timeoutMs);

  try {
    const runtime = await runtimePromise;
    runtime.session.resetChatHistory();

    const prompt =
      "Choose a profile for this message.\n\n" +
      `Candidates: ${effectiveCandidates.join(", ")}\n\n` +
      "Message:\n" +
      message;

    const raw = await runtime.session.prompt(prompt, {
      grammar: runtime.grammar as any,
      temperature: 0,
      maxTokens: 256,
      trimWhitespaceSuffix: true,
      stopOnAbortSignal: true,
      signal: controller.signal,
    } as any);

    const parsed = runtime.grammar.parse(raw);
    return parseDecision(parsed, effectiveCandidates);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

