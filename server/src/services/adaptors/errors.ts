import { AppError } from '../../utils/errors.js';

/**
 * Base adaptor error. Extends AppError so it flows through `toHttpError` and
 * the centralized error handler.
 */
export class AdaptorError extends AppError {
  constructor(statusCode: number, code: string, message: string, isOperational = true) {
    super(statusCode, code, message, isOperational);
  }
}

export class AdaptorConnectionError extends AdaptorError {
  constructor(message = 'Adaptor connection failed') {
    super(502, 'ADAPTOR_CONNECTION_ERROR', message);
  }
}

/**
 * Upstream authentication/authorization failure. Mapped to 502 (Bad Gateway)
 * because the failure is on the upstream adaptor, not the client. 401 is
 * reserved for client-facing auth (Phase 4).
 */
export class AdaptorAuthError extends AdaptorError {
  constructor(message = 'Adaptor authentication failed') {
    super(502, 'ADAPTOR_AUTH_ERROR', message);
  }
}

/**
 * Upstream rate limit. Mapped to 502 (Bad Gateway) to avoid confusing the
 * client with a 429 that implies the client is rate-limited.
 */
export class AdaptorRateLimitError extends AdaptorError {
  constructor(message = 'Adaptor rate limit exceeded') {
    super(502, 'ADAPTOR_RATE_LIMIT_ERROR', message);
  }
}

export class AdaptorSyncError extends AdaptorError {
  constructor(message = 'Adaptor sync failed') {
    super(502, 'ADAPTOR_SYNC_ERROR', message);
  }
}

/**
 * Map an upstream HTTP status to the appropriate adaptor error. Used by
 * adaptors when a transport response is non-2xx.
 */
export function adaptorErrorForStatus(status: number, message: string): AdaptorError {
  if (status === 401 || status === 403) {
    return new AdaptorAuthError(message);
  }
  if (status === 429) {
    return new AdaptorRateLimitError(message);
  }
  if (status >= 500) {
    return new AdaptorConnectionError(message);
  }
  return new AdaptorError(status, 'ADAPTOR_ERROR', message);
}
