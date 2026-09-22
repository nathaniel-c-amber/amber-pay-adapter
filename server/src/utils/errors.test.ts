import { z } from 'zod';
import {
  AppError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  InternalError,
  toHttpError,
} from './errors.js';

describe('AppError', () => {
  it('is operational by default and carries status/code', () => {
    const err = new ValidationError('bad input');
    expect(err).toBeInstanceOf(AppError);
    expect(err.isOperational).toBe(true);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('bad input');
  });

  it('maps AppError to HTTP status and body via toHttpError', () => {
    const err = new NotFoundError('Invoice not found');
    const result = toHttpError(err);
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('NOT_FOUND');
    expect(result.body.error.message).toBe('Invoice not found');
    expect(result.body.error.statusCode).toBe(404);
  });

  it('maps unknown errors to a generic 500', () => {
    const result = toHttpError(new Error('boom'));
    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe('INTERNAL_ERROR');
    expect(result.body.error.message).toBe('Internal server error');
  });

  it('exposes correct codes for each subclass', () => {
    expect(new UnauthorizedError().code).toBe('UNAUTHORIZED');
    expect(new ForbiddenError().code).toBe('FORBIDDEN');
    expect(new ConflictError().code).toBe('CONFLICT');
    expect(new InternalError().code).toBe('INTERNAL_ERROR');
  });

  it('maps a ZodError to a 400 VALIDATION_ERROR with the issue list', () => {
    const schema = z.object({ name: z.string().min(1) });
    const result = schema.safeParse({ name: '' });
    expect(result.success).toBe(false);

    if (!result.success) {
      const http = toHttpError(result.error);
      expect(http.status).toBe(400);
      expect(http.body.error.code).toBe('VALIDATION_ERROR');
      expect(http.body.error.issues).toBeDefined();
      expect(http.body.error.issues![0]).toEqual({ path: 'name', message: expect.any(String) });
    }
  });
});
