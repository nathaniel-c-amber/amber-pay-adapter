import {
  AdaptorError,
  AdaptorAuthError,
  AdaptorConnectionError,
  AdaptorRateLimitError,
  adaptorErrorForStatus,
} from './errors.js';

describe('adaptor errors', () => {
  it('maps upstream auth failures to AdaptorAuthError (502)', () => {
    const err = adaptorErrorForStatus(401, 'unauthorized');
    expect(err).toBeInstanceOf(AdaptorAuthError);
    expect(err.statusCode).toBe(502);
  });

  it('maps upstream rate limits to AdaptorRateLimitError (502)', () => {
    const err = adaptorErrorForStatus(429, 'rate limited');
    expect(err).toBeInstanceOf(AdaptorRateLimitError);
    expect(err.statusCode).toBe(502);
  });

  it('maps upstream 5xx to AdaptorConnectionError (502)', () => {
    const err = adaptorErrorForStatus(500, 'server error');
    expect(err).toBeInstanceOf(AdaptorConnectionError);
    expect(err.statusCode).toBe(502);
  });

  it('maps other non-2xx to a generic AdaptorError', () => {
    const err = adaptorErrorForStatus(400, 'bad request');
    expect(err).toBeInstanceOf(AdaptorError);
    expect(err.statusCode).toBe(400);
  });
});
