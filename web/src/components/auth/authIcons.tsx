/* Icons local to the unauthenticated surface.
 *
 * Wrapped from the same Lucide family the console uses, at the same stroke
 * weight and with the same `absoluteStrokeWidth` behaviour, so the auth screens
 * cannot drift into a second icon style. Kept separate from
 * `components/icons.tsx` because these names mean nothing to the console and the
 * console's names mean nothing here.
 */

import type { ComponentType } from "react";
import {
  ArrowRight,
  BadgeCheck,
  CircleCheck,
  Lock,
  Mail,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type { LucideProps } from "lucide-react";

type IconProps = { size?: number | string };

const DEFAULT_SIZE = 16;
const DEFAULT_STROKE = 1.5;

/**
 * Same wrapping contract as `components/icons.tsx`. The glyph must be typed as
 * `LucideProps`, not as the wrapper's own narrower props: Lucide icons accept
 * `strokeWidth`/`absoluteStrokeWidth`, and typing them out of existence made
 * every icon here a type error.
 */
function icon(Glyph: ComponentType<LucideProps>): ComponentType<IconProps> {
  const Wrapped = ({ size = DEFAULT_SIZE, ...rest }: IconProps) => (
    <Glyph
      size={size}
      strokeWidth={DEFAULT_STROKE}
      absoluteStrokeWidth
      aria-hidden
      focusable={false}
      {...rest}
    />
  );
  Wrapped.displayName = Glyph.displayName ?? Glyph.name ?? "AuthIcon";
  return Wrapped;
}

export const IconArrowRight = icon(ArrowRight);
export const IconLock = icon(Lock);
export const IconShield = icon(ShieldCheck);
export const IconMail = icon(Mail);
export const IconCheck = icon(CircleCheck);
export const IconVerified = icon(BadgeCheck);
export const IconWarn = icon(TriangleAlert);
