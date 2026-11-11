import { Router } from "express";
import { z } from "zod";
import type { RateLimitConfig } from "../config/types.js";
import {
  ENQUIRY_STATUS,
  ENQUIRY_STATUSES,
  HTTP_STATUS,
  LEAD_TAGS,
  LIMITS,
  MESSAGES,
  ROUTES,
  TIME,
} from "../constants.js";
import { HttpError } from "../http/errors.js";
import { createRateLimiter } from "../http/rate-limit.js";
import { toPublicDto, type EnquiryService } from "./enquiry.service.js";

const SubmitSchema = z.object({
  name: z
    .string({ error: MESSAGES.VALIDATION.NAME_REQUIRED })
    .trim()
    .min(1, MESSAGES.VALIDATION.NAME_REQUIRED)
    .max(LIMITS.NAME_MAX_LENGTH),
  message: z
    .string({ error: MESSAGES.VALIDATION.MESSAGE_REQUIRED })
    .trim()
    .min(1, MESSAGES.VALIDATION.MESSAGE_REQUIRED)
    .max(LIMITS.MESSAGE_MAX_LENGTH),
});

const ListQuerySchema = z.object({
  tag: z.enum(LEAD_TAGS).optional(),
  status: z.enum(ENQUIRY_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(LIMITS.PAGE_DEFAULT),
  limit: z.coerce.number().int().min(1).max(LIMITS.PAGE_SIZE_MAX).default(LIMITS.PAGE_SIZE_DEFAULT),
});

/** Public: anyone can submit an enquiry. Rate limited because each call costs an LLM request. */
export function publicEnquiryRouter(service: EnquiryService, limits: RateLimitConfig) {
  const router = Router();
  const limiter = createRateLimiter({
    windowMs: TIME.ONE_MINUTE_MS,
    limit: limits.submitPerMinute,
    message: MESSAGES.RATE_LIMIT.SUBMIT,
  });

  /**
   * 201 Created  – saved and replied to.
   * 202 Accepted – saved, but the LLM failed; `notice` explains, admins can retry.
   */
  router.post(ROUTES.ROOT, limiter, async (req, res) => {
    const input = SubmitSchema.parse(req.body);
    const enquiry = await service.submit(input);
    const replied = enquiry.status === ENQUIRY_STATUS.PROCESSED;
    res.status(replied ? HTTP_STATUS.CREATED : HTTP_STATUS.ACCEPTED).json(toPublicDto(enquiry));
  });

  return router;
}

/** Admin: mount behind requireAuth. */
export function adminEnquiryRouter(service: EnquiryService) {
  const router = Router();

  router.get(ROUTES.ROOT, async (req, res) => {
    res.json(await service.list(ListQuerySchema.parse(req.query)));
  });

  router.post(ROUTES.RETRY, async (req, res) => {
    const enquiry = await service.retry(req.params.id);
    if (!enquiry) throw new HttpError(HTTP_STATUS.NOT_FOUND, MESSAGES.ERRORS.ENQUIRY_NOT_FOUND);
    res.json(enquiry);
  });

  return router;
}
