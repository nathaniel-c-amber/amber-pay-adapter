import { TwoFactorService } from './twoFactor.js';
import { UnauthorizedError } from '../lib/errors.js';
import type { EmailSender } from './twoFactor.js';

/** Recording sender so tests can read the generated code. */
function recordingSender(): { sender: EmailSender; lastCode: () => string } {
  let lastCode = '';
  const sender: EmailSender = {
    async send(_userId: string, code: string): Promise<void> {
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

    const challenge = await service.createChallenge('u1');
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(challenge.codeHash).not.toBe(code); // only the hash is stored

    expect(service.verifyChallenge(challenge.id, code).id).toBe(challenge.id);
  });

  it('rejects a wrong code', async () => {
    const { sender, lastCode } = recordingSender();
    const service = new TwoFactorService(sender);
    const challenge = await service.createChallenge('u1');
    expect(() => service.verifyChallenge(challenge.id, wrongCode(lastCode()))).toThrow(
      UnauthorizedError,
    );
  });

  it('rejects an expired challenge', async () => {
    const { sender, lastCode } = recordingSender();
    const service = new TwoFactorService(sender);
    const challenge = await service.createChallenge('u1');
    challenge.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(() => service.verifyChallenge(challenge.id, lastCode())).toThrow(UnauthorizedError);
  });

  it('enforces the attempt limit', async () => {
    const { sender, lastCode } = recordingSender();
    const service = new TwoFactorService(sender);
    const challenge = await service.createChallenge('u1');
    const bad = wrongCode(lastCode());

    for (let i = 0; i < 5; i += 1) {
      expect(() => service.verifyChallenge(challenge.id, bad)).toThrow(UnauthorizedError);
    }
    // Beyond the limit, even a correct code is rejected.
    expect(() => service.verifyChallenge(challenge.id, lastCode())).toThrow(UnauthorizedError);
  });

  it('rejects an unknown challenge id', () => {
    const { sender } = recordingSender();
    const service = new TwoFactorService(sender);
    expect(() => service.verifyChallenge('nobody', '123456')).toThrow(UnauthorizedError);
  });
});
