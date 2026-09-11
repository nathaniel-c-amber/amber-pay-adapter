import { TwoFactorService } from './twoFactor.js';
import { UnauthorizedError } from '../lib/errors.js';
import type { EmailSender } from './twoFactor.js';

/** Recording sender so tests can read the generated code. */
function recordingSender(): { sender: EmailSender; lastCode: () => string } {
  let lastCode = '';
  const sender: EmailSender = {
    async send(_email: string, code: string): Promise<void> {
      lastCode = code;
    },
  };
  return { sender, lastCode: () => lastCode };
}

function wrongCode(correct: string): string {
  return correct === '000000' ? '111111' : '000000';
}

describe('TwoFactorService', () => {
  it('creates a 6-digit challenge and verifies the emailed code', async () => {
    const { sender, lastCode } = recordingSender();
    const service = new TwoFactorService(sender);

    const challenge = await service.createChallenge('u1', 'user@example.com');
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(challenge.codeHash).not.toBe(code); // only the hash is stored

    expect((await service.verifyChallenge(challenge.id, code)).id).toBe(challenge.id);
  });

  it('rejects a wrong code', async () => {
    const { sender, lastCode } = recordingSender();
    const service = new TwoFactorService(sender);
    const challenge = await service.createChallenge('u1', 'user@example.com');
    await expect(service.verifyChallenge(challenge.id, wrongCode(lastCode()))).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it('rejects an expired challenge', async () => {
    const { sender, lastCode } = recordingSender();
    const service = new TwoFactorService(sender);
    const challenge = await service.createChallenge('u1', 'user@example.com');
    challenge.expiresAt = new Date(Date.now() - 1000).toISOString();
    await expect(service.verifyChallenge(challenge.id, lastCode())).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it('enforces the attempt limit', async () => {
    const { sender, lastCode } = recordingSender();
    const service = new TwoFactorService(sender);
    const challenge = await service.createChallenge('u1', 'user@example.com');
    const bad = wrongCode(lastCode());

    for (let i = 0; i < 5; i += 1) {
      await expect(service.verifyChallenge(challenge.id, bad)).rejects.toThrow(UnauthorizedError);
    }
    // Beyond the limit, even a correct code is rejected.
    await expect(service.verifyChallenge(challenge.id, lastCode())).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it('rejects an unknown challenge id', async () => {
    const { sender } = recordingSender();
    const service = new TwoFactorService(sender);
    await expect(service.verifyChallenge('nobody', '123456')).rejects.toThrow(UnauthorizedError);
  });
});
