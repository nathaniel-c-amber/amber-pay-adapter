/**
 * The Handlebars engine for email: one environment, built once, with the design
 * system wired in as helpers and the components registered as partials.
 *
 * https://handlebarsjs.com/
 *
 * The division of labour:
 * - `partials/*.hbs` — structure. Components, callable as `{{> button …}}`, or as
 *   block partials (`{{#> facts}}…{{/facts}}`) when they wrap content.
 * - `messages/*.hbs` — one file per message: copy, and the components it composes.
 *   Each must have a `.text.hbs` sibling; the loader enforces the pair.
 * - `styles.ts` — every declaration. Templates contain no styling at all.
 * - `theme.ts` — every value. Templates reach tokens with `{{token '…'}}`.
 *
 * Escaping is Handlebars' default and is the point: any interpolated value — a
 * token, a code, a URL — goes through `{{ }}` and is HTML-escaped, so no template
 * can inject markup. Helpers that return markup say so by returning a `SafeString`,
 * which keeps `{{ }}` honest everywhere else.
 *
 * The environment is deliberately strict: a typo'd `{{headng}}` throws instead of
 * rendering nothing. Handlebars applies that only to bare path output, so optional
 * partial parameters still work through `{{#if}}` and the `default` helper.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import { emailTokens } from './theme.js';
import { styleAttr } from './styles.js';

/** Sibling suffix for the plain-text part of a message. */
const TEXT_SUFFIX = '.text.hbs';

const COMPILE_OPTIONS = { strict: true, preventIndent: true } as const;

export interface RenderedTemplate {
  html: string;
  text: string;
}

interface CompiledMessage {
  html: Handlebars.TemplateDelegate;
  text: Handlebars.TemplateDelegate;
}

export interface EmailEngine {
  render(name: string, context: Record<string, unknown>): RenderedTemplate;
  /** The message names this engine loaded, sorted. */
  messageNames(): string[];
}

/**
 * Locate an asset folder.
 *
 * `src` is checked first because it exists only in development and test, where it
 * is always the current copy; the production image ships `dist` and no `src` at
 * all (see `Dockerfile`), so nothing is ambiguous in a deploy. Unlike the
 * migrations resolver this prefers the source copy deliberately: reading a stale
 * `dist` while editing `src` would fail confusingly.
 */
export function resolveAssetDir(kind: 'partials' | 'messages'): string {
  const candidates = [
    path.join(process.cwd(), 'src', 'services', 'shared', 'email', kind),
    path.join(process.cwd(), 'dist', 'services', 'shared', 'email', kind),
  ];
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) {
    throw new Error(
      `Email ${kind} folder not found. Looked in:\n  ${candidates.join('\n  ')}\n` +
        'If this is a build, run `npm run build` so the templates are copied into dist.',
    );
  }
  return found;
}

function readTemplate(dir: string, file: string): string {
  return readFileSync(path.join(dir, file), 'utf8');
}

/** Helpers that exist so templates never need a literal. */
function registerHelpers(hbs: typeof Handlebars): void {
  /**
   * The whole `style` attribute for a named recipe. Returns a `SafeString` because
   * it *is* markup: without that, `{{ }}` would escape the attribute's own quotes
   * and the element would silently lose every declaration.
   */
  hbs.registerHelper(
    'styleAttr',
    (name: unknown) => new Handlebars.SafeString(styleAttr(String(name))),
  );

  /** A design token by dotted name, e.g. `{{token 'color.primary'}}`. */
  hbs.registerHelper('token', (name: unknown) => {
    const key = String(name);
    const value = emailTokens[key];
    if (value === undefined) {
      throw new Error(`Unknown email design token "${key}"`);
    }
    return value;
  });

  /** Build a recipe name from a variable, e.g. `notice.border.{{tone}}`. */
  hbs.registerHelper('concat', (...args: unknown[]) =>
    args
      .slice(0, -1)
      .map((part) => String(part))
      .join(''),
  );

  /** An optional parameter's fallback, since Handlebars has no default values. */
  hbs.registerHelper('default', (value: unknown, fallback: unknown) =>
    value === undefined || value === null || value === '' ? fallback : value,
  );
}

function loadMessages(hbs: typeof Handlebars): Map<string, CompiledMessage> {
  const messagesDir = resolveAssetDir('messages');
  const messages = new Map<string, CompiledMessage>();
  for (const file of readdirSync(messagesDir)) {
    if (!file.endsWith('.hbs') || file.endsWith(TEXT_SUFFIX)) {
      continue;
    }
    const name = file.slice(0, -'.hbs'.length);
    const textFile = `${name}${TEXT_SUFFIX}`;
    if (!existsSync(path.join(messagesDir, textFile))) {
      throw new Error(
        `Email message "${name}" has no plain-text part (expected ${textFile}). Both parts are ` +
          'required: the text part is the deliverability and accessibility fallback.',
      );
    }
    messages.set(name, {
      html: hbs.compile(readTemplate(messagesDir, file), COMPILE_OPTIONS),
      // HTML escaping in a text part is corruption, not safety: `&amp;` is literal
      // there, and there is no markup for a value to escape into.
      text: hbs.compile(readTemplate(messagesDir, textFile), {
        ...COMPILE_OPTIONS,
        noEscape: true,
      }),
    });
  }
  return messages;
}

/**
 * Build an engine from the templates on disk, uncached.
 *
 * Prefer `renderMessage`; this exists so the loader can be exercised against a
 * fixture tree, and so a preview tool can render without the singleton.
 */
export function createEmailEngine(): EmailEngine {
  const hbs = Handlebars.create();
  registerHelpers(hbs);

  const partialsDir = resolveAssetDir('partials');
  for (const file of readdirSync(partialsDir).filter((name) => name.endsWith('.hbs'))) {
    // Compiled here rather than registered as a string so partials get the same
    // strictness and indentation handling as the messages that call them.
    const source = readTemplate(partialsDir, file);
    hbs.registerPartial(file.slice(0, -'.hbs'.length), hbs.compile(source, COMPILE_OPTIONS));
  }

  const messages = loadMessages(hbs);
  const names = [...messages.keys()].sort();
  return {
    messageNames: () => names,
    render(name, context) {
      const message = messages.get(name);
      if (!message) {
        throw new Error(`Unknown email message "${name}". Known: ${names.join(', ')}`);
      }
      return { html: message.html(context), text: message.text(context) };
    },
  };
}

let shared: EmailEngine | undefined;

/** Compiled lazily and once, so importing this module does not touch the disk. */
export function getEmailEngine(): EmailEngine {
  shared ??= createEmailEngine();
  return shared;
}

/**
 * Render a message by file name (without the extension).
 *
 * Template errors propagate: an email that renders half-styled or with a
 * placeholder left in it is worse than one that fails, and `EmailService` already
 * guarantees that a failure here cannot break sign-in.
 */
export function renderMessage(name: string, context: Record<string, unknown>): RenderedTemplate {
  return getEmailEngine().render(name, context);
}
