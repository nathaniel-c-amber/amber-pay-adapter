import { InternalError } from '../lib/errors.js';

/**
 * Parse a human duration such as '30s', '5m', '1h', '48h' into milliseconds.
 * A bare number is interpreted as seconds. Used for token/invite/2FA TTLs,
 * which all originate from configuration.
 */
export function parseDurationMs(duration: string): number {
  const match = /^(\d+)([smhd])?$/.exec(duration.trim());
  const valuePart = match?.[1];
  if (!valuePart) {
    throw new InternalError(`Invalid duration: '${duration}'`);
  }
  const value = Number(valuePart);
  const unit = match?.[2] ?? 's';
  const multiplier =
    unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * multiplier;
}

export function parseDurationSeconds(duration: string): number {
  return Math.floor(parseDurationMs(duration) / 1000);
}
