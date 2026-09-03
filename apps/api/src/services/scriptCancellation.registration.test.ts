import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandTypes } from './commandQueue';
import { getCommandTimeoutMs, EXCLUDED_COMMAND_TYPES } from './commandTimeouts';
import { LIFECYCLE_COMMAND_TYPES, GATED_COMMAND_TYPES } from './partnerTrust';

// commandResultHandlers pulls the peripheral/PAM state modules into its static
// graph; stub them the way commandResultHandlers.test.ts already does so this
// file only pays for the registry object itself.
vi.mock('./peripheralPolicyState', () => ({ handlePeripheralPolicyResultV2: vi.fn() }));
vi.mock('./pamActuationResult', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pamActuationResult')>()),
  recordPamActuationResult: vi.fn(),
}));

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

/**
 * Extract the literal entries of a `const <name> = new Set([...])` declaration
 * from source. Used only where the Set is module-private in a route file whose
 * static import graph is deliberately too heavy for a unit test to pull in.
 */
function setLiteralEntries(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name} = new Set([`);
  if (start === -1) throw new Error(`${name} declaration not found — did it move or get renamed?`);
  const open = source.indexOf('[', start);
  const close = source.indexOf(']', open);
  if (close === -1) throw new Error(`${name} literal is not a single flat array`);
  // Comments inside the literal are stripped first: an apostrophe in prose
  // ("the agent's ack") would otherwise open a phantom string and swallow the
  // real entries around it.
  const body = source.slice(open + 1, close).replace(/\/\/[^\n]*/g, '');
  const entries = [...body.matchAll(/'([^']+)'/g)].map(m => m[1]!);
  if (entries.length === 0) throw new Error(`${name} parsed to zero entries — the extractor is broken, not the list`);
  return entries;
}

/**
 * #3525 W02. `script_cancel` has to be in four separate lists, each with its own
 * silent failure mode:
 *   - no CommandTypes key            → no type safety at any call site
 *   - not AUDITED_COMMANDS           → queueCommand writes no dispatch audit
 *   - not REGISTRY_DISPATCHED_…      → HTTP-polling agents never reach the
 *                                      result handler, so the ack is dropped
 *   - no result-handler entry        → the ack is dropped on BOTH transports
 * The AUDITED_COMMANDS half is pinned behaviourally in commandQueue.test.ts
 * ("writes an audit log when queueing script_cancel"), because the Set is
 * module-private and a string match there would not prove the audit is written.
 */
describe('script_cancel is registered in every list that matters', () => {
  it('has a CommandTypes key', () => {
    expect(CommandTypes.SCRIPT_CANCEL).toBe('script_cancel');
  });

  it('is in REGISTRY_DISPATCHED_COMMAND_TYPES so HTTP-polling agents get the result path', () => {
    const entries = setLiteralEntries(read('../routes/agents/commands.ts'), 'REGISTRY_DISPATCHED_COMMAND_TYPES');
    expect(entries).toContain('script');
    expect(entries).toContain('script_cancel');
  });

  it('has a result handler registered', async () => {
    const { commandResultHandlers } = await import('./commandResultHandlers');
    expect(commandResultHandlers['script_cancel']).toBeTypeOf('function');
  });

  it('gets the long timeout tier, NOT the 5-minute one', () => {
    // The generic reaper clocks `pending` rows from createdAt, so a 5-minute
    // tier would expire a cancel that was merely never delivered, while the
    // cancellation clock (which starts at DELIVERY) has not started. Two hours
    // strictly exceeds the longest possible script lifetime (MaxTimeout 3600s
    // + SCRIPT_GRACE_BUFFER_MS = 65 min).
    expect(getCommandTimeoutMs('script_cancel')).toBe(2 * 60 * 60 * 1000);
  });

  it('is not silently falling through to the default tier', () => {
    // getCommandTimeoutMs returns 30 min for BOTH "registered as medium" and
    // "never registered at all" — it only warns on the latter. Assert the warn
    // never fires, so an unregistered type can't masquerade as a 2h tier if the
    // constant above is ever changed.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getCommandTimeoutMs('script_cancel');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(EXCLUDED_COMMAND_TYPES.has('script_cancel')).toBe(false);
  });

  it('stays a lifecycle command so a probationed partner can still stop a script', () => {
    // Cancel is a de-escalation: it carries no operator-chosen content, target,
    // credential or binary. Partner trust probation must not be able to trap a
    // runaway script on a customer endpoint.
    expect(LIFECYCLE_COMMAND_TYPES).toContain('script_cancel');
    expect(GATED_COMMAND_TYPES as readonly string[]).not.toContain('script_cancel');
  });
});
