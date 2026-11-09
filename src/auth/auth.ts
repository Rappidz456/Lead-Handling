import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";
import { z } from "zod";
import type { AuthConfig, RateLimitConfig } from "../config/types.js";
import { AUTH, HTTP_STATUS, MESSAGES, ROUTES, TEXT, TIME } from "../constants.js";
import { HttpError } from "../http/errors.js";
import { createRateLimiter } from "../http/rate-limit.js";

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/** Constant-time string compare (hash first so lengths always match). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash(AUTH.COMPARE_HASH_ALGORITHM).update(a).digest();
  const hb = createHash(AUTH.COMPARE_HASH_ALGORITHM).update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function authRouter(config: AuthConfig, limits: RateLimitConfig) {
  const router = Router();
  const loginLimiter = createRateLimiter({
    windowMs: limits.loginWindowMinutes * TIME.ONE_MINUTE_MS,
    limit: limits.loginMaxAttempts,
    message: MESSAGES.RATE_LIMIT.LOGIN,
  });

  router.post(ROUTES.LOGIN, loginLimiter, (req, res) => {
    const { username, password } = LoginSchema.parse(req.body);
    // Evaluate both so timing doesn't reveal whether the username was right.
    const userOk = safeEqual(username, config.adminUsername);
    const passOk = safeEqual(password, config.adminPassword);
    if (!userOk || !passOk) throw new HttpError(HTTP_STATUS.UNAUTHORIZED, MESSAGES.ERRORS.INVALID_CREDENTIALS);

    const token = jwt.sign({ role: AUTH.ADMIN_ROLE }, config.jwtSecret, {
      subject: username,
      expiresIn: config.jwtExpiresIn as SignOptions["expiresIn"],
    });
    res.json({ token, tokenType: AUTH.TOKEN_TYPE, expiresIn: config.jwtExpiresIn });
  });

  return router;
}

export function requireAuth(jwtSecret: string): RequestHandler {
  return (req, _res, next) => {
    const [scheme, token] = (req.headers.authorization ?? TEXT.EMPTY).split(AUTH.AUTH_HEADER_SEPARATOR);
    if (scheme !== AUTH.TOKEN_TYPE || !token) {
      return next(new HttpError(HTTP_STATUS.UNAUTHORIZED, MESSAGES.ERRORS.MISSING_TOKEN));
    }
    try {
      const payload = jwt.verify(token, jwtSecret);
      if (typeof payload !== "object" || payload.role !== AUTH.ADMIN_ROLE) {
        return next(new HttpError(HTTP_STATUS.UNAUTHORIZED, MESSAGES.ERRORS.INVALID_TOKEN));
      }
      next();
    } catch {
      next(new HttpError(HTTP_STATUS.UNAUTHORIZED, MESSAGES.ERRORS.INVALID_TOKEN));
    }
  };
}
