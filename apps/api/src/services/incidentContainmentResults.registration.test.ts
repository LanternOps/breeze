/**
 * #9662 registration contract: an execute_containment outcome must reach the
 * incident on EVERY terminal path — the agent result over either transport,
 * the server-side timeout, and cancellation. Fails when one side is unwired.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('execute_containment terminal wiring (#9662)', () => {
  it('both agent transports dispatch execute_containment results to the shared handler', () => {
    expect(source('../routes/agents/commands.ts')).toMatch(
      /REGISTRY_DISPATCHED_COMMAND_TYPES = new Set\(\[[\s\S]*?'execute_containment'[\s\S]*?\]\);/,
    );
    expect(source('../routes/agents/commands.ts')).toMatch(
      /REGISTRY_DISPATCHED_COMMAND_TYPES = new Set\(\[[\s\S]*?'release_containment'[\s\S]*?\]\);/,
    );
    expect(source('./commandResultHandlers.ts')).toContain('execute_containment: handleExecuteContainmentResult');
  });

  it('the server-side timeout propagation finalizes the containment action', () => {
    expect(source('../jobs/staleCommandReaper.ts')).toMatch(
      /commandType === CommandTypes\.EXECUTE_CONTAINMENT[\s\S]{0,400}finalizeContainmentAction\(/,
    );
  });

  it('cancel propagation finalizes the containment action', () => {
    expect(source('./commandCancelPropagation.ts')).toMatch(
      /type === 'execute_containment'[\s\S]{0,400}finalizeContainmentAction\(/,
    );
  });
});
