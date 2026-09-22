import { EmailService } from './email.service.js';
import type { Transporter } from 'nodemailer';

function mockTransporter(): { transporter: Transporter; sendMail: jest.Mock } {
  const sendMail = jest.fn().mockResolvedValue({ messageId: 'test' });
  const transporter = { sendMail } as unknown as Transporter;
  return { transporter, sendMail };
}

describe('EmailService', () => {
  it('sends via nodemailer when SMTP is configured', async () => {
    const { transporter, sendMail } = mockTransporter();
    const service = new EmailService(
      { host: 'smtp.example.com', port: 587, secure: 'starttls', from: 'no-reply@example.com' },
      transporter,
    );

    await service.sendEmail({ to: 'a@example.com', subject: 'Hi', text: 'Body' });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      from: 'no-reply@example.com',
      to: 'a@example.com',
      subject: 'Hi',
      text: 'Body',
    });
  });

  it('does not throw when SMTP is not configured (logs fallback)', async () => {
    const service = new EmailService({ host: undefined, port: 587, secure: 'starttls' });

    await expect(
      service.sendEmail({ to: 'a@example.com', subject: 'Hi', text: 'Body' }),
    ).resolves.toBeUndefined();
  });

  it('catches a transporter error and does not throw', async () => {
    const { transporter, sendMail } = mockTransporter();
    sendMail.mockRejectedValue(new Error('smtp down'));
    const service = new EmailService(
      { host: 'smtp.example.com', port: 587, secure: 'starttls', from: 'no-reply@example.com' },
      transporter,
    );

    await expect(
      service.sendEmail({ to: 'a@example.com', subject: 'Hi', text: 'Body' }),
    ).resolves.toBeUndefined();
  });
});