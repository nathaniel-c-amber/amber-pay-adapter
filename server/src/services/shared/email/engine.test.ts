import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEmailEngine, getEmailEngine, resolveAssetDir } from './engine.js';

const REAL_CWD = process.cwd();

interface Tree {
  partials?: Record<string, string>;
  messages?: Record<string, string>;
}

/**
 * Build a throwaway `…/email/{partials,messages}` tree and point the resolver at it
 * by changing the working directory, which is what the loader resolves against.
 */
function scaffold(tree: Tree): string {
  const root = mkdtempSync(path.join(tmpdir(), 'amber-email-'));
  const emailDir = path.join(root, 'src', 'services', 'shared', 'email');
  for (const kind of ['partials', 'messages'] as const) {
    const dir = path.join(emailDir, kind);
    mkdirSync(dir, { recursive: true });
    for (const [name, source] of Object.entries(tree[kind] ?? {})) {
      writeFileSync(path.join(dir, name), source);
    }
  }
  process.chdir(root);
  return root;
}

let root: string | undefined;

afterEach(() => {
  process.chdir(REAL_CWD);
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe('the shipped templates', () => {
  it('loads every message under its file name', () => {
    expect(getEmailEngine().messageNames()).toEqual(['invite', 'password-reset', 'two-factor']);
  });

  it('own no styling, so every declaration stays in styles.ts', () => {
    // A hardcoded colour or an inline style in a template would drift from the
    // design system silently, because nothing audits an HTML string. The one
    // exception is the `<style>` block in shell.hbs, which carries what inline
    // styles cannot express and therefore contains no hex and no `style="`.
    const sources = (['partials', 'messages'] as const).flatMap((kind) => {
      const dir = resolveAssetDir(kind);
      return readdirSync(dir)
        .filter((name) => name.endsWith('.hbs'))
        .map((name) => ({ where: `${kind}/${name}`, source: readFileSync(path.join(dir, name), 'utf8') }));
    });

    expect(sources.length).toBeGreaterThan(15);
    for (const { where, source } of sources) {
      expect({ where, source }).toEqual({
        where,
        source: expect.not.stringMatching(/#[0-9a-fA-F]{3,6}\b/),
      });
      expect({ where, source }).toEqual({
        where,
        source: expect.not.stringContaining('style="'),
      });
    }
  });

  it('renders both parts from the same context', () => {
    const { html, text } = getEmailEngine().render('invite', {
      url: 'https://console.test/#/invite/t',
      expiresIn: '48 hours',
    });

    expect(html).toContain('https://console.test/#/invite/t');
    expect(text).toContain('https://console.test/#/invite/t');
    expect(text).not.toContain('<table');
  });
});

describe('createEmailEngine', () => {
  it('compiles partials and passes parameters to them', () => {
    root = scaffold({
      partials: { 'greeting.hbs': 'Hello {{name}}.' },
      messages: { 'welcome.hbs': '{{> greeting name=who}}', 'welcome.text.hbs': 'Hello {{who}}.' },
    });

    const engine = createEmailEngine();

    expect(engine.messageNames()).toEqual(['welcome']);
    expect(engine.render('welcome', { who: 'Ada' })).toEqual({
      html: 'Hello Ada.',
      text: 'Hello Ada.',
    });
  });

  it('renders a block partial with the caller context inside it', () => {
    root = scaffold({
      partials: { 'frame.hbs': '[{{> @partial-block}}]' },
      messages: { 'boxed.hbs': '{{#> frame}}{{value}}{{/frame}}', 'boxed.text.hbs': '{{value}}' },
    });

    expect(createEmailEngine().render('boxed', { value: 'inner' }).html).toBe('[inner]');
  });

  it('defaults an optional parameter and keeps required ones strict', () => {
    root = scaffold({
      partials: { 'note.hbs': "{{default tone 'info'}}" },
      messages: { 'opt.hbs': '{{> note}}/{{> note tone="warn"}}', 'opt.text.hbs': 'x' },
    });

    expect(createEmailEngine().render('opt', {}).html).toBe('info/warn');
  });

  it('throws on a typo instead of rendering nothing', () => {
    root = scaffold({
      messages: { 'strict.hbs': 'before {{missspelled}}', 'strict.text.hbs': 'x' },
    });

    expect(() => createEmailEngine().render('strict', { misspelled: 'no' })).toThrow(
      /missspelled/,
    );
  });

  it('refuses a message with no plain-text part', () => {
    root = scaffold({ messages: { 'loud.hbs': 'Only HTML' } });

    expect(() => createEmailEngine()).toThrow(/no plain-text part \(expected loud\.text\.hbs\)/);
  });

  it('does not HTML-escape the text part, because &amp; is literal there', () => {
    root = scaffold({
      messages: {
        'amp.hbs': '{{value}}',
        'amp.text.hbs': 'Tom & {{value}}',
      },
    });

    const engine = createEmailEngine();

    expect(engine.render('amp', { value: '<b>' }).text).toBe('Tom & <b>');
    expect(engine.render('amp', { value: '<b>' }).html).toBe('&lt;b&gt;');
  });

  it('throws on an unknown message, listing the known ones', () => {
    root = scaffold({
      messages: { 'known.hbs': 'x', 'known.text.hbs': 'x' },
    });

    expect(() => createEmailEngine().render('unknown', {})).toThrow(
      /Unknown email message "unknown"\. Known: known/,
    );
  });

  it('throws on an unknown design token', () => {
    root = scaffold({
      messages: { 'tok.hbs': "{{token 'color.nope'}}", 'tok.text.hbs': 'x' },
    });

    expect(() => createEmailEngine().render('tok', {})).toThrow(
      /Unknown email design token "color.nope"/,
    );
  });

  it('says where it looked when the folders are missing', () => {
    root = mkdtempSync(path.join(tmpdir(), 'amber-email-empty-'));
    process.chdir(root);

    expect(() => createEmailEngine()).toThrow(/Email partials folder not found/);
  });
});
