import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { RenderedEmail } from './email/templates.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /**
   * HTML body. Always sent alongside `text`, never instead of it: a plain-text
   * part is the deliverability and accessibility fallback, and clients that
   * cannot render the markup still need the link or the code. Templates in
   * `./email/` emit both from the same props.
   */
  html?: string;
}

export interface SmtpConfig {
  host?: string;
  port: number;
  user?: string;
  pass?: string;
  from?: string;
  secure: 'starttls' | 'ssl' | 'none';
}

/** Build the default SMTP config from the environment. */
function defaultSmtpConfig(): SmtpConfig {
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.SMTP_FROM,
    secure: env.SMTP_SECURE,
  };
}

/**
 * Generic SMTP email service. When `SMTP_HOST` is configured a nodemailer
 * transporter is created; otherwise delivery is stubbed (logged, never the
 * body/code/token). Email delivery NEVER throws — SMTP errors are caught and
 * logged so auth is never blocked or crashed by email.
 *
 * Message copy and styling live in `./email/` as composable components and
 * templates; this class only addresses the envelope. `sendEmail` remains the
 * raw escape hatch.
 */
export class EmailService {
  private readonly transporter: Transporter | null;
  private readonly from?: string;

  constructor(
    config: SmtpConfig = defaultSmtpConfig(),
    transporter?: Transporter | null,
  ) {
    this.from = config.from;
    this.transporter =
      transporter !== undefined
        ? transporter
        : config.host
          ? nodemailer.createTransport({
              host: config.host,
              port: config.port,
              secure: config.secure === 'ssl',
              auth: config.user ? { user: config.user, pass: config.pass } : undefined,
            })
          : null;
  }

  async sendEmail(message: EmailMessage): Promise<void> {
    if (!this.transporter) {
      logger.info(
        { to: message.to, subject: message.subject },
        'Email delivery stubbed (SMTP not configured)',
      );
      return;
    }
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        // Omitted rather than `undefined` so the outgoing message is identical
        // to what it was before HTML was supported.
        ...(message.html ? { html: message.html } : {}),
      });
    } catch (err) {
      logger.error({ err, to: message.to }, 'Failed to send email');
    }
  }

  /**
   * Deliver a rendered template (`./email/templates.ts`). The template owns the
   * copy and the styling; this method only addresses the envelope, so a new
   * message never needs a new send path.
   */
  async sendTemplate(to: string, email: RenderedEmail): Promise<void> {
    await this.sendEmail({
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
  }
}

/** Singleton email service backed by the environment SMTP config. */
export const emailService = new EmailService();