/**
 * Adapter Types
 * =============
 *
 * Re-exports core adapter interfaces and provides helper functions for
 * creating AdapterMessage objects from adapter-specific formats.
 */

export type { Adapter, AdapterMessage } from "../core/types.js";
import type { AdapterMessage } from "../core/types.js";

/** Common metadata fields that adapters may include. */
export interface AdapterMetadata {
  userName?: string;
  threadId?: string;
  attachments?: string[];
  [key: string]: unknown;
}

/**
 * Create an AdapterMessage from adapter-specific parameters.
 */
export function createAdapterMessage(
  source: string,
  sourceId: string,
  text: string,
  metadata?: AdapterMetadata,
): AdapterMessage {
  return { source, sourceId, text, metadata };
}
