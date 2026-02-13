import pino from "pino";

export const logger = pino({
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});

export function createLogger(name: string) {
  return logger.child({ module: name });
}
