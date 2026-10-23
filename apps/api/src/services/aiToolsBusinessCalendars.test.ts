import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

vi.mock('./businessCalendars/service', () => ({
  listCalendars: vi.fn(),
  getResolvedCalendarForOrg: vi.fn(),
  BusinessCalendarError: class BusinessCalendarError extends Error {
    constructor(message: string, readonly status: number, readonly code: string) { super(message); }
  },
}));

import { getResolvedCalendarForOrg, listCalendars, BusinessCalendarError } from './businessCalendars/service';
import { registerBusinessCalendarTools } from './aiToolsBusinessCalendars';
import { toolInputSchemas } from './aiToolSchemas';

const ORG = '22222222-2222-4222-8222-222222222222';
const orgAuth = { scope: 'organization', orgId: ORG, partnerId: 'p-1', user: { id: 'u' } } as unknown as AuthContext;

function tools(): Map<string, AiTool> {
  const m = new Map<string, AiTool>();
  registerBusinessCalendarTools(m);
  return m;
}
const call = (input: Record<string, unknown>, auth = orgAuth) =>
  tools().get('list_business_calendars')!.handler(input, auth).then((s) => JSON.parse(s));

describe('list_business_calendars (#8973 W4, spec §5.7)', () => {
  beforeEach(() => {
    vi.mocked(listCalendars).mockReset();
    vi.mocked(getResolvedCalendarForOrg).mockReset();
  });

  it('is the only tool, tier 1, with a short description', () => {
    const m = tools();
    expect([...m.keys()]).toEqual(['list_business_calendars']);
    const tool = m.get('list_business_calendars')!;
    expect(tool.tier).toBe(1);
    expect(tool.definition.description?.length ?? 0).toBeGreaterThan(0);
    expect(tool.definition.description!.length).toBeLessThanOrEqual(300);
  });

  it("an org-scope caller gets its org's calendars plus the inherited partner ones, and what applies", async () => {
    vi.mocked(listCalendars).mockResolvedValue([{ id: 'c-1', name: 'Support' }] as never);
    vi.mocked(getResolvedCalendarForOrg).mockResolvedValue({ source: 'partner', calendarId: 'c-1', revisionId: 'r-1', calendarName: 'Support', overrideCalendarId: null });
    const out = await call({});
    expect(listCalendars).toHaveBeenCalledWith(orgAuth, { orgId: ORG, includeArchived: false });
    expect(getResolvedCalendarForOrg).toHaveBeenCalledWith(orgAuth, ORG);
    expect(out).toEqual({ calendars: [{ id: 'c-1', name: 'Support' }], applies: { source: 'partner', calendarId: 'c-1', revisionId: 'r-1', calendarName: 'Support', overrideCalendarId: null } });
  });

  it('a service refusal comes back as an error payload, not a throw', async () => {
    vi.mocked(listCalendars).mockRejectedValue(new BusinessCalendarError('Organization not found', 404, 'NOT_FOUND'));
    expect(await call({ orgId: '33333333-3333-4333-8333-333333333333' })).toEqual({ error: 'Organization not found', code: 'NOT_FOUND' });
  });

  it('has a zod input schema with no z.undefined()', () => {
    const schema = toolInputSchemas.list_business_calendars;
    expect(schema).toBeDefined();
    expect(schema!.safeParse({ orgId: ORG, includeArchived: true }).success).toBe(true);
    expect(schema!.safeParse({ orgId: 'nope' }).success).toBe(false);
  });
});
