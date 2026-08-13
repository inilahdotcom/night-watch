import pino, { type Logger } from "pino";
import pretty from "pino-pretty";
import { loadEnv } from "./config/env.ts";

let root: Logger | null = null;

function getRoot(): Logger {
  if (root) return root;
  const env = loadEnv();
  if (env.NODE_ENV === "production") {
    root = pino({ level: env.LOG_LEVEL });
  } else {
    // Synchronous pretty stream — safer than pino's worker-thread transport
    // under bun and inside worker/CLI contexts.
    const stream = pretty({
      colorize: true,
      translateTime: "SYS:HH:MM:ss",
      ignore: "pid,hostname",
    });
    root = pino({ level: env.LOG_LEVEL }, stream);
  }
  return root;
}

export function createLogger(name: string): Logger {
  return getRoot().child({ name });
}
