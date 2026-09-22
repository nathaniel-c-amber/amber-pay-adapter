import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async route handler so any rejected promise is forwarded to the
 * Express error-handling middleware via `next(err)`.
 *
 * MANDATORY CONVENTION: every async route handler MUST be wrapped with
 * `asyncHandler`. In Express 4, a rejected promise from an async handler is
 * NOT caught automatically and can crash the process.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => fn(req, res, next).catch(next);
}
