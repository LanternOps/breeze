/**
 * Input shapes for minting and rotating deploy keys, against the ceilings in
 * services/unassignedPool/limits.ts. Dependency-light (zod, node:net, limits)
 * so the step-up mint schema (routes/auth/schemas.ts) can share the image
 * label rule with the route: a grant is minted for exactly the label the
 * route will accept.
 */
import { isIP } from 'node:net';
import { z } from 'zod';
import {
  DEPLOY_KEY_IMAGE_LABEL_MAX_LENGTH,
  DEPLOY_KEY_MAX_PARKED,
  DEPLOY_KEY_MAX_TTL_DAYS,
  DEPLOY_KEY_MAX_USAGE,
} from '../unassignedPool/limits';

/**
 * A sanity bound on the optional source allow-list, not a spec number. Imaging
 * that runs inside the partner's network names a handful of ranges.
 */
export const DEPLOY_KEY_MAX_SOURCE_CIDRS = 20;

const NO_CONTROL_CHARS = /^[^\p{Cc}]+$/u;

/** Trimmed, 1..100, no control characters. The same rule binds the step-up grant. */
export const deployKeyImageLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(DEPLOY_KEY_IMAGE_LABEL_MAX_LENGTH)
  .regex(NO_CONTROL_CHARS, 'Image label must not contain control characters');

export const deployKeyNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(NO_CONTROL_CHARS, 'Name must not contain control characters');

/**
 * One IPv4/IPv6 address or CIDR. Strict enough that Postgres `inet` always
 * accepts it (Node's parser: no leading-zero octets; no zone id). Host bits
 * right of the mask are allowed here and cleared on insert (`network()`),
 * so `10.0.0.5/24` is stored as `10.0.0.0/24`.
 */
export function isValidSourceCidr(entry: string): boolean {
  if (entry.includes('%')) return false;
  const slash = entry.indexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const family = isIP(address);
  if (family === 0) return false;
  if (slash === -1) return true;
  const bits = entry.slice(slash + 1);
  if (!/^(0|[1-9]\d{0,2})$/.test(bits)) return false;
  return Number(bits) <= (family === 4 ? 32 : 128);
}

export const deployKeySourceCidrsSchema = z
  .array(z.string().trim().min(1).max(64).refine(isValidSourceCidr, { message: 'Invalid IP address or CIDR' }))
  .min(1)
  .max(DEPLOY_KEY_MAX_SOURCE_CIDRS);

const expiresInDaysSchema = z.number().int().min(1).max(DEPLOY_KEY_MAX_TTL_DAYS);
const maxUsageSchema = z.number().int().min(1).max(DEPLOY_KEY_MAX_USAGE);
const maxParkedSchema = z.number().int().min(1).max(DEPLOY_KEY_MAX_PARKED);

/**
 * Mint: every limit is the admin's explicit choice, at most the platform
 * ceiling. `sourceCidrs` omitted or null means "any source".
 */
export const mintDeployKeyBodySchema = z.object({
  name: deployKeyNameSchema,
  imageLabel: deployKeyImageLabelSchema,
  expiresInDays: expiresInDaysSchema,
  maxUsage: maxUsageSchema,
  maxParked: maxParkedSchema,
  sourceCidrs: deployKeySourceCidrsSchema.nullable().optional(),
  stepUpGrant: z.string().uuid().optional(),
}).strict();

/**
 * Rotate: the successor keeps the old key's image label; the lifetime is
 * chosen again (it starts now), everything else is inherited unless given.
 * `sourceCidrs: null` clears the allow-list.
 */
export const rotateDeployKeyBodySchema = z.object({
  name: deployKeyNameSchema.optional(),
  expiresInDays: expiresInDaysSchema,
  maxUsage: maxUsageSchema.optional(),
  maxParked: maxParkedSchema.optional(),
  sourceCidrs: deployKeySourceCidrsSchema.nullable().optional(),
  stepUpGrant: z.string().uuid().optional(),
}).strict();

export type MintDeployKeyBody = z.infer<typeof mintDeployKeyBodySchema>;
export type RotateDeployKeyBody = z.infer<typeof rotateDeployKeyBodySchema>;
