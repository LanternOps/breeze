import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rateLimiterMock, getRedisMock } = vi.hoisted(() => ({
  rateLimiterMock: vi.fn(),
  getRedisMock: vi.fn(() => ({}) as never),
}));

vi.mock('./redis', () => ({ getRedis: getRedisMock }));
vi.mock('./rate-limit', () => ({ rateLimiter: rateLimiterMock }));

import {
  DEFAULT_CLIENT_AI_MODEL,
  EXCEL_CLIENT_SYSTEM_PROMPT,
  WORD_CLIENT_SYSTEM_PROMPT,
  POWERPOINT_CLIENT_SYSTEM_PROMPT,
  OUTLOOK_CLIENT_SYSTEM_PROMPT,
  CLIENT_SYSTEM_PROMPTS,
  buildExcelClientSystemPrompt,
  buildClientSystemPrompt,
  buildClientAuthContext,
  checkClientRateLimits,
  generateClientSessionTitle,
} from './clientAiSessions';
import { CLIENT_HOSTS, type ClientHost } from './clientAiHosts';
import { CLIENT_TOOL_REGISTRIES, isClientHostSupported } from './clientAiTools';
import { defaultClientAiPolicy } from './clientAiPolicy';

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';
const USER = 'beefbeef-1111-4222-8333-444455556666';

beforeEach(() => {
  vi.clearAllMocks();
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() });
});

describe('system prompt', () => {
  it('pins the workbook-only scope and the no-RMM-claims rule', () => {
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('ONLY work with the open workbook');
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('never claim or imply such capabilities');
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('Never fabricate cell values');
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('click Apply');
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('[REDACTED:');
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('Be concise');
  });

  it('accurately advertises the full tool set (does not undersell capabilities)', () => {
    for (const tool of [
      'get_workbook_overview',
      'read_selection',
      'read_range',
      'read_cell_details',
      'search_workbook',
      'write_range',
      'insert_formula',
      'clear_range',
      'create_sheet',
      'create_table',
      'sort_range',
      'format_range',
    ]) {
      expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain(tool);
    }
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('conditional formatting');
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('Do not understate what you can do');
  });

  it('instructs explaining formulas/errors via read_cell_details rather than guessing', () => {
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('explain a formula or an Excel error');
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('read_cell_details');
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('#REF!');
  });

  it('readwrite mode returns the base prompt; readonly appends the read-only addendum', () => {
    expect(buildExcelClientSystemPrompt('readwrite')).toBe(EXCEL_CLIENT_SYSTEM_PROMPT);
    const ro = buildExcelClientSystemPrompt('readonly');
    expect(ro).toContain(EXCEL_CLIENT_SYSTEM_PROMPT);
    expect(ro).toContain('READ-ONLY');
  });
});

describe('buildClientAuthContext', () => {
  it('builds an org-pinned synthetic AuthContext (the helper-chat shape)', () => {
    const auth = buildClientAuthContext({
      clientUserId: USER, orgId: ORG, email: 'finance.user@contoso.com', name: 'Finance User',
    });
    expect(auth.user.id).toBe(USER);
    expect(auth.user.isPlatformAdmin).toBe(false);
    expect(auth.scope).toBe('organization');
    expect(auth.orgId).toBe(ORG);
    expect(auth.accessibleOrgIds).toEqual([ORG]);
    expect(auth.canAccessOrg(ORG)).toBe(true);
    expect(auth.canAccessOrg('9d9d9d9d-1111-4222-8333-444455556666')).toBe(false);
    expect(auth.partnerId).toBeNull();
    expect(auth.token.mfa).toBe(false);
  });

  it('falls back to the email when the user has no display name', () => {
    const auth = buildClientAuthContext({ clientUserId: USER, orgId: ORG, email: 'a@b.com', name: null });
    expect(auth.user.name).toBe('a@b.com');
  });
});

