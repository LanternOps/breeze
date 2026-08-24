/**
 * Enum parity for `actor_type` / `audit_result`.
 *
 * These value sets used to be hand-synced across the Postgres enum, the shared
 * TS type, the shared Zod validator and the local union in
 * services/auditEvents.ts. They now all derive from ACTOR_TYPES / AUDIT_RESULTS
 * in @breeze/shared, so a widening is a one-line change at the source.
 *
 * This suite is the backstop for the surfaces that a `typeof X[number]` import
 * cannot reach: the Drizzle enum (a runtime call, verified below) and the
 * OpenAPI document, whose `enum:` arrays are plain JSON and had silently
 * drifted — `actor_type` was missing both `api_key` and `ai_agent`, and
 * `audit_result` was missing `denied` (#3908). The OpenAPI checks walk the
 * whole spec rather than pinning line numbers, so a THIRD hand-written site
 * added later fails here too. Mirrors ticketEnums.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { auditQuerySchema, ACTOR_TYPES, AUDIT_RESULTS, type ActorType } from '@breeze/shared';
import { actorTypeEnum, auditResultEnum } from './audit';
import { openApiSpec } from '../../openapi';

// Compile-time exhaustiveness: adding a value to the shared ActorType union
// without listing it here is a type error, and vice versa via the runtime
// comparison below.
const SHARED_ACTOR_TYPES: readonly ActorType[] = ['user', 'api_key', 'agent', 'system', 'ai_agent'];

/**
 * Collect every `enum: [...]` array in the OpenAPI document that describes the
 * named audit field, in either of the two shapes the spec uses:
 *   - a component-schema property:  properties: { actorType: { enum: [...] } }
 *   - a query parameter:            { name: 'actorType', schema: { enum: [...] } }
 */
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

    // Query-parameter shape: { name: '<field>', schema: { enum: [...] } }
    if (obj.name === field) {
      const e = enumOf(obj.schema) ?? enumOf(obj);
      if (e) found.push(e);
    }

    for (const [key, value] of Object.entries(obj)) {
      // Schema-property shape: properties: { '<field>': { enum: [...] } }
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

describe('actor_type enum parity (shared ↔ DB schema ↔ validators ↔ OpenAPI)', () => {
  it('Drizzle enumValues match the shared ActorType union', () => {
    expect([...actorTypeEnum.enumValues].sort()).toEqual([...SHARED_ACTOR_TYPES].sort());
  });

  it('the exported ACTOR_TYPES constant matches the shared ActorType union', () => {
    expect([...ACTOR_TYPES].sort()).toEqual([...SHARED_ACTOR_TYPES].sort());
  });

  it('the shared auditQuerySchema actorType filter matches the DB enum', () => {
    const zodOptions = auditQuerySchema.shape.actorType.unwrap().options;
    expect([...zodOptions].sort()).toEqual([...actorTypeEnum.enumValues].sort());
  });

  it('every actorType enum in the OpenAPI spec matches the DB enum', () => {
    const specEnums = collectSpecEnums(openApiSpec, 'actorType');
    // Guard against a vacuous pass if the audit surfaces are renamed or removed.
    expect(specEnums.length).toBeGreaterThanOrEqual(2);
    for (const values of specEnums) {
      expect([...values].sort()).toEqual([...actorTypeEnum.enumValues].sort());
    }
  });

  it('audit_result parity stays intact alongside', () => {
    expect([...auditResultEnum.enumValues].sort()).toEqual(['denied', 'failure', 'success']);
    expect([...AUDIT_RESULTS].sort()).toEqual([...auditResultEnum.enumValues].sort());
    const zodOptions = auditQuerySchema.shape.result.unwrap().options;
    expect([...zodOptions].sort()).toEqual([...auditResultEnum.enumValues].sort());
  });

  it('the audit result enums in the OpenAPI spec match the DB enum', () => {
    // `result` is a generic key name elsewhere in the spec, so scope the walk to
    // the two audit subtrees rather than searching the whole document.
    const spec = openApiSpec as unknown as Record<string, unknown>;
    const components = spec.components as { schemas?: Record<string, unknown> } | undefined;
    const auditLogSchema = components?.schemas?.AuditLog;
    expect(auditLogSchema).toBeDefined();

    const paths = spec.paths as Record<string, unknown> | undefined;
    const auditLogsPath = paths?.['/audit/logs'];
    expect(auditLogsPath).toBeDefined();

    const specEnums = [
      ...collectSpecEnums(auditLogSchema, 'result'),
      ...collectSpecEnums(auditLogsPath, 'result')
    ];
    // Guard against a vacuous pass if the audit surfaces are renamed or removed.
    expect(specEnums.length).toBeGreaterThanOrEqual(2);
    for (const values of specEnums) {
      expect([...values].sort()).toEqual([...auditResultEnum.enumValues].sort());
    }
  });
});
