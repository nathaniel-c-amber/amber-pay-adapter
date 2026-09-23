/**
 * The transactional messages: three thin functions that turn typed props into the
 * context a Handlebars message needs.
 *
 * https://handlebarsjs.com/
 *
 * What lives where:
 * - `partials/*.hbs` — components (structure).
 * - `messages/*.hbs` — copy and composition, plus a `.text.hbs` sibling.
 * - `styles.ts` / `theme.ts` — every declaration and every value.
 * - this file — the envelope: the subject, and the data the copy interpolates.
 *
 * So the copy is editable by anyone who can write HTML, and this module stays
 * boring. It is pure: it reads no environment, which is why a test can call it
 * with nothing set up. The senders in `services/auth/*` are the only place that
 * reads `env`.
 *
 * Copy rules, from `DESIGN.md` and the product's vocabulary:
 * - Say what is operationally happening, not internal shorthand. "Your
 *   verification code is …", never "OTP sent".
 * - Quote the same threshold the backend enforces (`expiresIn` is derived from
 *   the same TTL env var that sets the record's `expiresAt`), so a message cannot
 *   promise a lifetime the service does not honour.
 * - Never over-specify a failure, and never imply an action was taken.
 */

import { renderMessage } from './engine.js';

export interface RenderedEmail {
  subject: string;
  /** Plain-text alternative. Always sent alongside the HTML. */
  text: string;
  html: string;
}

/* ------------------------------------------------------------------- links */

/** Join a base URL and a path without doubling or dropping the separator. */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * The invite link. The console is a hash router (`web/src/router.ts`) and `invite`
 * is a detail route, so the token is a path segment of the hash, exactly like the
 * password-reset link.
 */
export function inviteUrl(baseUrl: string, token: string): string {
  return joinUrl(baseUrl, `#/invite/${encodeURIComponent(token)}`);
}

/** The password-reset link — `#/reset/:token`. */
export function resetUrl(baseUrl: string, token: string): string {
  return joinUrl(baseUrl, `#/reset/${encodeURIComponent(token)}`);
}

/* -------------------------------------------------------- envelope & render */

/**
 * Subjects live here rather than in the markup: a subject is the envelope, not the
 * body, and it must never contain markup — which is exactly what a `.hbs` file
 * invites. Each name must have a matching pair of files in `messages/`
 * (`<name>.hbs` and `<name>.text.hbs`), which the engine enforces at load.
 */
const SUBJECTS = {
  invite: 'Your Amber Pay Ledger invite',
  'password-reset': 'Reset your Amber Pay Ledger password',
  'two-factor': 'Your Amber Pay Ledger verification code',
} as const;

type MessageName = keyof typeof SUBJECTS;

function render(name: MessageName, context: Record<string, unknown>): RenderedEmail {
  const { html, text } = renderMessage(name, context);
  return { subject: SUBJECTS[name], html, text };
}

/* -------------------------------------------------------------- formatting */

const TTL_UNITS: Record<string, [string, string]> = {
  s: ['second', 'seconds'],
  m: ['minute', 'minutes'],
  h: ['hour', 'hours'],
  d: ['day', 'days'],
};

/**
 * Turn a TTL env value (`48h`, `1h`, `5m`) into the phrase used in the copy.
 *
 * The value is *converted*, never re-derived, so the message and the stored
 * `expiresAt` come from one number. An unrecognised format is passed through
 * unchanged rather than guessed at — a wrong lifetime in a credential email is
 * worse than an awkward one.
 */
export function humanizeTtl(ttl: string): string {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) {
    return ttl;
  }
  const amount = Number(match[1]);
  const [singular, plural] = TTL_UNITS[match[2] as string] as [string, string];
  return `${amount} ${amount === 1 ? singular : plural}`;
}

/* ----------------------------------------------------------------- invite */

export interface InviteEmailProps {
  token: string;
  /** `env.APP_BASE_URL` — the console's public origin. */
  baseUrl: string;
  /** Human phrase from `humanizeTtl(env.INVITE_TTL)`, e.g. "48 hours". */
  expiresIn: string;
}

/**
 * Sent by an administrator's `POST /auth/invite`, or by a resend
 * (`POST /users/:id/resend-invite`).
 */
export function renderInviteEmail(props: InviteEmailProps): RenderedEmail {
  return render('invite', {
    url: inviteUrl(props.baseUrl, props.token),
    expiresIn: props.expiresIn,
  });
}

/* ----------------------------------------------------------- password reset */

export interface PasswordResetEmailProps {
  token: string;
  baseUrl: string;
  /** Human phrase from `humanizeTtl(env.PASSWORD_RESET_TTL)`, e.g. "1 hour". */
  expiresIn: string;
}

/** Sent by `POST /auth/forgot-password`, which always answers 202. */
export function renderPasswordResetEmail(props: PasswordResetEmailProps): RenderedEmail {
  return render('password-reset', {
    url: resetUrl(props.baseUrl, props.token),
    expiresIn: props.expiresIn,
  });
}

/* -------------------------------------------------------------------- 2FA */

export interface TwoFactorEmailProps {
  code: string;
  /** Human phrase from `humanizeTtl(env.TWO_FACTOR_TTL)`, e.g. "5 minutes". */
  expiresIn: string;
}

/** Sent during sign-in, before any session exists. */
export function renderTwoFactorEmail(props: TwoFactorEmailProps): RenderedEmail {
  return render('two-factor', { code: props.code, expiresIn: props.expiresIn });
}