describe('checkClientRateLimits', () => {
  it('passes when both limiters allow, using policy-driven limits and clientai keys', async () => {
    const policy = { ...defaultClientAiPolicy(ORG), perUserMessagesPerMinute: 7, orgMessagesPerHour: 123 };
    await expect(checkClientRateLimits(USER, ORG, policy)).resolves.toBeNull();
    expect(rateLimiterMock).toHaveBeenNthCalledWith(1, expect.anything(), `clientai:msg:user:${USER}`, 7, 60);
    expect(rateLimiterMock).toHaveBeenNthCalledWith(2, expect.anything(), `clientai:msg:org:${ORG}`, 123, 3600);
  });

  it('rejects on the per-user limit without consulting the org limiter', async () => {
    rateLimiterMock.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date('2026-06-12T10:00:00Z') });
    const msg = await checkClientRateLimits(USER, ORG, defaultClientAiPolicy(ORG));
    expect(msg).toContain('too quickly');
    expect(rateLimiterMock).toHaveBeenCalledTimes(1);
  });

  it('rejects on the org limit', async () => {
    rateLimiterMock
      .mockResolvedValueOnce({ allowed: true, remaining: 1, resetAt: new Date() })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date('2026-06-12T10:00:00Z') });
    const msg = await checkClientRateLimits(USER, ORG, defaultClientAiPolicy(ORG));
    expect(msg).toContain("organization's AI message limit");
  });
});

