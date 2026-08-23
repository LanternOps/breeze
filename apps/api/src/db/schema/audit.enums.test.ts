/**
 * Enum parity for `actor_type`: unlike ActionIntentSource (defined once in
 * the schema file), the actor-type value set is hand-synced across the
 * Postgres enum, the shared TS type, the shared Zod validator and the local
 * union in services/auditEvents.ts. Wave 3a widened all of them with
 * 'ai_agent' by grep discipline — this test makes the NEXT widening loud
 * instead. Mirrors ticketEnums.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { auditQuerySchema, type ActorType } from '@breeze/shared';
import { actorTypeEnum, auditResultEnum } from './audit';

// Compile-time exhaustiveness: adding a value to the shared ActorType union
// without listing it here is a type error, and vice versa via the runtime
// comparison below.
const SHARED_ACTOR_TYPES: readonly ActorType[] = ['user', 'api_key', 'agent', 'system', 'ai_agent'];

describe('actor_type enum parity (shared ↔ DB schema ↔ validators)', () => {
  it('Drizzle enumValues match the shared ActorType union', () => {
    expect([...actorTypeEnum.enumValues].sort()).toEqual([...SHARED_ACTOR_TYPES].sort());
  });

  it('the shared auditQuerySchema actorType filter matches the DB enum', () => {
    const zodOptions = auditQuerySchema.shape.actorType.unwrap().options;
    expect([...zodOptions].sort()).toEqual([...actorTypeEnum.enumValues].sort());
  });

  it('audit_result parity stays intact alongside', () => {
    expect([...auditResultEnum.enumValues].sort()).toEqual(['denied', 'failure', 'success']);
  });
});
