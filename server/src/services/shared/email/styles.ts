/**
 * Email styles — the design system, expressed as named recipes.
 *
 * The templates in `partials/` and `messages/` own structure and copy; they own
 * no styling at all. Every element gets its declarations from a recipe here, via
 * `{{styleAttr 'name'}}`, so there is exactly one place in email-land where a
 * colour, size, or border is decided — and it is next to the token it mirrors.
 *
 * Why recipes instead of inline `style="…"` in the markup: a typo'd utility in
 * the console is caught by `audit:classes`, but nothing audits an HTML string.
 * `styleDeclaration` therefore throws on an unknown recipe, so a mistyped name
 * fails the moment it is rendered rather than shipping an unstyled element.
 *
 * Everything is inline because clients strip stylesheets and ignore CSS custom
 * properties. The one exception is the `<style>` block in `shell.hbs`, which
 * carries only what inline styles cannot express.
 */

import {
  emailColor,
  emailFont,
  emailLayout,
  emailLeading,
  emailRadius,
  emailSpace,
  emailText,
  emailTracking,
  emailWeight,
} from './theme.js';

/** Values accepted by `css()`. Numbers become px unless the property is unitless. */
export type StyleValue = string | number | undefined;
export type Styles = Record<string, StyleValue>;

/** Properties whose numeric values are not lengths. */
const UNITLESS = new Set(['font-weight', 'line-height', 'opacity', 'z-index']);

function toKebab(property: string): string {
  return property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/** Serialise a declaration list. */
export function css(styles: Styles): string {
  return Object.entries(styles)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([property, value]) => {
      const name = toKebab(property);
      const serialised =
        typeof value === 'number' && !UNITLESS.has(name) ? `${value}px` : String(value);
      return `${name}:${serialised}`;
    })
    .join(';');
}

/**
 * Escape a declaration list for the double-quoted `style` attribute it lands in.
 *
 * A double quote inside a CSS value would end the attribute early and every later
 * declaration would be parsed as stray markup — silently, because the CSS that
 * survives still renders. This is why the font stacks in `theme.ts` are
 * single-quoted and why this escape exists as well: the failure is invisible.
 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ---------------------------------------------------------------- shared bits */

const HAIRLINE = `1px solid ${emailColor.rule}`;
const BLOCK_GAP = emailSpace[6];

/** Every block in a message is one block-gap apart. */
const BLOCK = { margin: `0 0 ${BLOCK_GAP}` };

/**
 * The micro-label pattern (`DESIGN.md`): 11px uppercase mono at `--tracking-label`
 * on ink-3. The console's most reused treatment, so it is defined once.
 */
const MICRO_LABEL: Styles = {
  margin: '0',
  fontFamily: emailFont.mono,
  fontSize: emailText.micro,
  fontWeight: emailWeight.medium,
  letterSpacing: emailTracking.label,
  textTransform: 'uppercase',
  lineHeight: emailLeading.snug,
  color: emailColor.ink3,
};

/**
 * Tracking for a one-time code: wide, so the digits can be read off a phone
 * without losing their place. A deliberate readout treatment, not a token.
 * `code.plate` also uses it as left padding, because the letter-space is added
 * after the last digit and would otherwise bias the readout off centre.
 */
const CODE_TRACKING = '0.28em';

/** A tone is a severity ink, by construction — never an ad-hoc tint. */
function noticeBorder(ink: string): Styles {
  return { borderLeft: `1px solid ${ink}`, padding: `0 0 0 ${emailSpace[3]}` };
}

function noticeLabel(ink: string): Styles {
  return { ...MICRO_LABEL, color: ink, padding: `0 0 ${emailSpace[1]}` };
}

/* ------------------------------------------------------------------ registry */

