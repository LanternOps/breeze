import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../db', () => ({ db: { select: vi.fn() } }));

import { eventLogHandler } from './eventLog';

describe('eventLogHandler.validate', () => {
  const base = { category: 'application', countThreshold: 1, windowMinutes: 60 };

  // #8174 — the agent now ships Information-level Application events from an
  // allowlisted provider set (MsiInstaller), so a compiled info rule must validate.
  it.each(['info', 'warning', 'error', 'critical'])('accepts level %s', (level) => {
    expect(eventLogHandler.validate!({ ...base, level }, 'c')).toEqual([]);
  });

  it('rejects an unknown level', () => {
    expect(eventLogHandler.validate!({ ...base, level: 'information' }, 'c')).toEqual(['c.level: Invalid level']);
  });
});
