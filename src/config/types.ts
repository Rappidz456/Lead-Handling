/**
 * Typed runtime configuration. Kept separate from env.ts so modules (and tests)
 * can depend on the shape without triggering env loading.
 */

export interface BusinessConfig {
  /** Name the assistant replies on behalf of, e.g. "Acme Printing". */
  name: string;
  /** One or two sentences on what the business offers; gives the LLM context for replies and tagging. */
  description: string;
}

export interface LlmConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  temperature: number;
  maxTokens: number;
  business: BusinessConfig;
}

export interface AuthConfig {
  adminUsername: string;
  adminPassword: string;
  jwtSecret: string;
  jwtExpiresIn: string;
}

export interface HttpConfig {
  /** Express "trust proxy" hops. 0 locally; 1 behind a single reverse proxy (Render, Railway, Nginx). */
  trustProxy: number;
  /** Max JSON body size, e.g. "20kb". */
  bodyLimit: string;
  /** Allowed browser origins. Empty = CORS disabled (server-to-server / curl only). "*" = any origin. */
  corsOrigins: string[];
}

export interface RateLimitConfig {
  submitPerMinute: number;
  loginMaxAttempts: number;
  loginWindowMinutes: number;
}

export interface AppConfig {
  http: HttpConfig;
  auth: AuthConfig;
  rateLimit: RateLimitConfig;
}
