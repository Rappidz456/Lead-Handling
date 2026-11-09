import cors from "cors";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import type { AppConfig } from "./config/types.js";
import { DB, HTTP, ROUTES } from "./constants.js";
import { authRouter, requireAuth } from "./auth/auth.js";
import { adminEnquiryRouter, publicEnquiryRouter } from "./enquiries/enquiry.routes.js";
import { EnquiryService } from "./enquiries/enquiry.service.js";
import { errorHandler, notFound } from "./http/errors.js";
import type { EnquiryTriager } from "./llm/triage.js";

export interface AppDeps {
  config: AppConfig;
  triager: EnquiryTriager;
}

/**
 * Builds the Express app purely from injected dependencies. Nothing here reads
 * process.env, so the app can be created with any config, LLM provider or test fake.
 */
export function createApp({ config, triager }: AppDeps) {
  const app = express();
  const enquiries = new EnquiryService(triager);

  app.set(HTTP.TRUST_PROXY_SETTING, config.http.trustProxy);
  app.use(helmet());
  if (config.http.corsOrigins.length > 0) {
    const origin = config.http.corsOrigins.includes(HTTP.CORS_WILDCARD) ? HTTP.CORS_WILDCARD : config.http.corsOrigins;
    app.use(cors({ origin }));
  }
  app.use(express.json({ limit: config.http.bodyLimit }));

  app.get(ROUTES.HEALTH, (_req, res) => {
    const dbUp = mongoose.connection.readyState === DB.READY_STATE_CONNECTED;
    res.json({ ok: true, db: dbUp ? HTTP.HEALTH_DB_UP : HTTP.HEALTH_DB_DOWN });
  });

  app.use(ROUTES.ENQUIRIES_BASE, publicEnquiryRouter(enquiries, config.rateLimit));
  app.use(ROUTES.AUTH_BASE, authRouter(config.auth, config.rateLimit));
  app.use(ROUTES.ADMIN_ENQUIRIES_BASE, requireAuth(config.auth.jwtSecret), adminEnquiryRouter(enquiries));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
