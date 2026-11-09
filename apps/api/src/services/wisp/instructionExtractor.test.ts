/**
 * #10428 (W05 Task 3) — the turn-end standing-instruction extractor: one
 * sessionless model call on a prefilter hit, charged to the grant's background
 * line, capped per grant per UTC day, never retried. Device ids come only from
 * server-side name resolution inside the ceiling.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GRANT = '44444444-4444-4444-8444-444444444444';
const REVISION = '55555555-5555-4555-8555-555555555555';
const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const SITE = '66666666-6666-4666-8666-666666666666';
const USER = '33333333-3333-4333-8333-333333333333';
const SESSION = '77777777-7777-4777-8777-777777777777';
const CAPTURE = '88888888-8888-4888-8888-888888888888';
const MESSAGE = '99999999-9999-4999-8999-999999999999';
const DEV1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEV2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const h = vi.hoisted(() => ({
  wispEnabled: vi.fn(() => true),
  redis: null as null | { multi: () => unknown },
  capCount: 1,
  capExec: vi.fn(),
  resolveGrantCeiling: vi.fn(),
  chargeableUnderGrant: vi.fn(),
  resolveModel: vi.fn(),
  anthropicClientFor: vi.fn(),
  createMessage: vi.fn(),
  checkBudgetDetailed: vi.fn(),
  reserveAiBudget: vi.fn(),
  releaseUnusedAiBudgetReservation: vi.fn(),
  markAiBudgetReservationIndeterminate: vi.fn(),
  isAiBudgetLockTimeout: vi.fn(() => false),
  settleInvocation: vi.fn(),
  messagesUsage: vi.fn(() => ({ usage: [], outcome: {} })),
  messagesUsageAfterDispatchError: vi.fn(() => ({ usage: [], outcome: {} })),
  turnBindingFrom: vi.fn(() => ({ binding: true })),
  rememberInstructionGroupForGrant: vi.fn(),
  finishInstructionCapture: vi.fn(),
  captureException: vi.fn(),
  deviceRows: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../config/env', () => ({ wispEnabled: h.wispEnabled }));
vi.mock('../redis', () => ({ getRedis: () => h.redis }));
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'limit']) chain[m] = () => chain;
      chain.then = (res: (v: unknown) => unknown) => Promise.resolve(h.deviceRows).then(res);
      return chain;
    }),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('./grantAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./grantAuthority')>()),
  resolveGrantCeiling: h.resolveGrantCeiling,
  inSystemContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('./budget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./budget')>()),
  chargeableUnderGrant: h.chargeableUnderGrant,
}));
vi.mock('./memoryBroker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./memoryBroker')>()),
  rememberInstructionGroupForGrant: h.rememberInstructionGroupForGrant,
}));
vi.mock('./instructionCaptureStatus', () => ({ finishInstructionCapture: h.finishInstructionCapture }));
vi.mock('../aiModels/resolveModel', () => ({ resolveModel: h.resolveModel }));
vi.mock('../aiModels/connectionFactory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../aiModels/connectionFactory')>()),
  anthropicClientFor: h.anthropicClientFor,
  createMessage: h.createMessage,
}));
vi.mock('../aiCostTracker', () => ({ checkBudgetDetailed: h.checkBudgetDetailed }));
vi.mock('../aiBudgetReservations', () => ({
  isAiBudgetLockTimeout: h.isAiBudgetLockTimeout,
  markAiBudgetReservationIndeterminate: h.markAiBudgetReservationIndeterminate,
  releaseUnusedAiBudgetReservation: h.releaseUnusedAiBudgetReservation,
  reserveAiBudget: h.reserveAiBudget,
}));
vi.mock('../aiModels/invocationUsage', () => ({
  messagesUsage: h.messagesUsage,
  messagesUsageAfterDispatchError: h.messagesUsageAfterDispatchError,
}));
vi.mock('../aiModels/settleInvocation', () => ({ settleInvocation: h.settleInvocation }));
vi.mock('../aiModels/turnBinding', () => ({ turnBindingFrom: h.turnBindingFrom }));
vi.mock('../sentry', () => ({ captureException: h.captureException }));

import {
  INSTRUCTION_EXTRACT_DAILY_CAP,
  INSTRUCTION_EXTRACT_ESTIMATE_CENTS,
  extractStandingInstructions,
  resolveDeviceNamesInCeiling,
} from './instructionExtractor';
import type { GrantCeiling } from './grantAuthority';

function ceiling(over: Partial<GrantCeiling> = {}): GrantCeiling {
  return {
    grantId: GRANT, revisionId: REVISION, partnerId: PARTNER, grantorUserId: USER, scopeOrgId: null,
    partnerWide: true, orgIds: new Set([ORG]), siteIds: null, permissionKeys: new Set(['*']),
    toolAllowlist: null, deniedTools: new Set(), orgTerms: new Map(), status: 'active',
    ...over,
  };
}

function modelReply(json: unknown) {
  const message = { content: [{ type: 'text', text: typeof json === 'string' ? json : JSON.stringify(json) }], stop_reason: 'end_turn' };
  return { message, attempts: [{ wireModel: 'm', message }] };
}

const input = {
  captureId: CAPTURE, grantId: GRANT, revisionId: REVISION, sessionId: SESSION, userId: USER, orgId: ORG,
  userMessage: "you can reboot those but don't reboot PC-01 and PC-02",
  previousReply: 'These need a restart: PC-01, PC-02, PC-03.',
  alreadyRemembered: ['never patch the CEO laptop'],
  sourceMessageId: MESSAGE,
};

const REBOOT_DENY = {
  instructions: [{ effect: 'deny', verb: 'reboot', targets: ['PC-01', 'PC-02'], condition: null, until: null, text: "don't reboot PC-01 and PC-02" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.capCount = 1;
  h.capExec.mockImplementation(async () => [[null, h.capCount], [null, 1]]);
  h.redis = {
    multi: () => {
      const chain = { incr: () => chain, expire: () => chain, exec: h.capExec };
      return chain;
    },
  };
  h.wispEnabled.mockReturnValue(true);
  h.resolveGrantCeiling.mockResolvedValue(ceiling());
  h.chargeableUnderGrant.mockResolvedValue({ ok: true });
  h.resolveModel.mockResolvedValue({ ok: true, funding: 'platform', wireModel: 'm', wireParams: { betas: [] } });
  h.anthropicClientFor.mockReturnValue({ client: true });
  h.checkBudgetDetailed.mockResolvedValue(null);
  h.reserveAiBudget.mockResolvedValue({ kind: 'reserved', reservationId: 'res-1', reservedCostCents: 5 });
  h.createMessage.mockResolvedValue(modelReply(REBOOT_DENY));
  h.settleInvocation.mockResolvedValue({ unrecorded: false, costCents: 1 });
  h.rememberInstructionGroupForGrant.mockImplementation(async (_c: unknown, blocks: unknown[]) => blocks);
  h.finishInstructionCapture.mockResolvedValue(undefined);
  h.markAiBudgetReservationIndeterminate.mockResolvedValue(undefined);
  h.releaseUnusedAiBudgetReservation.mockResolvedValue(undefined);
  h.deviceRows = [
    { id: DEV1, orgId: ORG, siteId: SITE, hostname: 'PC-01', displayName: null },
    { id: DEV2, orgId: ORG, siteId: SITE, hostname: 'pc-02', displayName: 'Front desk' },
  ];
});

describe('extractStandingInstructions', () => {
  it('saves one user-owned unconfirmed block per resolved device, sharing an instructionId, and records `saved`', async () => {
    await expect(extractStandingInstructions(input)).resolves.toBe('saved');
    expect(h.rememberInstructionGroupForGrant).toHaveBeenCalledTimes(1);
    const [c, blocks] = h.rememberInstructionGroupForGrant.mock.calls[0]! as [GrantCeiling, Array<Record<string, any>>];
    expect(c.grantId).toBe(GRANT);
    expect(blocks).toHaveLength(2);
    const ids = new Set(blocks.map((b) => b.content.instructionId));
    expect(ids.size).toBe(1);
    expect(blocks.map((b) => b.content.deviceId).sort()).toEqual([DEV1, DEV2].sort());
    for (const b of blocks) {
      expect(b.owner).toEqual({ kind: 'user', userId: USER });
      expect(b.blockType).toBe('standing_instruction');
      expect(b.confidence).toBe('medium');
      expect(b.sourceSessionId).toBe(SESSION);
      expect(b.subjectKey).toMatch(new RegExp(`^device:${b.content.deviceId}:reboot:[0-9a-f]{16}$`));
      expect(b.content).toMatchObject({
        effect: 'deny', verb: 'reboot', condition: null, until: null, captureId: CAPTURE, sourceMessageId: MESSAGE,
        targetLabels: ['PC-01', 'Front desk'],
      });
    }
    expect(h.finishInstructionCapture).toHaveBeenCalledWith(CAPTURE, 'saved');
  });

  it('settles the call sessionless on the grant-keyed overhead ref, after reserving under the org', async () => {
    await extractStandingInstructions(input);
    expect(h.chargeableUnderGrant).toHaveBeenCalledWith(GRANT, INSTRUCTION_EXTRACT_ESTIMATE_CENTS, expect.any(Date));
    expect(h.resolveModel).toHaveBeenCalledWith(expect.objectContaining({
      partnerId: PARTNER, orgId: ORG, surface: 'ai_agents', role: 'triage',
    }));
    expect(h.anthropicClientFor).toHaveBeenCalledWith(expect.anything(), { surface: 'one_shot_wisp_instruction_extract', orgId: ORG });
    expect(h.reserveAiBudget).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, idempotencyKey: `wisp-instruction-extract:${CAPTURE}` }));
    expect(h.settleInvocation).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, userId: USER, sessionId: null, agentRunId: null,
      sourceRef: `wisp_instruction_extract:${GRANT}`, reservationId: 'res-1',
    }));
  });

  it('sends a bounded, fenced prompt with the already-remembered clauses, and never retries', async () => {
    await extractStandingInstructions(input);
    const [, , body, opts] = h.createMessage.mock.calls[0]! as [unknown, unknown, Record<string, any>, Record<string, any>];
    expect(body.max_tokens).toBe(600);
    expect(opts.maxRetries).toBe(0);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    const prompt = JSON.stringify(body.messages);
    expect(prompt).toContain('never patch the CEO laptop');
    expect(prompt).toContain('untrusted_data');
    expect(prompt).toContain('PC-03');
    expect(String(body.system)).toMatch(/pasted|quoted/i);
  });

  it('caps user message and previous reply at 4 000 / 2 000 characters', async () => {
    await extractStandingInstructions({ ...input, userMessage: `don't ${'x'.repeat(9000)}`, previousReply: 'y'.repeat(9000) });
    const prompt = JSON.stringify((h.createMessage.mock.calls[0]![2] as Record<string, unknown>).messages);
    expect(prompt).not.toContain('x'.repeat(4001));
    expect(prompt).toContain('x'.repeat(3000));
    expect(prompt).not.toContain('y'.repeat(2001));
  });

  it(`the ${INSTRUCTION_EXTRACT_DAILY_CAP + 1}st call of the UTC day is skipped with no model call`, async () => {
    h.capCount = INSTRUCTION_EXTRACT_DAILY_CAP + 1;
    await expect(extractStandingInstructions(input)).resolves.toBe('skipped');
    expect(h.createMessage).not.toHaveBeenCalled();
    expect(h.reserveAiBudget).not.toHaveBeenCalled();
    expect(h.finishInstructionCapture).toHaveBeenCalledWith(CAPTURE, 'skipped');
  });

  it('the 20th call still runs', async () => {
    h.capCount = INSTRUCTION_EXTRACT_DAILY_CAP;
    await expect(extractStandingInstructions(input)).resolves.toBe('saved');
  });

  it('Redis down fails the cap closed: skipped, no model call', async () => {
    h.redis = null;
    await expect(extractStandingInstructions(input)).resolves.toBe('skipped');
    expect(h.createMessage).not.toHaveBeenCalled();
  });

  it('an exhausted grant budget is skipped, no model call', async () => {
    h.chargeableUnderGrant.mockResolvedValue({ ok: false, reason: 'budget_exhausted' });
    await expect(extractStandingInstructions(input)).resolves.toBe('skipped');
    expect(h.createMessage).not.toHaveBeenCalled();
  });

  it('an org budget denial is skipped, no model call, and uses up no daily slot', async () => {
    h.checkBudgetDetailed.mockResolvedValue({ code: 'budget_exceeded', message: 'over' });
    await expect(extractStandingInstructions(input)).resolves.toBe('skipped');
    expect(h.createMessage).not.toHaveBeenCalled();
    expect(h.reserveAiBudget).not.toHaveBeenCalled();
    expect(h.capExec).not.toHaveBeenCalled();
  });

  it('an exhausted grant budget or a missing model uses up no daily slot either', async () => {
    h.chargeableUnderGrant.mockResolvedValueOnce({ ok: false, reason: 'budget_exhausted' });
    await extractStandingInstructions(input);
    h.resolveModel.mockResolvedValueOnce({ ok: false, reason: 'not_permitted', message: 'no' });
    await extractStandingInstructions(input);
    expect(h.capExec).not.toHaveBeenCalled();
  });

  it('settles the usage the provider reported for the attempts it made', async () => {
    const reply = modelReply(REBOOT_DENY);
    h.createMessage.mockResolvedValue(reply);
    h.messagesUsage.mockReturnValueOnce({ usage: [{ tokens: { input: 7 } }], outcome: { served: 'm' } } as never);
    await extractStandingInstructions(input);
    expect(h.messagesUsage).toHaveBeenCalledWith({ binding: true }, reply.attempts);
    expect(h.settleInvocation).toHaveBeenCalledWith(expect.objectContaining({
      usage: [{ tokens: { input: 7 } }], outcome: { served: 'm' },
    }));
  });

  it('a speaker who is not the grantor is skipped (user memory belongs to the grantor)', async () => {
    await expect(extractStandingInstructions({ ...input, userId: '12121212-1212-4212-8212-121212121212' })).resolves.toBe('skipped');
    expect(h.createMessage).not.toHaveBeenCalled();
  });

  it('Wisp off: skipped, nothing read', async () => {
    h.wispEnabled.mockReturnValue(false);
    await expect(extractStandingInstructions(input)).resolves.toBe('skipped');
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  it('Zod-invalid model output saves nothing and returns failed, but the call is still settled', async () => {
    h.createMessage.mockResolvedValue(modelReply({ instructions: [{ effect: 'forbid', verb: 'reboot', targets: [], condition: null, until: null, text: 'x' }] }));
    await expect(extractStandingInstructions(input)).resolves.toBe('failed');
    expect(h.rememberInstructionGroupForGrant).not.toHaveBeenCalled();
    expect(h.settleInvocation).toHaveBeenCalledTimes(1);
    expect(h.finishInstructionCapture).toHaveBeenCalledWith(CAPTURE, 'failed');
  });

  it('non-JSON output saves nothing and returns failed', async () => {
    h.createMessage.mockResolvedValue(modelReply('Sure! Here are the instructions.'));
    await expect(extractStandingInstructions(input)).resolves.toBe('failed');
    expect(h.rememberInstructionGroupForGrant).not.toHaveBeenCalled();
  });

  it('accepts JSON inside a code fence', async () => {
    h.createMessage.mockResolvedValue(modelReply(`\`\`\`json\n${JSON.stringify(REBOOT_DENY)}\n\`\`\``));
    await expect(extractStandingInstructions(input)).resolves.toBe('saved');
  });

  it('no instructions → none, nothing written', async () => {
    h.createMessage.mockResolvedValue(modelReply({ instructions: [] }));
    await expect(extractStandingInstructions(input)).resolves.toBe('none');
    expect(h.rememberInstructionGroupForGrant).not.toHaveBeenCalled();
    expect(h.finishInstructionCapture).toHaveBeenCalledWith(CAPTURE, 'none');
  });

  it('partial name resolution (PC-02 unmatched) saves ONE free-text block with deviceId null', async () => {
    h.deviceRows = [{ id: DEV1, orgId: ORG, siteId: SITE, hostname: 'PC-01', displayName: null }];
    await expect(extractStandingInstructions(input)).resolves.toBe('saved');
    const blocks = h.rememberInstructionGroupForGrant.mock.calls[0]![1] as Array<Record<string, any>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content.deviceId).toBeNull();
    expect(blocks[0]!.content.targetLabels).toEqual(['PC-01', 'PC-02']);
    expect(blocks[0]!.subjectKey).toMatch(/^instruction:[0-9a-f]{16}$/);
  });

  it('an ambiguous name (two devices) also degrades to one free-text block', async () => {
    h.deviceRows = [
      { id: DEV1, orgId: ORG, siteId: SITE, hostname: 'PC-01', displayName: null },
      { id: DEV2, orgId: ORG, siteId: SITE, hostname: 'PC-02', displayName: 'PC-01' },
    ];
    await extractStandingInstructions(input);
    const blocks = h.rememberInstructionGroupForGrant.mock.calls[0]![1] as Array<Record<string, any>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content.deviceId).toBeNull();
  });

  it('an instruction with no targets is one free-text block', async () => {
    h.createMessage.mockResolvedValue(modelReply({
      instructions: [{ effect: 'prefer', verb: null, targets: [], condition: null, until: null, text: 'prefer email over phone' }],
    }));
    await extractStandingInstructions(input);
    const blocks = h.rememberInstructionGroupForGrant.mock.calls[0]![1] as Array<Record<string, any>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content).toMatchObject({ deviceId: null, effect: 'prefer', targetLabels: [] });
  });

  it('a model-supplied deviceId is never trusted (unknown keys drop the output)', async () => {
    h.createMessage.mockResolvedValue(modelReply({
      instructions: [{ effect: 'deny', verb: 'reboot', targets: ['PC-01'], condition: null, until: null, text: 'x', deviceId: DEV2 }],
    }));
    await expect(extractStandingInstructions(input)).resolves.toBe('failed');
  });

  it('a provider error with a status releases the reservation and returns failed', async () => {
    const { APIError } = await import('@anthropic-ai/sdk');
    h.createMessage.mockRejectedValue(new APIError(500, undefined, 'boom', undefined));
    await expect(extractStandingInstructions(input)).resolves.toBe('failed');
    expect(h.releaseUnusedAiBudgetReservation).toHaveBeenCalledWith({ orgId: ORG, reservationId: 'res-1' });
    expect(h.settleInvocation).not.toHaveBeenCalled();
  });

  it('a transport failure (outcome unknown) holds the reservation indeterminate', async () => {
    h.createMessage.mockRejectedValue(new Error('socket hang up'));
    await expect(extractStandingInstructions(input)).resolves.toBe('failed');
    expect(h.markAiBudgetReservationIndeterminate).toHaveBeenCalledWith({ orgId: ORG, reservationId: 'res-1' });
    expect(h.releaseUnusedAiBudgetReservation).not.toHaveBeenCalled();
  });

  it('a settlement failure holds the reservation indeterminate and still saves', async () => {
    h.settleInvocation.mockRejectedValue(new Error('db down'));
    await expect(extractStandingInstructions(input)).resolves.toBe('saved');
    expect(h.markAiBudgetReservationIndeterminate).toHaveBeenCalled();
  });

  it('a broker write failure returns failed and is reported', async () => {
    h.rememberInstructionGroupForGrant.mockRejectedValue(new Error('write failed'));
    await expect(extractStandingInstructions(input)).resolves.toBe('failed');
    expect(h.captureException).toHaveBeenCalled();
    expect(h.finishInstructionCapture).toHaveBeenCalledWith(CAPTURE, 'failed');
  });
});

describe('resolveDeviceNamesInCeiling', () => {
  it('matches hostname or display name case-insensitively, keyed by the name as given', async () => {
    const map = await resolveDeviceNamesInCeiling(ceiling(), ['pc-01', 'FRONT DESK', 'nope']);
    expect(map.get('pc-01')).toEqual([{ deviceId: DEV1, orgId: ORG, label: 'PC-01' }]);
    expect(map.get('FRONT DESK')).toEqual([{ deviceId: DEV2, orgId: ORG, label: 'Front desk' }]);
    expect(map.get('nope')).toEqual([]);
  });

  it('drops a device outside the ceiling site term', async () => {
    const map = await resolveDeviceNamesInCeiling(ceiling({ siteIds: new Set(['cccccccc-cccc-4ccc-8ccc-cccccccccccc']) }), ['PC-01']);
    expect(map.get('PC-01')).toEqual([]);
  });

  it('a match set at the row limit resolves nothing (a cut-off set could hide an ambiguity)', async () => {
    h.deviceRows = Array.from({ length: 500 }, (_, i) => ({
      id: `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, '0')}`, orgId: ORG, siteId: SITE, hostname: i === 0 ? 'PC-01' : `X-${i}`, displayName: null,
    }));
    const map = await resolveDeviceNamesInCeiling(ceiling(), ['PC-01']);
    expect(map.get('PC-01')).toEqual([]);
  });

  it('a ceiling with no orgs resolves nothing without a query', async () => {
    const map = await resolveDeviceNamesInCeiling(ceiling({ orgIds: new Set() }), ['PC-01']);
    expect(map.get('PC-01')).toEqual([]);
  });
});
