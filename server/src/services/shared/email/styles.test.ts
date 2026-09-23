import { STYLE_RECIPES, css, styleAttr, styleDeclaration } from './styles.js';
import { emailColor } from './theme.js';

describe('css', () => {
  it('serialises camelCase properties to kebab-case', () => {
    expect(css({ backgroundColor: '#111827', fontFamily: 'sans' })).toBe(
      'background-color:#111827;font-family:sans',
    );
  });

  it('treats numbers as px, except for unitless properties', () => {
    expect(css({ padding: 16, fontWeight: 550, opacity: 1 })).toBe(
      'padding:16px;font-weight:550;opacity:1',
    );
  });

  it('drops undefined and empty values instead of emitting invalid CSS', () => {
    expect(css({ color: undefined, margin: '', padding: '0' })).toBe('padding:0');
  });
});

describe('styleAttr', () => {
  it('emits one double-quoted attribute and nothing outside it', () => {
    // A raw quote inside a CSS value would end the attribute early and silently
    // discard every later declaration — the failure this escape exists for.
    expect(styleAttr('paragraph.cell')).toMatch(/^ style="[^"]*"$/);
  });

  it('escapes a quote that appears in a value', () => {
    expect(styleDeclaration('paragraph.cell')).not.toContain('"');
  });

  it('throws on an unknown recipe rather than rendering an unstyled element', () => {
    expect(() => styleAttr('paragrafh.cell')).toThrow(/Unknown email style recipe/);
  });

  it('names the recipes it knows when it throws, so a typo is fixable', () => {
    expect(() => styleAttr('nope')).toThrow(/button.anchor/);
  });
});

describe('recipes', () => {
  const entries = Object.entries(STYLE_RECIPES);

  it('defines every recipe with at least one declaration', () => {
    expect(entries.length).toBeGreaterThan(20);
    for (const [name, recipe] of entries) {
      expect(Object.keys(recipe).length).toBeGreaterThan(0);
      expect(css(recipe)).not.toBe('');
      expect(name).toMatch(/^[a-zA-Z]+(\.[a-zA-Z]+)+$/);
    }
  });

  it('never paints white, anywhere', () => {
    // White is not in the palette: the field is dark-first, and white on the brand
    // amber measures 3.31:1. A recipe that reaches for it is a regression.
    for (const [name, recipe] of entries) {
      const declarations = css(recipe);
      expect({ name, declarations }).toEqual({
        name,
        declarations: expect.not.stringMatching(/#fff|white/i),
      });
    }
  });

  it('labels the primary action with the on-primary ink', () => {
    expect(css(STYLE_RECIPES['button.anchor'] as Record<string, string>)).toContain(
      `color:${emailColor.onPrimary}`,
    );
  });

  it('carries notice tone on a 1px rule, never a wide rail', () => {
    for (const tone of ['info', 'warn', 'danger']) {
      const border = css(STYLE_RECIPES[`notice.border.${tone}`] as Record<string, string>);
      expect(border).toMatch(/border-left:1px solid #/);
      expect(border).not.toMatch(/border-left:\s*[2-9]px/);
    }
  });

  it('keeps the separator ink out of anything that carries information', () => {
    const informative = Object.entries(STYLE_RECIPES).filter(
      ([name]) => !name.startsWith('brandBar.separator'),
    );
    for (const [name, recipe] of informative) {
      expect({ name, declarations: css(recipe) }).toEqual({
        name,
        declarations: expect.not.stringContaining(emailColor.ink4),
      });
    }
  });
});
