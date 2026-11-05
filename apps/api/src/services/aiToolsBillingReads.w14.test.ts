import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const PARTNER = '00000000-0000-4000-8000-0000000000e1';
const DEV = '00000000-0000-4000-8000-0000000000f1';
const CONTRACT = '00000000-0000-4000-8000-0000000000a1';
const PERIOD = '00000000-0000-4000-8000-0000000000a2';
const INVOICE = '00000000-0000-4000-8000-0000000000a3';
const LINE = '00000000-0000-4000-8000-0000000000a4';

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  coverage: vi.fn(),
  periodOutcome: vi.fn(),
  lineDevices: vi.fn(),
  mismatches: vi.fn(),
  getContract: vi.fn(),
  listContracts: vi.fn(),
  getInvoice: vi.fn(),
  hourPeriods: vi.fn(),
}));

vi.mock('../db', () => ({ db: {}, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: h.verify }));
vi.mock('./deviceCoverage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./deviceCoverage')>();
  return { DeviceCoverageError: actual.DeviceCoverageError, contractLinesCoveringDevice: h.coverage };
});
vi.mock('./billingEvidence', () => ({
  getPeriodOutcome: h.periodOutcome, listInvoiceLineDevices: h.lineDevices,
  INVOICE_LINE_DEVICES_DEFAULT_LIMIT: 100, INVOICE_LINE_DEVICES_MAX_LIMIT: 500,
}));
vi.mock('./contractCurrencyReportService', () => ({ listContractCurrencyMismatches: h.mismatches }));
vi.mock('./contractService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contractService')>();
  return { ...actual, getContract: h.getContract, listContracts: h.listContracts };
});
vi.mock('./contractHourPeriodsRead', () => ({ listContractHourPeriods: h.hourPeriods }));
vi.mock('./invoiceService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./invoiceService')>();
  return { ...actual, getInvoice: h.getInvoice };
});

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerDeviceBillingTools } from './aiToolsDeviceBilling';
import { registerContractTools } from './aiToolsContracts';
import { registerBillingTools } from './aiToolsBilling';
import { DeviceCoverageError } from './deviceCoverage';

const tools = new Map<string, AiTool>();
for (const register of [registerDeviceBillingTools, registerContractTools, registerBillingTools]) register(tools);

const makeAuth = (over: Record<string, unknown> = {}) => ({
  principal: { kind: 'user_session' },
  user: { id: 'user-1', email: 'tech@example.test' },
  scope: 'partner',
  orgId: null,
  partnerId: PARTNER,
  accessibleOrgIds: [ORG],
  canAccessOrg: (id: string) => id === ORG,
  orgCondition: () => undefined,
  allowedSiteIds: undefined,
  allowedDeviceIds: undefined,
  token: { mfa: true },
  ...over,
}) as unknown as AuthContext;
const run = async (name: string, input: Record<string, unknown>, auth: AuthContext = makeAuth()) =>
  JSON.parse(await tools.get(name)!.handler(input, auth)) as Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.verify.mockResolvedValue({ device: { id: DEV, orgId: ORG, siteId: 's1' } });
});

describe('get_device_billing', () => {
  it('is partner / system scope only (REST)', async () => {
    expect((await run('get_device_billing', { deviceId: DEV }, makeAuth({ scope: 'organization', orgId: ORG }))).code).toBe('PARTNER_SCOPE_REQUIRED');
    expect(h.coverage).not.toHaveBeenCalled();
  });

  it('goes through the device gate first; an unreachable device is not found', async () => {
    h.verify.mockResolvedValue({ error: 'Device not found or access denied' });
    expect((await run('get_device_billing', { deviceId: DEV })).error).toMatch(/not found/i);
    expect(h.coverage).not.toHaveBeenCalled();
  });

  it('returns the covering lines; an unevaluable group is an error, never an empty list', async () => {
    h.coverage.mockResolvedValue({ deviceId: DEV, orgId: ORG, lines: [{ contractLineId: 'l1', description: 'Managed workstation $40' }], uncovered: false });
    expect((await run('get_device_billing', { deviceId: DEV })).billing.lines).toHaveLength(1);
    expect(h.coverage).toHaveBeenCalledWith(DEV, { accessibleOrgIds: [ORG] });
    h.coverage.mockRejectedValue(new DeviceCoverageError('Group could not be evaluated', 500, 'GROUP_EVALUATION_FAILED'));
    const out = await run('get_device_billing', { deviceId: DEV });
    expect(out.code).toBe('GROUP_EVALUATION_FAILED');
    expect(out.lines).toBeUndefined();
  });
});

describe('W14 read selectors on the existing contract / invoice reads', () => {
  it('get_contract with periodId returns only the period outcome', async () => {
    h.periodOutcome.mockResolvedValue({ recorded: true, outcome: { contractBillingPeriodId: PERIOD, uncoveredTotal: 2 } });
    const out = await run('get_contract', { contractId: CONTRACT, periodId: PERIOD });
    expect(out).toEqual({ contractId: CONTRACT, periodId: PERIOD, recorded: true, outcome: { contractBillingPeriodId: PERIOD, uncoveredTotal: 2 } });
    expect(h.periodOutcome).toHaveBeenCalledWith(CONTRACT, PERIOD, expect.objectContaining({ partnerId: PARTNER }));
    expect(h.getContract).not.toHaveBeenCalled();
  });

  it('get_contract without periodId is unchanged', async () => {
    h.getContract.mockResolvedValue({ contract: { id: CONTRACT }, lines: [], periods: [] });
    h.hourPeriods.mockResolvedValue({ items: [] });
    expect((await run('get_contract', { contractId: CONTRACT })).contract.id).toBe(CONTRACT);
    expect(h.periodOutcome).not.toHaveBeenCalled();
  });

  it('list_contracts view currency_mismatches calls the currency report with the same filters', async () => {
    h.mismatches.mockResolvedValue({ items: [{ contractId: CONTRACT }], nextCursor: null });
    const out = await run('list_contracts', { view: 'currency_mismatches', orgId: ORG, limit: 10 });
    expect(h.mismatches).toHaveBeenCalledWith({ orgId: ORG, limit: 10 }, expect.objectContaining({ partnerId: PARTNER }));
    expect(out.currencyMismatches.items).toHaveLength(1);
    expect(h.listContracts).not.toHaveBeenCalled();
  });

  it('get_invoice with lineId pages the line\'s billed devices', async () => {
    h.lineDevices.mockResolvedValue({ recorded: true, total: 1, devices: [{ id: 'e1', hostname: 'WS-01' }], nextCursor: null });
    const out = await run('get_invoice', { invoiceId: INVOICE, lineId: LINE, limit: 50 });
    expect(h.lineDevices).toHaveBeenCalledWith(INVOICE, LINE, { limit: 50 }, expect.objectContaining({ partnerId: PARTNER }));
    expect(out).toMatchObject({ invoiceId: INVOICE, lineId: LINE, total: 1 });
    expect(h.getInvoice).not.toHaveBeenCalled();
  });

  it('the selectors keep the family\'s partner-scope refusal', async () => {
    const org = makeAuth({ scope: 'organization', orgId: ORG });
    expect((await run('get_contract', { contractId: CONTRACT, periodId: PERIOD }, org)).code).toBe('PARTNER_SCOPE_REQUIRED');
    expect((await run('get_invoice', { invoiceId: INVOICE, lineId: LINE }, org)).code).toBe('PARTNER_SCOPE_REQUIRED');
    expect(h.periodOutcome).not.toHaveBeenCalled();
    expect(h.lineDevices).not.toHaveBeenCalled();
  });
});
