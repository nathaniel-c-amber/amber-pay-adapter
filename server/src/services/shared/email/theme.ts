/**
 * Email design tokens.
 *
 * The console has exactly one source of design truth: the `@theme` block in
 * `web/src/styles/tailwind.css`. Email cannot read it — clients strip or ignore
 * stylesheets, and CSS custom properties are unsupported almost everywhere — so
 * the same *decisions* are re-expressed here as literal values, which `styles.ts`
 * inlines into the markup (templates reach them through `{{token '…'}}`).
 *
 * Each token names the Tailwind token it mirrors. Nothing under `email/` may
 * inline a colour, radius, or font stack directly, because a drifting email
 * palette fails silently: no build step and no audit script can see inside an
 * HTML string. This file is the only guard, so a token change in `tailwind.css`
 * must be made here too.
 *
 * Two brand rules are carried over verbatim and must never be relaxed:
 *   1. `onPrimary` (dark ink) sits on the amber button. White on `#ef6000`
 *      measures 3.31:1 and fails WCAG AA — that was a real shipped defect.
 *   2. `ink4` is separators and disabled text only, never information.
 */

/** Colour tokens — mirrors `--color-*`. */
export const emailColor = {
  /** `--color-midnight` — the page ground. */
  ground: '#0a0e1a',
  /** `--color-midnight-2` — cards, tables, the sidebar. */
  surface: '#111827',
  /** `--color-midnight-3` — hover / selected surfaces, the code plate. */
  surfaceRaised: '#1a2236',
  /** `--color-ink-1` — values and headings. 16.6:1 on `surface`. */
  ink1: '#f8fafc',
  /** `--color-ink-2` — body and prose. 11.7:1. */
  ink2: '#cbd5e1',
  /** `--color-ink-3` — meta, labels, thresholds. 6.8:1. */
  ink3: '#94a3b8',
  /** `--color-ink-4` — separators and disabled only. 5.1:1, never information. */
  ink4: '#7c8ba0',
  /** `--color-rule-enamel` — hairlines and control borders. */
  rule: '#1e293b',
  /** `--color-primary` — the brand amber. */
  primary: '#ef6000',
  /** `--color-on-primary` — dark ink ON the amber. Never white. */
  onPrimary: '#1a1206',
  /** `--color-primary-ink` — the text-safe amber for links on dark. 7.5:1. */
  primaryInk: '#ff8c33',
  /** `--color-secondary-ink` — "Info" in the severity vocabulary. */
  infoInk: '#d49cc4',
  /** `--color-text-delayed` — "Degraded"/warn tone. */
  warnInk: '#fbbf24',
  /** `--color-text-suspended` — "Failed" tone, used for security notices. */
  dangerInk: '#f87171',
  /** `--color-line-green` — "Healthy". */
  healthyInk: '#39b98a',
} as const;

/**
 * Font stacks — mirrors `--font-sans` / `--font-mono`.
 *
 * Geist Variable is listed first so a client that has it (or resolves it from a
 * system install) gets the console's face; the rest of each stack is the same
 * fallback chain the stylesheet declares. Emails never load a webfont: it
 * inflates the message, is blocked by default in most clients, and would shift
 * layout when it eventually arrives.
 *
 * The families are single-quoted, not double-quoted as in `tailwind.css`. These
 * strings are inlined into a `style="..."` attribute, so a double quote would
 * terminate the attribute: every declaration after it (colour, underline, radius)
 * would vanish with no error anywhere. `styles.ts` escapes the attribute as well,
 * so this is defence in depth — but keep the single quotes.
 */
export const emailFont = {
  sans: "'Geist Variable', 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'Geist Mono Variable', 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
} as const;

/** Type scale — mirrors `--text-*`. 11px is the floor, for short uppercase labels. */
export const emailText = {
  micro: '11px',
  xs: '12px',
  sm: '13px',
  md: '14px',
  lg: '15px',
  base: '16px',
  xl: '17px',
  '2xl': '20px',
  '3xl': '24px',
} as const;

/** Line heights — mirrors `--leading-*`. Light-on-dark prose needs `prose`. */
export const emailLeading = {
  tight: '1.25',
  snug: '1.4',
  base: '1.5',
  prose: '1.65',
} as const;

/** Letter spacing — mirrors `--tracking-*`. */
export const emailTracking = {
  tight: '-0.011em',
  label: '0.055em',
} as const;

/** Weights — mirrors `--font-weight-*`. The face tops out at 600; 700 is not reachable. */
export const emailWeight = {
  regular: '400',
  medium: '500',
  strong: '550',
  semibold: '600',
} as const;

/** Radii — mirrors `--radius-*`. Small radius only; circular is avatar/dot. */
export const emailRadius = {
  panel: '8px',
  chip: '6px',
} as const;

/**
 * Space scale — Tailwind's native 4px multiplier (`--spacing: 0.25rem`), named
 * by multiplier so it reads the same as the utilities in the console.
 */
export const emailSpace = {
  1: '4px',
  2: '8px',
  3: '12px',
  4: '16px',
  6: '24px',
  8: '32px',
  10: '40px',
} as const;

/** The card is a fixed measure; below `stackAt` it goes fluid. Email has one breakpoint. */
export const emailLayout = {
  cardWidth: '560px',
  stackAt: '600px',
} as const;

/** Product naming, so no template invents its own wordmark. */
export const emailBrand = {
  name: 'Amber Pay Ledger',
  /** The surface this email belongs to. */
  surface: 'Pay operations',
  /** Footer self-reference; kept separate so wordmark and footer can diverge. */
  system: 'Amber Pay Ledger',
} as const;

/**
 * The tokens above, flattened to a dotted index for the template layer.
 *
 * Templates reach tokens through the `{{token 'color.primary'}}` helper rather
 * than by hardcoding a hex, so a template cannot invent a colour and a renamed
 * token fails loudly instead of rendering an empty value. Keys are derived, never
 * hand-written, so this index cannot drift from the token objects.
 */
function flattenTokens(prefix: string, source: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).map(([name, value]) => [`${prefix}.${name}`, value]),
  );
}

export const emailTokens: Readonly<Record<string, string>> = {
  ...flattenTokens('color', emailColor),
  ...flattenTokens('font', emailFont),
  ...flattenTokens('text', emailText),
  ...flattenTokens('leading', emailLeading),
  ...flattenTokens('tracking', emailTracking),
  ...flattenTokens('weight', emailWeight),
  ...flattenTokens('radius', emailRadius),
  ...flattenTokens('space', emailSpace),
  ...flattenTokens('layout', emailLayout),
  ...flattenTokens('brand', emailBrand),
};
