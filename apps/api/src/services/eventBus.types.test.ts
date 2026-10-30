import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, type EventType } from './eventBus';
import type { MigrationWindowClosedPayload } from './migrationWindows';

/**
 * The real guarantee, checked by tsc rather than by parsing source text: the
 * EventType union and the EVENT_TYPES registry are the SAME set, both ways.
 * Either side gaining a member alone is a compile error here.
 *
 * The runtime tests below stay because they name the offending member in the
 * failure message, which a type error does not — but they extract the union by
 * regex, so a reformat of the union could quietly weaken them. This assertion
 * cannot be weakened by formatting.
 */
type EventTypeConstant = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _eventTypesMatchUnion: MutuallyAssignable<EventType, EventTypeConstant> = true;
void _eventTypesMatchUnion;

const src = readFileSync(fileURLToPath(new URL('./eventBus.ts', import.meta.url)), 'utf8');
const unionBlock = src.slice(
  src.indexOf('export type EventType ='),
  src.indexOf('export type EventPriority'),
);
const unionMembers = new Set(
  Array.from(unionBlock.matchAll(/\|\s*'([a-z0-9_.]+)'/g), (match) => match[1]),
);

describe('EVENT_TYPES ⟺ EventType', () => {
  it('the union was actually parsed (guards the regex itself)', () => {
    // Without this, a reformat that breaks the regex leaves unionMembers empty
    // and "every union member has a constant" passes vacuously.
    expect(unionMembers.size).toBeGreaterThan(20);
    expect(unionMembers).toContain('ai.agent.policy_changed');
  });

  it('every union member has a constant', () => {
    const constants = new Set(Object.values(EVENT_TYPES));
    expect([...unionMembers].filter((member) => !constants.has(member as never))).toEqual([]);
  });

  it('every constant is a union member', () => {
    expect(Object.values(EVENT_TYPES).filter((value) => !unionMembers.has(value))).toEqual([]);
  });
});

/**
 * #8313: `migration.window_closed` is the only event an import produces, and
 * its payload is a webhook contract. The payload type, this list and the
 * webhook docs row name the same keys; W1 (spec 2026-10-19 §4.6) added
 * `attachmentsImported`, additively.
 */
const MIGRATION_WINDOW_CLOSED_KEYS = [
  'windowId', 'partnerId', 'sourceLabel', 'openedAt', 'endsAt', 'closedAt', 'closedReason',
  'ticketsImported', 'commentsImported', 'attachmentsImported',
] as const;
const _windowClosedKeys: MutuallyAssignable<(typeof MIGRATION_WINDOW_CLOSED_KEYS)[number], keyof MigrationWindowClosedPayload> = true;
void _windowClosedKeys;

describe('migration.window_closed payload', () => {
  it('the webhook docs row lists exactly the payload keys, in order', () => {
    const docs = readFileSync(fileURLToPath(new URL('../../../docs/src/content/docs/features/webhooks.mdx', import.meta.url)), 'utf8');
    const row = docs.split('\n').find((line) => line.startsWith('| `migration.window_closed` |'));
    expect(row, 'webhooks.mdx has a migration.window_closed row').toBeDefined();
    const payloadCell = row!.split('|')[2]!;
    expect(Array.from(payloadCell.matchAll(/`([A-Za-z]+)`/g), (m) => m[1])).toEqual([...MIGRATION_WINDOW_CLOSED_KEYS]);
  });
});
