import { AdaptorConnectionError } from './errors.js';
import type { AdaptorResponse, AdaptorTransport } from '../../types/adaptor.js';

/**
 * The real outbound HTTP transport.
 *
 * Until now every adaptor defaulted to a `stubTransport` that threw, so a
 * deployment with correct credentials could still never reach QuickBooks — the
 * console reported "not connected" forever and the only way to find out why was
 * to read the source. This is the seam the comments always pointed at, filled
 * in: `fetch` against the configured base URL, with a hard timeout so one hung
 * upstream cannot hold a request (or the ≤5s push budget) open.
 *
 * TWO ENCODINGS, ONE SIGNATURE. OAuth token endpoints
 * (`application/x-www-form-urlencoded`) and REST APIs (JSON) both go through
 * this transport, so the body encoding follows the caller's `Content-Type`
 * header. Defaulting everything to JSON is what makes a token exchange fail
 * with a confusing 400.
 *
 * Failures at the network layer are converted to `AdaptorConnectionError`
 * (502): "fetch failed" is not an operational message, and the adaptor's
 * callers branch on AdaptorError, not on Node's TypeError.
 */

const REQUEST_TIMEOUT_MS = 5000;
const FORM_URLENCODED = 'application/x-www-form-urlencoded';

/** Parse a JSON body, tolerating an empty or non-JSON one (some errors are HTML). */
export function parseJson(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function headerLookup(headers: Record<string, string>, name: string): string {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? (headers[key] ?? '') : '';
}

export const httpTransport: AdaptorTransport = async (method, url, body, headers = {}) => {
  const isForm = headerLookup(headers, 'content-type').startsWith(FORM_URLENCODED);
  const payload =
    body === undefined || body === null
      ? undefined
      : isForm
        ? new URLSearchParams(body as Record<string, string>).toString()
        : JSON.stringify(body);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...headers },
      ...(payload === undefined ? {} : { body: payload }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'request failed';
    throw new AdaptorConnectionError(`Upstream request to ${url} failed: ${reason}`);
  }

  const text = await response.text();
  return { status: response.status, body: parseJson(text) } satisfies AdaptorResponse;
};
