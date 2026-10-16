/**
 * URL joining, in one place.
 *
 * ★ WHY THIS IS NOT A ONE-LINE TEMPLATE STRING.
 *
 * Three modules had already grown their own copy of the same two-step
 * normalisation — strip trailing slashes off the base, strip leading slashes
 * off the path — and a fourth was about to add a fifth. The rule is tiny, which
 * is exactly why it gets re-invented: a base URL configured as
 * `https://ledger.example.com/` produces `https://ledger.example.com//#/reset/x`
 * unless the separator is handled once.
 *
 * It lives in `utils/` rather than beside the email templates because the
 * templates are NOT the only thing that builds a link — and importing the
 * Handlebars engine (which validates every message pair at module load) into the
 * webhook route to reach a two-line function would put a template loader on the
 * callback's import graph for no reason at all.
 *
 * PURE, and reads no environment: a caller passes the base it was given, so a
 * test needs no configuration to exercise it.
 */

/** Join a base URL and a path without doubling or dropping the separator. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}