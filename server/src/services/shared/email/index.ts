/**
 * Email messages, rendered with Handlebars.
 *
 * ```ts
 * import { humanizeTtl, renderInviteEmail } from '../shared/email/index.js';
 *
 * await emailService.sendTemplate(email, renderInviteEmail({
 *   token,
 *   baseUrl: env.APP_BASE_URL,
 *   expiresIn: humanizeTtl(env.INVITE_TTL),
 * }));
 * ```
 *
 * To add a message: add `messages/<name>.hbs` and `messages/<name>.text.hbs`
 * (both are required), add its subject to `SUBJECTS` in `templates.ts`, and add a
 * `renderXEmail(props)` that builds the context. To add a component: add a partial
 * to `partials/` and a recipe to `styles.ts` for each element it renders.
 */

export type {
  InviteEmailProps,
  PasswordResetEmailProps,
  RenderedEmail,
  TwoFactorEmailProps,
} from './templates.js';

export {
  humanizeTtl,
  inviteUrl,
  resetUrl,
  renderInviteEmail,
  renderPasswordResetEmail,
  renderTwoFactorEmail,
} from './templates.js';

export { renderMessage } from './engine.js';
export type { RenderedTemplate } from './engine.js';

export { STYLE_RECIPES, css, styleAttr, styleDeclaration } from './styles.js';
export type { StyleValue, Styles } from './styles.js';

export { emailTokens } from './theme.js';
