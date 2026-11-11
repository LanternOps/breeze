/**
 * Memory content is redacted before it is stored, with the rules tool output
 * already gets (redactAiToolOutputText) plus the credential-named key list the
 * persisted tool input uses. Structural fields (ids, instruction fields,
 * numbers, booleans) are never touched, and a block with nothing to redact is
 * stored exactly as given. The DB is mocked: these tests pin what reaches the
 * insert; owner and supersede SQL are pinned by memoryBroker.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../db', () => {
  let seq = 0;
  const insert = vi.fn(() => ({
    values: (values: Record<string, unknown>) => {
      h.inserts.push(values);
      return {
        returning: async () => {
          seq += 1;
          return [{
            ...values,
            id: `70000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
            authoredByGrantId: values.authoredByGrantId ?? null,
            authoredByGrantRevisionId: values.authoredByGrantRevisionId ?? null,
            supersededById: null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          }];
        },
      };
    },
  }));
  const update = vi.fn(() => ({ set: () => ({ where: async () => undefined }) }));
  const execute = vi.fn(async () => []);
  return {
    db: { insert, update, execute },
    getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' })),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  };
});
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import type { GrantCeiling } from './grantAuthority';
import {
  redactMemoryContent,
  rememberForGrant,
  rememberInstructionGroupForGrant,
  type RememberInput,
} from './memoryBroker';

const PARTNER = '00000000-0000-4000-8000-0000000000aa';
const GRANTOR = '00000000-0000-4000-8000-0000000000bb';
const ORG = '00000000-0000-4000-8000-0000000000cc';
const DEVICE = '00000000-0000-4000-8000-000000000001';
const DEVICE_2 = '00000000-0000-4000-8000-000000000002';
const INSTRUCTION = '20000000-0000-4000-8000-000000000001';
const CAPTURE = '30000000-0000-4000-8000-000000000001';
const MESSAGE = '40000000-0000-4000-8000-000000000001';
const TICKET = '50000000-0000-4000-8000-000000000001';
const AUDIT = '50000000-0000-4000-8000-000000000002';
const SESSION = '60000000-0000-4000-8000-000000000001';

// Obviously fake values; the access key id is AWS's documented example.
const AWS_EXAMPLE_KEY = 'AKIAIOSFODNN7EXAMPLE';
const FAKE_PASSWORD = 'Example-Not-Real-42';

const ceiling: GrantCeiling = {
  grantId: '00000000-0000-4000-8000-0000000000dd',
  revisionId: '00000000-0000-4000-8000-0000000000ee',
  partnerId: PARTNER,
  grantorUserId: GRANTOR,
  scopeOrgId: null,
  partnerWide: true,
  orgIds: new Set([ORG]),
  siteIds: null,
  permissionKeys: new Set(),
  toolAllowlist: null,
  deniedTools: new Set(),
  orgTerms: new Map(),
  status: 'active',
} as GrantCeiling;

function standingContent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instructionId: INSTRUCTION,
    effect: 'deny',
    verb: 'reboot',
    deviceId: DEVICE,
    condition: null,
    until: '2026-12-01T00:00:00.000Z',
    text: 'Never reboot the file server during business hours',
    targetLabels: ['FS-01'],
    sourceMessageId: MESSAGE,
    captureId: CAPTURE,
    ...over,
  };
}

function workSummaryContent(): Record<string, unknown> {
  return {
    summary: 'Replaced the failing backup job and verified the first run.',
    evidence: [TICKET, AUDIT],
    sessionId: SESSION,
    tokenCount: 1234,
    resolved: true,
    steps: [
      { order: 1, action: 'disabled the old job', devices: [DEVICE] },
      { order: 2, action: 'created a new job', meta: { retries: 0, notify: false, owner: null } },
    ],
  };
}

function rememberInput(over: Partial<RememberInput> = {}): RememberInput {
  return {
    owner: { kind: 'org', orgId: ORG },
    blockType: 'fact',
    subjectKey: 'backup:service-account',
    content: { note: 'x' },
    confidence: 'medium',
    ...over,
  };
}

beforeEach(() => {
  h.inserts.length = 0;
});

describe('redactMemoryContent', () => {
  it('redacts an assignment-style secret and a bare token shape nested at any depth', () => {
    const { content, redacted } = redactMemoryContent({
      setup: {
        notes: [`service account password: ${FAKE_PASSWORD}`],
        steps: [{ text: `uses key ${AWS_EXAMPLE_KEY} for the S3 bucket` }],
      },
    });
    expect(redacted).toBe(true);
    expect(content).toEqual({
      setup: {
        notes: ['service account password: [REDACTED]'],
        steps: [{ text: 'uses key [REDACTED] for the S3 bucket' }],
      },
    });
    expect(JSON.stringify(content)).not.toContain(FAKE_PASSWORD);
    expect(JSON.stringify(content)).not.toContain(AWS_EXAMPLE_KEY);
  });

  it('replaces a string under a credential-named key whole', () => {
    const { content, redacted } = redactMemoryContent({
      vault: { password: 'correct horse battery staple', apiKey: 'plain words here', username: 'svc-backup' },
      credentials: ['first fake value', 'second fake value'],
    });
    expect(redacted).toBe(true);
    expect(content).toEqual({
      vault: { password: '[REDACTED]', apiKey: '[REDACTED]', username: 'svc-backup' },
      credentials: ['[REDACTED]', '[REDACTED]'],
    });
  });

  it('keeps UUIDs, numbers, booleans and nulls under credential-named keys', () => {
    const input = { sessionId: SESSION, tokenCount: 3, hasPassword: true, secretRotatedBy: null };
    const { content, redacted } = redactMemoryContent(input);
    expect(redacted).toBe(false);
    expect(content).toBe(input);
  });

  it('leaves a standing instruction byte-identical, deviceId and instruction fields included', () => {
    const input = standingContent();
    const before = JSON.stringify(input);
    const { content, redacted } = redactMemoryContent(input);
    expect(redacted).toBe(false);
    expect(content).toBe(input);
    expect(JSON.stringify(content)).toBe(before);
  });

  it('leaves a work_summary with evidence UUIDs and nested objects and arrays byte-identical', () => {
    const input = workSummaryContent();
    const before = JSON.stringify(input);
    const { content, redacted } = redactMemoryContent(input);
    expect(redacted).toBe(false);
    expect(content).toBe(input);
    expect(JSON.stringify(content)).toBe(before);
  });

  it('touches only the secret-bearing string when a structural block carries one', () => {
    const input = standingContent({ text: `Never reboot; local admin pwd=${FAKE_PASSWORD}` });
    const { content, redacted } = redactMemoryContent(input);
    expect(redacted).toBe(true);
    expect(content).toEqual({ ...standingContent(), text: 'Never reboot; local admin pwd=[REDACTED]' });
    // The input object is not mutated.
    expect(input.text).toContain(FAKE_PASSWORD);
  });

  it('is idempotent: content that was already redacted reports nothing new', () => {
    const once = redactMemoryContent({ note: `password=${FAKE_PASSWORD}`, password: FAKE_PASSWORD });
    expect(once.redacted).toBe(true);
    const twice = redactMemoryContent(once.content);
    expect(twice.redacted).toBe(false);
    expect(twice.content).toEqual(once.content);
  });
});

describe('rememberForGrant stores redacted content', () => {
  it('redacts secrets nested in the content and reports it', async () => {
    const saved = await rememberForGrant(ceiling, rememberInput({
      content: {
        account: { setup: [`login with password: ${FAKE_PASSWORD}`], accessKeyId: AWS_EXAMPLE_KEY },
        summary: `S3 key ${AWS_EXAMPLE_KEY} rotates monthly`,
      },
    }));
    expect(h.inserts).toHaveLength(1);
    const stored = h.inserts[0]!.content;
    expect(stored).toEqual({
      account: { setup: ['login with password: [REDACTED]'], accessKeyId: '[REDACTED]' },
      summary: 'S3 key [REDACTED] rotates monthly',
    });
    expect(JSON.stringify(stored)).not.toContain(FAKE_PASSWORD);
    expect(JSON.stringify(stored)).not.toContain(AWS_EXAMPLE_KEY);
    expect(saved.contentRedacted).toBe(true);
  });

  it('stores a block with nothing to redact exactly as given', async () => {
    const content = workSummaryContent();
    const before = JSON.stringify(content);
    const saved = await rememberForGrant(ceiling, rememberInput({ blockType: 'work_summary', subjectKey: 'work:2026-11-10:backup', content }));
    expect(h.inserts[0]!.content).toBe(content);
    expect(JSON.stringify(h.inserts[0]!.content)).toBe(before);
    expect(saved.contentRedacted).toBe(false);
  });
});

describe('rememberInstructionGroupForGrant stores redacted content', () => {
  it('redacts the instruction text and keeps every structural field of each block', async () => {
    const owner = { kind: 'user' as const, userId: GRANTOR };
    const secretText = `Do not patch; the vendor token=${FAKE_PASSWORD} is pinned`;
    const blocks: RememberInput[] = [DEVICE, DEVICE_2].map((deviceId) => ({
      owner,
      blockType: 'standing_instruction',
      subjectKey: `instruction:${INSTRUCTION}:${deviceId}`,
      content: standingContent({ deviceId, verb: 'patch', text: secretText }),
      confidence: 'medium',
    }));
    const saved = await rememberInstructionGroupForGrant(ceiling, blocks);
    expect(h.inserts).toHaveLength(2);
    for (const [i, deviceId] of [DEVICE, DEVICE_2].entries()) {
      expect(h.inserts[i]!.content).toEqual(standingContent({
        deviceId, verb: 'patch', text: 'Do not patch; the vendor token=[REDACTED] is pinned',
      }));
    }
    expect(saved.every((b) => b.contentRedacted)).toBe(true);
  });

  it('stores benign instruction blocks exactly as given', async () => {
    const content = standingContent();
    const saved = await rememberInstructionGroupForGrant(ceiling, [{
      owner: { kind: 'user', userId: GRANTOR },
      blockType: 'standing_instruction',
      subjectKey: `instruction:${INSTRUCTION}:${DEVICE}`,
      content,
      confidence: 'medium',
    }]);
    expect(h.inserts[0]!.content).toBe(content);
    expect(saved[0]!.contentRedacted).toBe(false);
  });
});
