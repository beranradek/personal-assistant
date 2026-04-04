import { createLogger } from "../core/logger.js";

const log = createLogger("openai-audio");

export type OpenAiAudioFormat = "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";

function normalizeOpenAiHost(baseUrl?: string | null): string {
  const raw = (baseUrl ?? process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com").trim();
  // Accept either https://host or https://host/v1 and normalize to host only
  return raw.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

function openAiUrl(host: string, path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${host}/v1${cleanPath}`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface TranscribeAudioParams {
  apiKey: string;
  baseUrl?: string | null;
  model: string;
  buffer: ArrayBuffer;
  fileName: string;
  mime?: string;
  language?: string;
  timeoutMs?: number;
}

export async function transcribeAudio(params: TranscribeAudioParams): Promise<string> {
  const host = normalizeOpenAiHost(params.baseUrl);
  const url = openAiUrl(host, "/audio/transcriptions");
  const timeoutMs = params.timeoutMs ?? 30_000;

  const form = new FormData();
  const bytes = new Uint8Array(params.buffer);
  const blob = new Blob([bytes], { type: params.mime ?? "application/octet-stream" });
  form.append("file", blob, params.fileName);
  form.append("model", params.model);
  if (params.language?.trim()) {
    form.append("language", params.language.trim());
  }

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: form,
    },
    timeoutMs,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI STT error (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { text?: string };
  const text = (json.text ?? "").trim();
  if (!text) {
    log.warn({ model: params.model }, "Empty transcription returned");
  }
  return text;
}

export interface SynthesizeSpeechParams {
  apiKey: string;
  baseUrl?: string | null;
  model: string;
  voice: string;
  input: string;
  format: OpenAiAudioFormat;
  speed?: number;
  timeoutMs?: number;
}

export function truncateForTts(text: string, maxLen: number = 4000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  const slice = trimmed.slice(0, maxLen);
  const last = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (last >= maxLen - 200) return `${slice.slice(0, last + 1)} ...`;
  return `${slice.trimEnd()}...`;
}

export async function synthesizeSpeech(params: SynthesizeSpeechParams): Promise<Uint8Array> {
  const host = normalizeOpenAiHost(params.baseUrl);
  const url = openAiUrl(host, "/audio/speech");
  const timeoutMs = params.timeoutMs ?? 30_000;

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        voice: params.voice,
        input: params.input,
        speed: params.speed,
        response_format: params.format,
      }),
    },
    timeoutMs,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI TTS error (${res.status}): ${body}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

