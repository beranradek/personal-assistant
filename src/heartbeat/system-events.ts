import { SystemEvent } from "../core/types.js";

const MAX_EVENTS = 20;
const eventQueue: SystemEvent[] = [];

export function enqueueSystemEvent(text: string, type: SystemEvent["type"] = "system"): void {
  const event: SystemEvent = {
    type,
    text,
    timestamp: new Date().toISOString(),
  };
  eventQueue.push(event);
  if (eventQueue.length > MAX_EVENTS) {
    eventQueue.shift(); // Remove oldest
  }
}

export function peekSystemEvents(): SystemEvent[] {
  return [...eventQueue];
}

export function drainSystemEvents(): SystemEvent[] {
  const events = [...eventQueue];
  eventQueue.length = 0;
  return events;
}

export function clearSystemEvents(): void {
  eventQueue.length = 0;
}
