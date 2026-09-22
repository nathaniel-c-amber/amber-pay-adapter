import { ZodError } from 'zod';

/**
 * Central error model. All expected failures derive from AppError and are
 * considered operational (safe to surface). Unknown errors map to 500.
 */

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly isOperational: boolean;

  constructor(statusCode: number, code: string, message: string, isOperational = true) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, 'FORBIDDEN', message);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(400, 'VALIDATION_ERROR', message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(409, 'CONFLICT', message);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests') {
    super(429, 'TOO_MANY_REQUESTS', message);
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal server error') {
    super(500, 'INTERNAL_ERROR', message);
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface HttpErrorBody {
  error: {
    code: string;
    message: string;
    statusCode: number;
    issues?: ValidationIssue[];
  };
}

export interface HttpErrorResult {
  status: number;
  body: HttpErrorBody;
}

/**
 * Map any thrown value to a safe HTTP response.
 * - `zod.ZodError` -> 400 `VALIDATION_ERROR` with the issue list surfaced.
 * - `AppError` -> surfaced with its own status/code.
 * - anything else -> 500 `INTERNAL_ERROR`.
 */
export function toHttpError(err: unknown): HttpErrorResult {
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          statusCode: 400,
          issues: err.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      },
    };
  }

  if (err instanceof AppError) {
    return {
      status: err.statusCode,
      body: {
        error: {
          code: err.code,
          message: err.message,
          statusCode: err.statusCode,
        },
      },
    };
  }

  const internal = new InternalError();
  return {
    status: internal.statusCode,
    body: {
      error: {
        code: internal.code,
        message: internal.message,
        statusCode: internal.statusCode,
      },
    },
  };
}