describe('generateClientSessionTitle', () => {
  it('collapses whitespace and passes short content through', () => {
    expect(generateClientSessionTitle('  sum   column B ')).toBe('sum column B');
  });
  it('truncates at a word boundary with ellipsis', () => {
    const title = generateClientSessionTitle('word '.repeat(40));
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('DEFAULT_CLIENT_AI_MODEL', () => {
  it('matches the platform default model', () => {
    expect(DEFAULT_CLIENT_AI_MODEL).toBe('claude-sonnet-4-5-20250929');
  });
});

describe('buildClientSystemPrompt', () => {
  it('returns the Excel prompt for the excel host (readwrite)', () => {
    expect(buildClientSystemPrompt('excel', 'readwrite')).toBe(EXCEL_CLIENT_SYSTEM_PROMPT);
  });
  it('appends the read-only addendum under readonly', () => {
    const p = buildClientSystemPrompt('excel', 'readonly');
    expect(p.startsWith(EXCEL_CLIENT_SYSTEM_PROMPT)).toBe(true);
    expect(p).toContain('READ-ONLY');
  });
  it('returns the Word prompt for the word host (readwrite)', () => {
    expect(buildClientSystemPrompt('word', 'readwrite')).toBe(WORD_CLIENT_SYSTEM_PROMPT);
  });
  it('appends the read-only addendum under readonly for word', () => {
    const p = buildClientSystemPrompt('word', 'readonly');
    expect(p.startsWith(WORD_CLIENT_SYSTEM_PROMPT)).toBe(true);
    expect(p).toContain('READ-ONLY');
  });
  it('returns the PowerPoint prompt for the powerpoint host (readwrite)', () => {
    expect(buildClientSystemPrompt('powerpoint', 'readwrite')).toBe(POWERPOINT_CLIENT_SYSTEM_PROMPT);
  });
  it('appends the read-only addendum under readonly for powerpoint', () => {
    const p = buildClientSystemPrompt('powerpoint', 'readonly');
    expect(p.startsWith(POWERPOINT_CLIENT_SYSTEM_PROMPT)).toBe(true);
    expect(p).toContain('READ-ONLY');
  });
  it('returns the Outlook prompt for the outlook host (readwrite)', () => {
    expect(buildClientSystemPrompt('outlook', 'readwrite')).toBe(OUTLOOK_CLIENT_SYSTEM_PROMPT);
  });
  it('appends the read-only addendum under readonly for outlook', () => {
    const p = buildClientSystemPrompt('outlook', 'readonly');
    expect(p.startsWith(OUTLOOK_CLIENT_SYSTEM_PROMPT)).toBe(true);
    expect(p).toContain('READ-ONLY');
  });
  it('throws fail-loud for a host with no prompt (synthetic keynote — no generic fallback ships)', () => {
    expect(() => buildClientSystemPrompt('keynote' as ClientHost, 'readwrite')).toThrow(/unsupported|no prompt/i);
  });
});

describe('supported-host invariant', () => {
  // A host that ships a tool registry (isClientHostSupported) but no system
  // prompt would 500 at session-create time. The total CLIENT_SYSTEM_PROMPTS
  // type catches this at compile time; this asserts the runtime invariant too.
  it('every supported host (non-empty tool registry) has a CLIENT_SYSTEM_PROMPTS entry', () => {
    const supported = (Object.keys(CLIENT_TOOL_REGISTRIES) as ClientHost[]).filter(isClientHostSupported);
    // Sanity: at least one host is supported (the registries are not all empty).
    expect(supported.length).toBeGreaterThan(0);
    for (const host of supported) {
      expect(CLIENT_SYSTEM_PROMPTS[host], `missing system prompt for supported host "${host}"`).toBeTruthy();
    }
  });

  it('CLIENT_SYSTEM_PROMPTS is total over CLIENT_HOSTS', () => {
    for (const host of CLIENT_HOSTS) {
      expect(CLIENT_SYSTEM_PROMPTS[host], `missing system prompt for host "${host}"`).toBeTruthy();
    }
  });
});

describe('WORD_CLIENT_SYSTEM_PROMPT', () => {
  it('pins the document-only scope and the no-RMM-claims rule', () => {
    expect(WORD_CLIENT_SYSTEM_PROMPT).toContain('Microsoft Word');
    expect(WORD_CLIENT_SYSTEM_PROMPT).toContain('never claim or imply such capabilities');
    expect(WORD_CLIENT_SYSTEM_PROMPT).toContain('click Apply');
    expect(WORD_CLIENT_SYSTEM_PROMPT).toContain('[REDACTED:');
    expect(WORD_CLIENT_SYSTEM_PROMPT).toContain('Be concise');
  });

  it('advertises the 5 baseline Word tools', () => {
    for (const tool of [
      'get_document_overview',
      'read_selection',
      'insert_text',
      'format_text',
      'find_replace',
    ]) {
      expect(WORD_CLIENT_SYSTEM_PROMPT).toContain(tool);
    }
  });
});

describe('POWERPOINT_CLIENT_SYSTEM_PROMPT', () => {
  it('pins the presentation-only scope and the no-RMM-claims rule', () => {
    expect(POWERPOINT_CLIENT_SYSTEM_PROMPT).toContain('Microsoft PowerPoint');
    expect(POWERPOINT_CLIENT_SYSTEM_PROMPT).toContain('never claim or imply such capabilities');
    expect(POWERPOINT_CLIENT_SYSTEM_PROMPT).toContain('click Apply');
    expect(POWERPOINT_CLIENT_SYSTEM_PROMPT).toContain('[REDACTED:');
    expect(POWERPOINT_CLIENT_SYSTEM_PROMPT).toContain('Be concise');
  });

  it('advertises the 5 baseline PowerPoint tools', () => {
    for (const tool of [
      'get_presentation_overview',
      'read_selection',
      'add_slide',
      'insert_text_box',
      'format_selection',
    ]) {
      expect(POWERPOINT_CLIENT_SYSTEM_PROMPT).toContain(tool);
    }
  });
});

describe('OUTLOOK_CLIENT_SYSTEM_PROMPT', () => {
  it('pins the mail-only scope and the no-RMM-claims rule', () => {
    expect(OUTLOOK_CLIENT_SYSTEM_PROMPT).toContain('Microsoft Outlook');
    expect(OUTLOOK_CLIENT_SYSTEM_PROMPT).toContain('never claim or imply such capabilities');
    expect(OUTLOOK_CLIENT_SYSTEM_PROMPT).toContain('click Apply');
    expect(OUTLOOK_CLIENT_SYSTEM_PROMPT).toContain('[REDACTED:');
    expect(OUTLOOK_CLIENT_SYSTEM_PROMPT).toContain('Be concise');
  });

  it('advertises the 4 baseline Outlook tools', () => {
    for (const tool of [
      'summarize_thread',
      'extract_action_items',
      'get_message_metadata',
      'draft_reply',
    ]) {
      expect(OUTLOOK_CLIENT_SYSTEM_PROMPT).toContain(tool);
    }
  });
});
