import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, NotFoundError, toHttpError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** Terminal 404 handler: mounted after every route. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  const { status, body } = toHttpError(new NotFoundError('Route not found'));
  res.status(status).json(body);
};

/**
 * Centralized error handler. Operational errors are expected and log at warn
 * without a stack trace; unknown errors are bugs and log at error with the
 * stack. Both paths respond with the same normalized HTTP error body.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof AppError && err.isOperational) {
    logger.warn({ code: err.code, statusCode: err.statusCode }, err.message);
  } else {
    logger.error({ err }, 'Unhandled error');
  }

  const { status, body } = toHttpError(err);
  res.status(status).json(body);
};
