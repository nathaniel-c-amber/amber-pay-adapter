import { AdaptorAuthError } from './errors.js';
import { INTUIT_TOKEN_URL, resolveAccessToken } from './oauth.js';

/**
 * The connection failures an operator actually meets, each with its own fix:
 * nothing configured, configured but not authorized, and a refused exchange.
 *
 * The first two assert WHERE the fix lives, not merely that it failed. Both
 * messages reach the operator through the console, so a regression that points
 * one of them at an environment variable instead of a page is the defect this
 * file was changed to catch.
 */
describe('resolveAccessToken', () => {
  it('refuses without client credentials, naming the page that collects them', async () => {
    const transport = jest.fn();
    await expect(resolveAccessToken(transport, {})).rejects.toBeInstanceOf(AdaptorAuthError);
    // The operator reads this in the console, so it must point at the console's own
    // form for these two values rather than at environment variables.
    await expect(resolveAccessToken(transport, {})).rejects.toThrow(/guided setup/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses when credentials exist but no grant does', async () => {
    const transport = jest.fn();
    await expect(
      resolveAccessToken(transport, { clientId: 'id', clientSecret: 'secret' }),
    ).rejects.toThrow(/not authorized/);
    // …and the fix is a button on a page, not a variable to export.
    await expect(
      resolveAccessToken(transport, { clientId: 'id', clientSecret: 'secret' }),
    ).rejects.toThrow(/System configuration/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it('uses a supplied access token as-is', async () => {
    const transport = jest.fn();
    const token = await resolveAccessToken(transport, {
      clientId: 'id',
      clientSecret: 'secret',
      accessToken: 'live-token',
    });
    expect(token.accessToken).toBe('live-token');
    expect(transport).not.toHaveBeenCalled();
  });

  it('exchanges a refresh token at the token endpoint', async () => {
    const transport = jest
      .fn()
      .mockResolvedValue({ status: 200, body: { access_token: 'minted', refresh_token: 'rotated' } });
    const token = await resolveAccessToken(transport, {
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: 'refresh-1',
    });

    expect(token).toEqual({ accessToken: 'minted', refreshToken: 'rotated' });
    const [method, url, body, headers] = transport.mock.calls[0];
    expect(method).toBe('POST');
    expect(url).toBe(INTUIT_TOKEN_URL);
    expect(body).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-1' });
    // Basic auth of "id:secret", and the form encoding the endpoint requires.
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('reports the endpoint reason when the exchange is refused', async () => {
    const transport = jest.fn().mockResolvedValue({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token expired' },
    });
    await expect(
      resolveAccessToken(transport, { clientId: 'id', clientSecret: 'secret', refreshToken: 'r' }),
    ).rejects.toThrow(/Token expired/);
  });

  it('refuses a success response that carried no token', async () => {
    const transport = jest.fn().mockResolvedValue({ status: 200, body: {} });
    await expect(
      resolveAccessToken(transport, { clientId: 'id', clientSecret: 'secret', refreshToken: 'r' }),
    ).rejects.toThrow(/no access_token/);
  });
});
