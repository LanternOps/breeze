import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const { updateReturning, selectLimit } = vi.hoisted(() => ({
  updateReturning: vi.fn(),
  selectLimit: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturning })) })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: selectLimit })) })),
    })),
  },
}));

import {
  activateDesktopStreamStart,
  desktopConsentActivationPredicate,
  desktopStreamStartActivationWhere,
} from './desktopStreamStartActivation';

const dialect = new PgDialect();
const SESSION = '12121212-1212-4121-8121-121212121212';
const DEVICE = '34343434-3434-4343-8343-343434343434';
const COMMAND = `desk-start-${SESSION}-56565656-5656-4565-8565-565656565656`;

function render(consentReason: unknown) {
  return dialect.sqlToQuery(desktopStreamStartActivationWhere({
    sessionId: SESSION,
    deviceId: DEVICE,
    startCommandId: COMMAND,
    consentReason,
  })!);
}

describe('desktop stream start activation predicate', () => {
  it('only matches the exact connecting start on the reporting device', () => {
    const q = render('user');
    expect(q.sql).toContain('"remote_sessions"."status" = $');
    expect(q.params).toEqual(expect.arrayContaining([SESSION, DEVICE, 'connecting', COMMAND]));
    expect(q.sql).toContain('"remote_sessions"."desktop_start_command_id" = $');
    expect(q.sql).toContain('"remote_sessions"."device_id" = $');
  });

  it('an explicit user grant needs no extra consent predicate', () => {
    expect(desktopConsentActivationPredicate('user')).toEqual([]);
  });

  it('an unsolicited reason activates a consent-mode start only when it bound proceed', () => {
    const q = render('helper_absent');
    expect(q.sql).toMatch(/"desktop_prompt_mode" <> \$\d+ or "remote_sessions"\."desktop_consent_unavailable_behavior" = \$\d+/);
    expect(q.params).toEqual(expect.arrayContaining(['consent', 'proceed']));
  });

  it('no consent marker never activates a consent-mode start', () => {
    const q = render(undefined);
    expect(q.sql).toContain('"remote_sessions"."desktop_prompt_mode" <> $');
    expect(q.params).toEqual(expect.arrayContaining(['consent']));
    expect(q.params).not.toContain('proceed');
  });
});

describe('activateDesktopStreamStart', () => {
  beforeEach(() => {
    updateReturning.mockReset();
    selectLimit.mockReset();
  });
  const input = { sessionId: SESSION, deviceId: DEVICE, startCommandId: COMMAND, consentReason: 'user' };

  it('reports the activated row', async () => {
    const row = { id: SESSION, orgId: 'o', userId: 'u', type: 'desktop', promptMode: 'off', consentUnavailableBehavior: null };
    updateReturning.mockResolvedValue([row]);
    await expect(activateDesktopStreamStart(input)).resolves.toEqual({ activated: true, row });
    expect(selectLimit).not.toHaveBeenCalled();
  });

  it('reports a terminal session when the row has ended', async () => {
    updateReturning.mockResolvedValue([]);
    selectLimit.mockResolvedValue([{ status: 'disconnected', terminationPhase: 'confirmed', desktopStartCommandId: COMMAND }]);
    await expect(activateDesktopStreamStart(input)).resolves.toEqual({ activated: false, terminal: true });
  });

  it('reports a terminal session when the row is gone', async () => {
    updateReturning.mockResolvedValue([]);
    selectLimit.mockResolvedValue([]);
    await expect(activateDesktopStreamStart(input)).resolves.toEqual({ activated: false, terminal: true });
  });

  it('a live session superseded by a newer start is not terminal', async () => {
    updateReturning.mockResolvedValue([]);
    selectLimit.mockResolvedValue([{ status: 'connecting', terminationPhase: 'none', desktopStartCommandId: `${COMMAND}-newer` }]);
    await expect(activateDesktopStreamStart(input)).resolves.toEqual({ activated: false, terminal: false });
  });

  it('a live row still on this start (consent predicate refused) is not terminal', async () => {
    updateReturning.mockResolvedValue([]);
    selectLimit.mockResolvedValue([{ status: 'connecting', terminationPhase: 'none', desktopStartCommandId: COMMAND }]);
    await expect(activateDesktopStreamStart(input)).resolves.toEqual({ activated: false, terminal: false });
  });
});