export const STYLE_RECIPES: Readonly<Record<string, Styles>> = {
  /* --------------------------------------------------------------- shell */
  'shell.body': { margin: 0, padding: 0, width: '100%', backgroundColor: emailColor.ground },
  'shell.ground': { width: '100%', backgroundColor: emailColor.ground },
  'shell.groundCell': { padding: `${emailSpace[8]} ${emailSpace[4]}` },
  'shell.card': {
    width: emailLayout.cardWidth,
    maxWidth: emailLayout.cardWidth,
    backgroundColor: emailColor.surface,
    border: HAIRLINE,
    borderRadius: emailRadius.panel,
  },
  'shell.cardCell': { padding: emailSpace[8] },
  // Inline as well as the `.email-preheader` rule in the head: a client that
  // strips <style> would otherwise reveal the preview line as body copy.
  'shell.preheader': {
    display: 'none',
    visibility: 'hidden',
    opacity: '0',
    color: 'transparent',
    height: '0',
    width: '0',
    overflow: 'hidden',
    msoHide: 'all',
  },
  'shell.footerTable': { width: emailLayout.cardWidth, margin: `${emailSpace[4]} auto 0` },
  'shell.footerCell': {
    fontFamily: emailFont.mono,
    fontSize: emailText.xs,
    lineHeight: emailLeading.prose,
    color: emailColor.ink3,
  },

  /* ----------------------------------------------------------- brand bar */
  'brandBar.table': { ...BLOCK },
  'brandBar.cell': {
    padding: `0 0 ${emailSpace[3]}`,
    borderBottom: HAIRLINE,
    fontFamily: emailFont.mono,
    fontSize: emailText.micro,
    fontWeight: emailWeight.medium,
    letterSpacing: emailTracking.label,
    textTransform: 'uppercase',
    lineHeight: emailLeading.snug,
    color: emailColor.ink3,
  },
  'brandBar.separator': { color: emailColor.ink4 },

  /* ----------------------------------------------------------- typography */
  'eyebrow.table': { margin: `0 0 ${emailSpace[2]}` },
  'eyebrow.cell': { ...MICRO_LABEL, padding: '0' },
  'heading.table': { margin: `0 0 ${emailSpace[3]}` },
  'heading.cell': {
    margin: '0',
    padding: '0',
    fontFamily: emailFont.sans,
    fontSize: emailText['2xl'],
    fontWeight: emailWeight.strong,
    letterSpacing: emailTracking.tight,
    lineHeight: emailLeading.tight,
    color: emailColor.ink1,
  },
  'paragraph.table': { ...BLOCK },
  'paragraph.cell': {
    margin: '0',
    padding: '0',
    fontFamily: emailFont.sans,
    fontSize: emailText.md,
    fontWeight: emailWeight.regular,
    lineHeight: emailLeading.prose,
    color: emailColor.ink2,
  },
  'divider.table': { ...BLOCK },
  'divider.cell': { borderTop: HAIRLINE, lineHeight: '0', fontSize: '0' },

  /* ---------------------------------------------------------------- link */
  'link.anchor': {
    color: emailColor.primaryInk,
    textDecoration: 'underline',
    wordBreak: 'break-all',
  },

  /* -------------------------------------------------------------- button */
  'button.table': { ...BLOCK },
  'button.box': {
    backgroundColor: emailColor.primary,
    borderRadius: emailRadius.chip,
    msoPaddingAlt: `0 ${emailSpace[6]}`,
    textAlign: 'center',
  },
  // `onPrimary`, never white: white on the amber is 3.31:1 and fails AA.
  'button.anchor': {
    display: 'inline-block',
    padding: `${emailSpace[3]} ${emailSpace[6]}`,
    fontFamily: emailFont.sans,
    fontSize: emailText.md,
    fontWeight: emailWeight.strong,
    lineHeight: '1',
    color: emailColor.onPrimary,
    textDecoration: 'none',
    borderRadius: emailRadius.chip,
  },

  /* ------------------------------------------------------- fallback link */
  'fallback.table': { ...BLOCK },
  'fallback.label': { ...MICRO_LABEL, padding: `0 0 ${emailSpace[1]}` },
  'fallback.value': {
    fontFamily: emailFont.mono,
    fontSize: emailText.xs,
    lineHeight: emailLeading.base,
    color: emailColor.ink3,
    wordBreak: 'break-all',
  },

  /* ---------------------------------------------------------------- code */
  'code.table': { ...BLOCK },
  'code.plate': {
    padding: emailSpace[4],
    paddingLeft: CODE_TRACKING,
    backgroundColor: emailColor.surfaceRaised,
    border: HAIRLINE,
    borderRadius: emailRadius.chip,
    textAlign: 'center',
    fontFamily: emailFont.mono,
    fontSize: emailText['3xl'],
    fontWeight: emailWeight.semibold,
    lineHeight: emailLeading.tight,
    letterSpacing: CODE_TRACKING,
    fontVariantNumeric: 'tabular-nums',
    color: emailColor.ink1,
    userSelect: 'all',
  },
  'code.caption': { ...MICRO_LABEL, padding: `${emailSpace[2]} 0 0` },

  /* --------------------------------------------------------------- facts */
  'facts.table': { ...BLOCK, borderTop: HAIRLINE },
  'facts.label': {
    ...MICRO_LABEL,
    width: '40%',
    verticalAlign: 'top',
    padding: `${emailSpace[3]} ${emailSpace[3]} ${emailSpace[3]} 0`,
    borderBottom: HAIRLINE,
  },
  'facts.value': {
    fontFamily: emailFont.mono,
    fontSize: emailText.sm,
    fontWeight: emailWeight.medium,
    lineHeight: emailLeading.snug,
    color: emailColor.ink1,
    fontVariantNumeric: 'tabular-nums',
    verticalAlign: 'top',
    padding: `${emailSpace[3]} 0`,
    borderBottom: HAIRLINE,
  },

  /* -------------------------------------------------------------- notice */
  'notice.table': { ...BLOCK },
  'notice.border.info': noticeBorder(emailColor.infoInk),
  'notice.border.warn': noticeBorder(emailColor.warnInk),
  'notice.border.danger': noticeBorder(emailColor.dangerInk),
  'notice.label.info': noticeLabel(emailColor.infoInk),
  'notice.label.warn': noticeLabel(emailColor.warnInk),
  'notice.label.danger': noticeLabel(emailColor.dangerInk),
  'notice.text': {
    fontFamily: emailFont.sans,
    fontSize: emailText.sm,
    lineHeight: emailLeading.prose,
    color: emailColor.ink2,
  },
};

/**
 * Resolve a recipe to its declaration list, escaped for an attribute.
 * Throws on an unknown name: a silent unstyled element is the failure mode this
 * module exists to prevent.
 */
export function styleDeclaration(name: string): string {
  const recipe = STYLE_RECIPES[name];
  if (!recipe) {
    throw new Error(
      `Unknown email style recipe "${name}". Known: ${Object.keys(STYLE_RECIPES).join(', ')}`,
    );
  }
  return escapeAttribute(css(recipe));
}

/** The whole attribute, leading space included, for use as `{{styleAttr 'name'}}`. */
export function styleAttr(name: string): string {
  return ` style="${styleDeclaration(name)}"`;
}
