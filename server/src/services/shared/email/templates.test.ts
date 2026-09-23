import {
  humanizeTtl,
  inviteUrl,
  resetUrl,
  renderInviteEmail,
  renderPasswordResetEmail,
  renderTwoFactorEmail,
} from './templates.js';
import { emailBrand, emailColor, emailLayout } from './theme.js';
import type { RenderedEmail } from './templates.js';

const BASE = 'https://console.example.test';

/** Every template must produce a usable plain-text part, not just markup. */
const templates: ReadonlyArray<{ name: string; render: () => RenderedEmail }> = [
  {
    name: 'invite',
    render: () => renderInviteEmail({ token: 'tok-1', baseUrl: BASE, expiresIn: '48 hours' }),
  },
  {
    name: 'password reset',
    render: () => renderPasswordResetEmail({ token: 'tok-1', baseUrl: BASE, expiresIn: '1 hour' }),
  },
  {
    name: '2FA',
    render: () => renderTwoFactorEmail({ code: '042915', expiresIn: '5 minutes' }),
  },
];

describe('humanizeTtl', () => {
  it('expands the TTL env format into copy', () => {
    expect(humanizeTtl('48h')).toBe('48 hours');
    expect(humanizeTtl('1h')).toBe('1 hour');
    expect(humanizeTtl('5m')).toBe('5 minutes');
    expect(humanizeTtl('1m')).toBe('1 minute');
    expect(humanizeTtl('90s')).toBe('90 seconds');
    expect(humanizeTtl('2d')).toBe('2 days');
  });

  it('passes an unrecognised value through rather than guessing a lifetime', () => {
    expect(humanizeTtl('48 hours')).toBe('48 hours');
    expect(humanizeTtl('soon')).toBe('soon');
  });
});

describe('links', () => {
  it('points the invite at the console hash route, not an API path', () => {
    expect(inviteUrl(BASE, 'tok-1')).toBe(`${BASE}/#/invite/tok-1`);
    expect(inviteUrl(`${BASE}/`, 'tok-1')).toBe(`${BASE}/#/invite/tok-1`);
  });

  it('points the reset link at the same router shape', () => {
    expect(resetUrl(BASE, 'tok-1')).toBe(`${BASE}/#/reset/tok-1`);
  });

  it('percent-encodes the token so it cannot break out of the path', () => {
    expect(inviteUrl(BASE, 'a b/c')).toBe(`${BASE}/#/invite/a%20b%2Fc`);
  });
});

describe.each(templates.map((template) => [template.name, template.render] as const))(
  '%s template',
  (_name, render) => {
    it('is a complete document with a plain-text alternative', () => {
      const email = render();

      expect(email.subject.length).toBeGreaterThan(0);
      expect(email.text.length).toBeGreaterThan(0);
      expect(email.html.startsWith('<!doctype html>')).toBe(true);
    });

    it('stays on the console palette', () => {
      const { html } = render();

      expect(html).toContain(emailColor.ground);
      expect(html).toContain(emailColor.surface);
      expect(html).toContain(emailColor.ink2);
      expect(html).toContain(emailColor.ink3);
    });

    it('renders any primary action on the brand amber with dark ink, never white', () => {
      const { html } = render();

      // 3.31:1 — the shipped defect `--color-on-primary` exists to prevent.
      expect(html).not.toMatch(/color:\s*(#fff(fff)?|white)/i);
      // The 2FA message has no button; the others must label it with dark ink.
      if (html.includes('bgcolor="')) {
        expect(html).toContain(emailColor.onPrimary);
      }
    });

    it('never uses the separator ink to carry information', () => {
      const { html } = render();
      const separatorInkUses = html.split(emailColor.ink4).length - 1;

      // ink-4 is separators and disabled only; the wordmark's "/" is the one place.
      expect(separatorInkUses).toBeLessThanOrEqual(1);
    });

    it('does not double-escape the style attributes it builds', () => {
      const { html } = render();

      // `styleAttr` returns markup and is marked safe; if that ever regressed,
      // every declaration would arrive as &quot; entities and vanish.
      expect(html).not.toContain('&quot;');
      expect(html).toContain(' style="');
    });

    it('carries the console chrome: wordmark, card measure, and the footer note', () => {
      const { html } = render();

      expect(html).toContain(emailBrand.name);
      expect(html).toContain(`max-width:${emailLayout.cardWidth}`);
      expect(html).toContain('replies are not monitored');
    });
  },
);

describe('invite template', () => {
  const email = renderInviteEmail({ token: 'tok-1', baseUrl: BASE, expiresIn: '48 hours' });

  it('delivers the working invite URL in both parts', () => {
    const url = inviteUrl(BASE, 'tok-1');

    expect(email.html).toContain(`href="${url}"`);
    expect(email.text).toContain(url);
  });

  it('quotes the same lifetime the service enforces', () => {
    expect(email.html).toContain('48 hours');
    expect(email.text).toContain('48 hours');
  });
});

describe('password reset template', () => {
  const email = renderPasswordResetEmail({ token: 'tok-1', baseUrl: BASE, expiresIn: '1 hour' });

  it('delivers the working reset URL in both parts', () => {
    const url = resetUrl(BASE, 'tok-1');

    expect(email.html).toContain(`href="${url}"`);
    expect(email.text).toContain(url);
  });

  it('says the password has not changed when the request was not expected', () => {
    expect(email.text).toContain('your password has not changed');
  });
});

describe('two-factor template', () => {
  const email = renderTwoFactorEmail({ code: '042915', expiresIn: '5 minutes' });

  it('shows the code as the largest element and repeats it in the text part', () => {
    expect(email.html).toContain('042915');
    expect(email.text).toContain('042915');
  });

  it('carries no link at all — a code is not a click-through', () => {
    expect(email.html).not.toContain('<a ');
  });

  it('warns that staff never ask for the code', () => {
    expect(email.text).toContain('never ask you for this code');
  });
});

describe('escaping', () => {
  it('cannot be used to break out of the link it is embedded in', () => {
    const hostile = '"><script>alert(1)</script>';
    const email = renderInviteEmail({ token: hostile, baseUrl: BASE, expiresIn: '48 hours' });

    // Percent-encoded into the path, then HTML-escaped on the way out.
    expect(email.html).not.toContain('<script');
    expect(email.html).not.toContain('"><script');
    expect(email.html).toContain('%3Cscript%3E');
  });

  it('cannot be used to inject markup through a 2FA code', () => {
    const email = renderTwoFactorEmail({ code: '<img src=x onerror=alert(1)>', expiresIn: '5 minutes' });

    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('&lt;img');
  });
});
