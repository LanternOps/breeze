import { describe, expect, it, vi } from 'vitest';

// heartbeatTokenRotation.ts's only runtime dependency is this pure helper —
// stub it rather than pull in agentAuth.ts's db/schema-heavy import graph.
vi.mock('../../middleware/agentAuth', () => ({
  isAgentTokenRotationDue: vi.fn(() => false),
}));

import { implicitPromotionTokenHash } from './heartbeatTokenRotation';

const PRESENTED = 'a'.repeat(64);
const OTHER_STAGED = 'b'.repeat(64);
const CURRENT = 'c'.repeat(64);

const base = {
  pendingRotationLive: true,
  pendingTokenPresented: true,
  presentedTokenHash: PRESENTED as string | undefined,
  devicePendingTokenHash: PRESENTED as string | null,
  deviceAgentTokenHash: CURRENT as string | null,
};

describe('implicitPromotionTokenHash (#2773)', () => {
  it('promotes the hash the agent actually presented when it is the live staged hash', () => {
    expect(implicitPromotionTokenHash(base)).toBe(PRESENTED);
  });

  it('refuses to promote a staged set the agent did not present (re-staged between auth and the heartbeat read)', () => {
    // agentAuth matched the presented token against the pending hash IT read;
    // the heartbeat handler re-reads the row. If a re-stage landed in between,
    // promoting the re-read pending hash would make current a credential the
    // endpoint never held and demote the one it does hold — a strand.
    expect(implicitPromotionTokenHash({ ...base, devicePendingTokenHash: OTHER_STAGED })).toBeNull();
  });

  it.each([
    ['no live staged set', { pendingRotationLive: false }],
    ['the caller did not present a staged token', { pendingTokenPresented: false }],
    ['the authenticating token hash is unknown', { presentedTokenHash: undefined }],
    ['there is no current hash to compare-and-swap on', { deviceAgentTokenHash: null }],
    ['the row has no staged hash', { devicePendingTokenHash: null }],
  ])('does not promote when %s', (_label, override) => {
    expect(implicitPromotionTokenHash({ ...base, ...override })).toBeNull();
  });
});
