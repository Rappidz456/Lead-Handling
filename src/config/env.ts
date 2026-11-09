import dotenv from "dotenv";
import { expand } from "dotenv-expand";
import { z } from "zod";
import { ENV_DEFAULTS as D, ENV_MESSAGES, ENV_RULES, LOG_MESSAGES, NODE_ENVS, TEXT } from "../constants.js";
import type { AppConfig, LlmConfig } from "./types.js";

// Load .env and expand ${VAR} references, e.g. MONGODB_URI=...:${DBPASSWORD}@...
expand(dotenv.config({ quiet: true }));

/**
 * The only place that reads process.env. Everything is validated once at startup;
 * if something required is missing the process exits with a clear message instead
 * of failing on the first request. Defaults come from ENV_DEFAULTS in constants.ts.
 */
const required = () => z.string({ error: ENV_MESSAGES.REQUIRED }).trim().min(1, ENV_MESSAGES.REQUIRED);
const requiredMin = (min: number) => required().min(min, ENV_MESSAGES.MIN_LENGTH(min));

const text = (fallback: string) => z.string().trim().min(1).default(fallback);
const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const EnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default(D.NODE_ENV),
  PORT: positiveInt(D.PORT),

  // Database
  MONGODB_URI: required(),
  MONGODB_DB_NAME: text(D.MONGODB_DB_NAME),

  // LLM (Groq)
  GROQ_API_KEY: required(),
  GROQ_MODEL: text(D.GROQ_MODEL),
  LLM_TIMEOUT_MS: positiveInt(D.LLM_TIMEOUT_MS),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(ENV_RULES.LLM_MAX_RETRIES_MAX).default(D.LLM_MAX_RETRIES),
  LLM_TEMPERATURE: z.coerce
    .number()
    .min(ENV_RULES.LLM_TEMPERATURE_MIN)
    .max(ENV_RULES.LLM_TEMPERATURE_MAX)
    .default(D.LLM_TEMPERATURE),
  LLM_MAX_TOKENS: positiveInt(D.LLM_MAX_TOKENS),

  // Business context given to the LLM
  BUSINESS_NAME: text(D.BUSINESS_NAME),
  BUSINESS_DESCRIPTION: z.string().trim().default(D.BUSINESS_DESCRIPTION),

  // Admin auth
  ADMIN_USERNAME: required(),
  ADMIN_PASSWORD: requiredMin(ENV_RULES.ADMIN_PASSWORD_MIN_LENGTH),
  JWT_SECRET: requiredMin(ENV_RULES.JWT_SECRET_MIN_LENGTH),
  JWT_EXPIRES_IN: text(D.JWT_EXPIRES_IN),

  // HTTP
  TRUST_PROXY: z.coerce.number().int().min(0).default(D.TRUST_PROXY),
  BODY_LIMIT: text(D.BODY_LIMIT),
  CORS_ORIGINS: z.string().default(D.CORS_ORIGINS),

  // Rate limits
  SUBMIT_RATE_LIMIT_PER_MINUTE: positiveInt(D.SUBMIT_RATE_LIMIT_PER_MINUTE),
  LOGIN_RATE_LIMIT_MAX: positiveInt(D.LOGIN_RATE_LIMIT_MAX),
  LOGIN_RATE_LIMIT_WINDOW_MINUTES: positiveInt(D.LOGIN_RATE_LIMIT_WINDOW_MINUTES),
});

function loadEnv() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => LOG_MESSAGES.ENV_ISSUE(i.path.join(TEXT.PATH_SEPARATOR), i.message))
      .join(TEXT.LINE_BREAK);
    console.error(LOG_MESSAGES.ENV_INVALID(issues));
    process.exit(1);
  }
  return parsed.data;
}

const env = loadEnv();

const splitList = (value: string) =>
  value
    .split(ENV_RULES.LIST_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);

export const serverConfig = {
  port: env.PORT,
  mongoUri: env.MONGODB_URI,
  mongoDbName: env.MONGODB_DB_NAME,
};

export const llmConfig: LlmConfig = {
  apiKey: env.GROQ_API_KEY,
  model: env.GROQ_MODEL,
  timeoutMs: env.LLM_TIMEOUT_MS,
  maxRetries: env.LLM_MAX_RETRIES,
  temperature: env.LLM_TEMPERATURE,
  maxTokens: env.LLM_MAX_TOKENS,
  business: { name: env.BUSINESS_NAME, description: env.BUSINESS_DESCRIPTION },
};

export const appConfig: AppConfig = {
  http: {
    trustProxy: env.TRUST_PROXY,
    bodyLimit: env.BODY_LIMIT,
    corsOrigins: splitList(env.CORS_ORIGINS),
  },
  auth: {
    adminUsername: env.ADMIN_USERNAME,
    adminPassword: env.ADMIN_PASSWORD,
    jwtSecret: env.JWT_SECRET,
    jwtExpiresIn: env.JWT_EXPIRES_IN,
  },
  rateLimit: {
    submitPerMinute: env.SUBMIT_RATE_LIMIT_PER_MINUTE,
    loginMaxAttempts: env.LOGIN_RATE_LIMIT_MAX,
    loginWindowMinutes: env.LOGIN_RATE_LIMIT_WINDOW_MINUTES,
  },
};
