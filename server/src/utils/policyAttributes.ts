import { z } from 'zod';

/**
 * Zod schemas for PBAC attributes on the wire.
 *
 * Shared by the invite endpoint (creating an account) and the user-directory
 * endpoint (editing one), so both accept exactly the same shape. A second,
 * slightly-different copy of this schema is how one endpoint quietly starts
 * accepting attributes the other rejects.
 */
export const policyActionSchema = z.enum(['read', 'ack', 'write', 'admin']);

export const policyAttributeSchema = z.object({
  scope: z.string().min(1),
  organizationId: z.string().min(1),
  actions: z.array(policyActionSchema).min(1),
});

export const policyAttributesSchema = z.array(policyAttributeSchema).min(1);

/** Strong-password rule, mirroring `assertStrongPassword` in utils/passwords.ts. */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .regex(/[a-z]/, 'Password must include a lowercase letter')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/\d/, 'Password must include a digit');
