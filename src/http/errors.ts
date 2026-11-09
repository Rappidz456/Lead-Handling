import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { HTTP, HTTP_STATUS, MESSAGES, TEXT, type HttpStatus } from "../constants.js";

export class HttpError extends Error {
  constructor(
    readonly status: HttpStatus,
    message: string,
  ) {
    super(message);
  }
}

export const notFound: RequestHandler = (_req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json({ error: MESSAGES.ERRORS.NOT_FOUND });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: MESSAGES.ERRORS.VALIDATION_FAILED,
      details: err.issues.map((i) => ({ field: i.path.join(TEXT.PATH_SEPARATOR), message: i.message })),
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err?.type === HTTP.JSON_PARSE_ERROR_TYPE) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: MESSAGES.ERRORS.INVALID_JSON_BODY });
    return;
  }
  console.error(err);
  res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: MESSAGES.ERRORS.INTERNAL });
};
