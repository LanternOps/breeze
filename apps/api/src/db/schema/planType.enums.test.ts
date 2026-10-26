/**
 * Enum parity for `plan_type` (entitlements W1 Q1).
 *
 * `PARTNER_PLANS` / `PlanType` in @breeze/shared used to carry four values
 * while the Postgres enum carried six (`starter`, `community` were missing),
 * so anything keyed on `PlanType` — the entitlement registry first of all —
 * would silently omit two real plans. This suite pins the pg enum, the shared
 * constant and every OpenAPI `plan` enum to one value set.
 *
 * Like audit.enums.test.ts it cannot see the live Postgres type: `enumValues`
 * is the array handed to `pgEnum`, so an ALTER TYPE that never shipped still
 * passes here.
 */
import { describe, expect, it } from 'vitest';
import { PARTNER_PLANS, type PlanType } from '@breeze/shared';
import { planTypeEnum } from './orgs';
import { openApiSpec } from '../../openapi';

// `satisfies Record<PlanType, true>` fails to compile in both directions: a
// widened PlanType leaves a key missing, a stale key is an excess property.
const EXPECTATIONS = {
  free: true,
  starter: true,
  community: true,
  pro: true,
  enterprise: true,
  unlimited: true
} satisfies Record<PlanType, true>;

/** Every `enum: [...]` under a property (or query parameter) named `field`. */
function collectSpecEnums(root: unknown, field: string): string[][] {
  const found: string[][] = [];
  const seen = new Set<object>();
  const enumOf = (node: unknown): string[] | undefined => {
    if (!node || typeof node !== 'object') return undefined;
    const e = (node as { enum?: unknown }).enum;
    return Array.isArray(e) ? (e as string[]) : undefined;
  };
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.name === field) {
      const e = enumOf(obj.schema) ?? enumOf(obj);
      if (e) found.push(e);
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === field) {
        const e = enumOf(value);
        if (e) found.push(e);
      }
      walk(value);
    }
  };
  walk(root);
  return found;
}

describe('plan_type enum parity (pg enum ↔ shared ↔ OpenAPI)', () => {
  it('shared PARTNER_PLANS equals the Drizzle pg enum', () => {
    expect([...PARTNER_PLANS]).toEqual([...planTypeEnum.enumValues]);
    expect(Object.keys(EXPECTATIONS)).toEqual([...PARTNER_PLANS]);
  });

  it('every OpenAPI `plan` enum lists all six values', () => {
    const enums = collectSpecEnums(openApiSpec, 'plan');
    expect(enums.length).toBeGreaterThanOrEqual(2);
    for (const e of enums) expect([...e].sort()).toEqual([...PARTNER_PLANS].sort());
  });
});
