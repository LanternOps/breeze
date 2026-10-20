/**
 * Endpoint messaging W02 (#8742) registration contract: fails when a piece of
 * the wiring is unregistered on one side.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('endpoint messaging W02 registrations', () => {
  it('both agent transports route notify_user results to the delivery handler', () => {
    expect(source('../../routes/agents/commands.ts')).toMatch(/REGISTRY_DISPATCHED_COMMAND_TYPES = new Set\(\[[\s\S]*?'notify_user'[\s\S]*?\]\);/);
    expect(source('../commandResultHandlers.ts')).toContain('notify_user: handleNotifyUserResult');
  });

  it('retract_message is a registered lifecycle command with an offline policy', () => {
    expect(source('../commandTypes.ts')).toContain("RETRACT_MESSAGE: 'retract_message'");
    expect(source('../partnerTrust.ts')).toMatch(/LIFECYCLE_COMMAND_TYPES = \[[\s\S]*?'retract_message'[\s\S]*?\] as const;/);
    expect(source('../commandOfflinePolicy.ts')).toContain('C.RETRACT_MESSAGE');
  });

  it('the retention worker is registered', () => {
    expect(source('../workerRegistry.ts')).toContain("name: 'endpointMessageRetention'");
  });
});
