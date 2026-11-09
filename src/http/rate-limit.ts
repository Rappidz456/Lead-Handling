import rateLimit from "express-rate-limit";
import { HTTP } from "../constants.js";

/** Shared rate-limiter factory so every limiter responds in the same JSON shape. */
export function createRateLimiter(opts: { windowMs: number; limit: number; message: string }) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: HTTP.RATE_LIMIT_HEADERS_STANDARD,
    legacyHeaders: false,
    message: { error: opts.message },
  });
}
