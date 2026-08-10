import pino, { type Logger, type LoggerOptions } from "pino";
import type { AppConfig } from "../config/index.js";

export type { Logger };

/**
 * Redaction is configured here, in the base logger, rather than left to the
 * discipline of whoever writes the next log statement (spec §15, §26).
 *
 * `remove: true` deletes the field outright instead of substituting "[Redacted]" —
 * a redaction placeholder still confirms the header was present, and there is no
 * debugging value in knowing that an Authorization header existed.
 */
const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.Authorization",
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  "req.headers.cookie",
  "*.apiKey",
  "*.api_key",
  "*.password",
  "*.secret",
  "*.token",
  "apiKey",
  "api_key",
];

export function createLogger(
  config: AppConfig,
  /** Injected so the redaction rules can be asserted against real output. */
  destination?: pino.DestinationStream,
): Logger {
  const options: LoggerOptions = {
    level: config.logging.level,
    redact: { paths: REDACTED_PATHS, remove: true },
    base: { service: "openllm-gateway", env: config.env },
    // ISO timestamps: a human reading `docker compose logs` should not have to
    // convert epoch milliseconds in their head.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      // Fastify's defaults attach the whole request object. We want small,
      // predictable records — and nothing that could carry a body or credentials.
      req: (request: {
        method?: string;
        url?: string;
        headers?: Record<string, unknown>;
      }) => ({
        method: request.method,
        url: request.url,
        userAgent: request.headers?.["user-agent"],
      }),
      res: (reply: { statusCode?: number }) => ({ statusCode: reply.statusCode }),
    },
  };

  // A caller-supplied destination means plain JSON — a pretty transport would
  // reformat the very output a test is trying to inspect.
  if (destination !== undefined) return pino(options, destination);

  if (config.logging.pretty) {
    return pino({
      ...options,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname,service,env" },
      },
    });
  }

  return pino(options);
}
