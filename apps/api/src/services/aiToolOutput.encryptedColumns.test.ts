import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// DB double: every query chain resolves to the next queued row set. Tool
// handlers build chains of very different shapes (select/from/where/orderBy/
// limit/for, insert/values/returning, ...); a proxy that answers every method
// with itself and resolves on `await` lets one double serve all of them, with
// each case listing only the rows its queries return, in order. A projected
// `select({ ... })` returns only the projected keys, as the database would, so
// a column the tool never selects cannot show up in its result.
// ---------------------------------------------------------------------------
const dbQueue = vi.hoisted(() => ({ responses: [] as unknown[][] }));

vi.mock('../db', async (importOriginal) => {
  const project = (rows: unknown[], keys: string[] | null) =>
    keys === null
      ? rows
      : rows.map((row) =>
          Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([k]) => keys.includes(k)))
        );
  const chain = (keys: string[] | null): unknown =>
    new Proxy(function chainLink() {}, {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then') {
          const rows = dbQueue.responses.length > 0 ? dbQueue.responses.shift()! : [];
          return (resolveFn: (v: unknown) => unknown, rejectFn: (e: unknown) => unknown) =>
            Promise.resolve(project(rows, keys)).then(resolveFn, rejectFn);
        }
        return () => chain(keys);
      },
      apply: () => chain(keys),
    });
  const select = (fields?: Record<string, unknown>) => chain(fields ? Object.keys(fields) : null);
  const db: Record<string, unknown> = {
    select,
    selectDistinct: select,
    insert: () => chain(null),
    update: () => chain(null),
    delete: () => chain(null),
    execute: () => chain(null),
  };
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return {
    ...(await importOriginal<typeof import('../db')>()),
    db,
    withDbAccessContext: async (_ctx: unknown, fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => unknown) => fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
  };
});

vi.mock('./eventBus', () => ({ publishEvent: vi.fn(async () => 'event-1') }));
vi.mock('./mlFeedbackEmitters', () => ({ emitAlertStateFeedback: vi.fn(async () => undefined) }));
vi.mock('../workers/webhookDelivery', () => ({
  getWebhookWorker: () => ({ queueDelivery: vi.fn(async () => undefined) }),
}));
vi.mock('./mlFeatureFlags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mlFeatureFlags')>()),
  shouldProduceMlOutput: vi.fn(async () => false),
}));
vi.mock('./assetReachabilityLoader', () => ({ loadReachability: vi.fn(async () => new Map()) }));

const monitorService = vi.hoisted(() => ({
  getMonitorDefinition: vi.fn(),
  createMonitorDefinition: vi.fn(),
  updateMonitorDefinition: vi.fn(),
}));
vi.mock('./monitors/monitorService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./monitors/monitorService')>()),
  ...monitorService,
}));

const channelConfig = vi.hoisted(() => ({
  selectNotificationChannelsWithConfig: vi.fn(),
  writeNotificationChannelConfig: vi.fn(async () => undefined),
}));
vi.mock('./notificationChannelConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./notificationChannelConfig')>()),
  ...channelConfig,
}));

// Load the registry hub first, as production does: aiToolsFixMemory reads an
// imported constant at registration time and hits the aiTools import cycle in
// its temporal dead zone when it is the first module to pull in './aiTools'.
import './aiTools';
import { compactToolResultForChat, redactAiToolOutputText } from './aiToolOutput';
import { encryptedColumnRegistry } from './encryptedColumnRegistry';
import { redactToolOutputFields } from './logRedaction';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
import { registerIntegrationTools } from './aiToolsIntegrations';
import { registerFleetTools } from './aiToolsFleet';
import { registerPolicyPrereqTools } from './aiToolsPolicyPrereqs';
import { registerMonitoringTools } from './aiToolsMonitoring';
import { registerMonitorTools } from './aiToolsMonitors';
import { registerAlertTools } from './aiToolsAlerts';
import { registerFixMemoryTools } from './aiToolsFixMemory';

// ===========================================================================
// Part 1 — registered columns whose name is specific enough to mask by name
// ===========================================================================

/**
 * Every column the encrypted-column registry seals is, by definition, secret.
 * If a tool returns one under its own name, the tool-output chokepoint must
 * mask it by name — so a column added to the registry is covered here without
 * anyone remembering to touch the redactor.
 *
 * The exceptions are columns whose name is too generic to mask everywhere it
 * appears in tool output (`url`, `value`, `settings`, ...). Masking every `url`
 * would wipe ordinary data from dozens of tools. Those columns are listed in
 * STORED_SECRET_COLUMNS below, with the tools that can return them.
 */

/** Secret columns stored outside the registry that tools must still never show. */
const UNREGISTERED_SECRET_COLUMNS = [
  'storage_encryption_keys.key_hash',
  'api_keys.key_hash',
];

const REDACTED = '[REDACTED]';
const camel = (column: string) => column.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

function maskedByName(key: string): boolean {
  const out = JSON.parse(
    compactToolResultForChat('some_tool', JSON.stringify({ row: { [key]: 'value-under-test' } }))
  );
  return out.row[key] === REDACTED;
}

// ===========================================================================
// Part 2 — stored secrets under generic column names: who returns them
// ===========================================================================

/**
 * A column holding secret material under a name the output chokepoint cannot
 * mask by name. Each entry lists every AI tool source file that can put the
 * column into a tool result, the tools in that file, and the helper they use
 * to show it safely.
 *
 * The static check below scans every tool source file for reads of these
 * columns (a full-row `select().from(t)`, `query.t.find*`, `getTableColumns(t)`,
 * `insert/update(t)…returning()`, a `t.field` projection, or a call to one of
 * the listed service accessors). A file that reads one and is not listed here
 * fails with the file and column named; add it with its masking helper and a
 * SENTINEL_CASES entry.
 */
interface StoredSecretReader {
  /** Path under apps/api/src. */
  file: string;
  /** Tools (or MCP resources, as `resource:<uri>`) in `file` that return rows. */
  tools: string[];
  /**
   * Identifier that must appear in `file` — the helper that shows the column
   * safely. Two markers stand in for a helper, each proved by a sentinel case
   * rather than by an identifier's presence:
   * - `OUTPUT_CHOKEPOINT`: the secret sits under a key name that
   *   compactToolResultForChat masks wherever it appears.
   * - `NOT_IN_RESULT`: the tool reads the column for its own use and never
   *   puts it in a result.
   */
  masking: string;
  /**
   * Set when the tool is known to return the column unmasked and the fix is
   * tracked separately. Such a tool needs no sentinel case; the reason says
   * what it returns.
   */
  knownGap?: string;
}

interface StoredSecretColumn {
  /** `table.column`, SQL names. */
  column: string;
  /** Drizzle export name of the table. */
  table: string;
  /** Drizzle property names on that table that hold the secret. */
  fields: string[];
  /** Service functions that return the column, so calling one counts as a read. */
  accessors?: string[];
  readers: StoredSecretReader[];
}

const OUTPUT_CHOKEPOINT = 'OUTPUT_CHOKEPOINT';
const NOT_IN_RESULT = 'NOT_IN_RESULT';

const STORED_SECRET_COLUMNS: StoredSecretColumn[] = [
  // ---- registered columns with generic names --------------------------------
  {
    column: 'webhooks.url',
    table: 'webhooks',
    fields: ['url'],
    readers: [
      { file: 'services/aiToolsIntegrations.ts', tools: ['query_webhooks', 'test_webhook'], masking: 'describeWebhookEndpoint' },
    ],
  },
  {
    column: 'webhooks.headers',
    table: 'webhooks',
    fields: ['headers'],
    readers: [
      // test_webhook loads the full row to queue a delivery.
      { file: 'services/aiToolsIntegrations.ts', tools: ['test_webhook'], masking: NOT_IN_RESULT },
    ],
  },
  {
    column: 'notification_channel_configs.config',
    table: 'notificationChannelConfigs',
    fields: ['config'],
    accessors: ['selectNotificationChannelsWithConfig', 'getNotificationChannelWithConfig', 'loadNotificationChannelConfigs'],
    readers: [
      // update reads the stored config only to merge into it.
      { file: 'services/aiToolsAlerts.ts', tools: ['manage_notification_channels'], masking: NOT_IN_RESULT },
    ],
  },
  {
    column: 'automations.trigger',
    table: 'automations',
    fields: ['trigger'],
    readers: [
      { file: 'services/aiToolsFleet.ts', tools: ['manage_automations'], masking: OUTPUT_CHOKEPOINT },
      { file: 'routes/mcpServer.ts', tools: ['resource:breeze://automations'], masking: 'redactToolOutputFields' },
    ],
  },
  { column: 'organizations.settings', table: 'organizations', fields: ['settings'], readers: [] },
  { column: 'partners.settings', table: 'partners', fields: ['settings'], readers: [] },
  { column: 'sites.settings', table: 'sites', fields: ['settings'], readers: [] },
  { column: 'tenant_variables.value', table: 'tenantVariables', fields: ['value'], readers: [] },
  {
    column: 'backup_configs.provider_config',
    table: 'backupConfigs',
    fields: ['providerConfig'],
    readers: [
      { file: 'services/aiToolsPolicyPrereqs.ts', tools: ['manage_backup_configs'], masking: 'redactProviderConfig' },
    ],
  },

  // ---- not in the registry, but may carry endpoint credentials -------------
  // A monitor target or check URL can hold userinfo, a `?token=` query or an
  // authorizing path segment; agent error text and alert text echo it.
  {
    column: 'network_monitors.target',
    table: 'networkMonitors',
    fields: ['target', 'config', 'lastError'],
    readers: [
      { file: 'services/aiToolsMonitoring.ts', tools: ['query_monitors', 'manage_monitors'], masking: 'presentEndpointTarget' },
    ],
  },
  {
    column: 'network_monitor_results.error',
    table: 'networkMonitorResults',
    fields: ['error', 'details'],
    readers: [
      { file: 'services/aiToolsMonitoring.ts', tools: ['manage_monitors'], masking: 'scrubUrlsInText' },
    ],
  },
  {
    column: 'monitor_definitions.condition',
    table: 'monitorDefinitions',
    fields: ['condition'],
    accessors: ['getMonitorDefinition', 'createMonitorDefinition', 'updateMonitorDefinition'],
    readers: [
      { file: 'services/aiToolsMonitors.ts', tools: ['get_monitor', 'manage_monitor_definitions'], masking: 'presentEndpointTarget' },
    ],
  },
  {
    column: 'config_policy_monitors.overrides',
    table: 'configPolicyMonitors',
    fields: ['overrides'],
    readers: [
      { file: 'services/aiToolsMonitors.ts', tools: ['get_monitor'], masking: 'presentEndpointTarget' },
    ],
  },
  {
    column: 'alerts.message',
    table: 'alerts',
    fields: ['message', 'context'],
    accessors: ['findAlertWithAccess', 'createTicketFromAlert'],
    readers: [
      { file: 'services/aiToolsAlerts.ts', tools: ['manage_alerts'], masking: 'scrubUrlsInText' },
      // Looks the alert up for its org and id only.
      { file: 'services/aiToolsFixMemory.ts', tools: ['find_proven_fixes'], masking: NOT_IN_RESULT },
      {
        file: 'services/aiToolsTicketing.ts',
        tools: ['manage_tickets'],
        masking: NOT_IN_RESULT,
        knownGap:
          'create_from_alert copies the stored alert message into the new ticket description and returns ' +
          'the ticket; alerts written before monitor targets were reduced to scheme + host still carry the full URL',
      },
    ],
  },
];

/** Registered columns the name-based chokepoint check skips (see Part 1). */
const GENERIC_NAME_COLUMNS = new Set(
  STORED_SECRET_COLUMNS.map((c) => c.column).filter((name) =>
    encryptedColumnRegistry.some((spec) => `${spec.table}.${spec.column}` === name)
  )
);

const SRC_ROOT = resolve(__dirname, '..');

/** Every file that defines AI tools or serves tool-shaped output to a model. */
function toolSourceFiles(): string[] {
  const services = readdirSync(join(SRC_ROOT, 'services'))
    .filter((f) => /^aiTools.*\.ts$/.test(f) && !f.includes('.test.'))
    .map((f) => `services/${f}`);
  return [...services, 'services/aiAgentSdkTools.ts', 'routes/mcpServer.ts'];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Why a tool file counts as reading `spec` (empty when it does not). Query
 * chains are matched on the source with whitespace removed, so a chain split
 * across lines still matches; names are matched on the source as written,
 * where word boundaries survive.
 */
function readSignals(original: string, spec: StoredSecretColumn): string[] {
  const source = original.replace(/\s+/g, '');
  const t = escapeRe(spec.table);
  const signals: string[] = [];
  if (new RegExp(`select\\(\\)\\.from\\(${t}\\)`).test(source)) signals.push(`select().from(${spec.table})`);
  if (new RegExp(`\\.query\\.${t}\\.find`).test(source)) signals.push(`query.${spec.table}.find*`);
  if (new RegExp(`getTableColumns\\(${t}\\)`).test(source)) signals.push(`getTableColumns(${spec.table})`);
  if (new RegExp(`(?:insert|update)\\(${t}\\)[^;]*?\\.returning\\(\\)`).test(source)) {
    signals.push(`${spec.table} write .returning()`);
  }
  for (const field of spec.fields) {
    if (new RegExp(`\\b${t}\\.${escapeRe(field)}\\b`).test(original)) signals.push(`${spec.table}.${field}`);
  }
  for (const accessor of spec.accessors ?? []) {
    if (new RegExp(`\\b${escapeRe(accessor)}\\(`).test(original)) signals.push(`${accessor}()`);
  }
  return signals;
}

// ===========================================================================
// Part 3 — behavioural sentinels
// ===========================================================================

/**
 * Stored values carry this marker in every position that can authorize a
 * request: URL userinfo, path, query, header value, nested secret field. The
 * marker must not appear anywhere in what the model receives.
 */
const SENTINEL = 'zq7sentinelvalue';
const SENTINEL_URL = `https://ops:${SENTINEL}@hooks.example.com/api/v1/${SENTINEL}/notify?key=${SENTINEL}`;

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
/** Id passed as tool input. */
const ID = '33333333-3333-4333-8333-333333333333';
/**
 * Id carried by stored rows. The double ignores WHERE, so a different value
 * from ID means a result that contains it was built from the stored row, not
 * echoed from the input.
 */
const ROW_ID = '44444444-4444-4444-8444-444444444444';

function unrestrictedAuth(): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: null,
    partnerId: PARTNER,
    orgId: ORG,
    scope: 'organization',
    accessibleOrgIds: [ORG],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as unknown as AuthContext;
}

const registry = new Map<string, AiTool>();
registerIntegrationTools(registry);
registerFleetTools(registry);
registerPolicyPrereqTools(registry);
registerMonitoringTools(registry);
registerMonitorTools(registry);
registerAlertTools(registry);
registerFixMemoryTools(registry);

interface SentinelCase {
  name: string;
  tool: string;
  input: Record<string, unknown>;
  /** Row sets returned by the tool's queries, in order. */
  rows?: unknown[][];
  setup?: () => void;
  /** Text proving the result was built from the stored row (default: ROW_ID). */
  reached?: string;
}

const webhookRow = {
  id: ROW_ID, orgId: ORG, name: 'Ops hook', url: SENTINEL_URL, status: 'active', events: ['alert.triggered'],
  headers: { Authorization: `Bearer ${SENTINEL}`, 'X-Hook-Key': SENTINEL }, secret: SENTINEL,
  successCount: 1, failureCount: 0, approvalGeneration: 1, createdAt: new Date('2026-01-01'),
};

const automationRow = {
  id: ROW_ID, orgId: ORG, partnerId: null, name: 'Hook automation', description: null, enabled: true,
  trigger: { type: 'webhook', secret: SENTINEL, webhookSecret: SENTINEL },
  conditions: null, actions: [], onFailure: 'stop', lastRunAt: null, runCount: 0, managedByMonitorId: null,
  createdAt: new Date('2026-01-01'),
};

const networkMonitorRow = {
  id: ROW_ID, orgId: ORG, name: 'Status page', monitorType: 'http_check', target: SENTINEL_URL,
  config: { url: SENTINEL_URL, method: 'GET', headers: { 'X-Key': SENTINEL } },
  lastError: `Get "${SENTINEL_URL}": dial tcp: i/o timeout`, lastStatus: 'offline',
  assetId: null, managedByMonitorId: null, isActive: true,
};

const monitorDefinitionRow = {
  id: ROW_ID, name: 'Status page', kind: 'network_check', orgId: ORG, partnerId: null, severity: 'high', enabled: true,
  condition: { checkType: 'http_check', target: SENTINEL_URL, method: 'GET' },
  compiledAlertTemplateId: null, compiledAlertRuleId: null, compiledAutomationId: null,
};

const networkMonitorAlert = {
  id: ROW_ID, orgId: ORG, deviceId: null, status: 'active', severity: 'high', title: 'Status page offline',
  message: `Monitor Status page is offline. Target: ${SENTINEL_URL}. Status: offline.`,
  context: { source: 'network_monitor', target: SENTINEL_URL, error: `Get "${SENTINEL_URL}": EOF` },
  contextSource: 'network_monitor', triggeredAt: new Date('2026-01-01'), triggeredAtCursor: '2026-01-01T00:00:00.000000Z',
};

const SENTINEL_CASES: SentinelCase[] = [
  { name: 'query_webhooks list', tool: 'query_webhooks', input: {}, rows: [[webhookRow]] },
  { name: 'test_webhook', tool: 'test_webhook', input: { webhookId: ID }, rows: [[webhookRow], [{ id: 'delivery-1', createdAt: new Date() }]] },
  { name: 'manage_automations list', tool: 'manage_automations', input: { action: 'list' }, rows: [[automationRow]] },
  { name: 'manage_automations get', tool: 'manage_automations', input: { action: 'get', automationId: ID }, rows: [[automationRow]] },
  {
    name: 'manage_backup_configs get',
    tool: 'manage_backup_configs',
    input: { action: 'get', configId: ID },
    rows: [[{
      id: ROW_ID, orgId: ORG, name: 'S3', provider: 's3',
      providerConfig: {
        bucket: 'b', region: 'us-east-1', accessKey: SENTINEL, secretKey: SENTINEL,
        // Azure and B2 key names, which only the provider-config helper knows are secret.
        accountKey: SENTINEL, applicationKey: SENTINEL,
      },
    }]],
  },
  {
    name: 'manage_notification_channels update',
    tool: 'manage_notification_channels',
    input: { action: 'update', channelId: ID, name: 'Renamed' },
    reached: 'Channel \\"Ops\\" updated',
    setup: () => {
      channelConfig.selectNotificationChannelsWithConfig.mockResolvedValueOnce([{
        id: ROW_ID, orgId: ORG, partnerId: null, name: 'Ops', type: 'webhook', enabled: true,
        config: { url: SENTINEL_URL, headers: [{ key: 'Authorization', value: SENTINEL }] },
      }]);
    },
  },
  { name: 'query_monitors list', tool: 'query_monitors', input: {}, rows: [[networkMonitorRow]] },
  {
    name: 'manage_monitors get',
    tool: 'manage_monitors',
    input: { action: 'get', monitorId: ID },
    rows: [
      [networkMonitorRow],
      [{
        id: 'r1', status: 'offline', responseMs: 10, statusCode: null, timestamp: new Date('2026-01-01'),
        error: `Get "${SENTINEL_URL}": context deadline exceeded`,
        details: { sslRequestedUrl: SENTINEL_URL },
      }],
      [],
    ],
  },
  {
    name: 'get_monitor',
    tool: 'get_monitor',
    input: { monitorId: ID },
    setup: () => monitorService.getMonitorDefinition.mockResolvedValueOnce(monitorDefinitionRow),
    rows: [[{ id: 'att1', configPolicyId: 'p1', policyName: 'Policy A', enabled: true, overrides: { target: SENTINEL_URL } }]],
  },
  {
    name: 'manage_monitor_definitions create',
    tool: 'manage_monitor_definitions',
    input: {
      action: 'create',
      definition: {
        name: 'Status page', kind: 'network_check', severity: 'high',
        condition: { checkType: 'http_check', target: 'https://hooks.example.com' },
      },
    },
    setup: () => monitorService.createMonitorDefinition.mockResolvedValueOnce(monitorDefinitionRow),
  },
  {
    name: 'manage_monitor_definitions update',
    tool: 'manage_monitor_definitions',
    input: { action: 'update', monitorId: ID, definition: { name: 'Status page 2' } },
    setup: () => monitorService.updateMonitorDefinition.mockResolvedValueOnce(monitorDefinitionRow),
  },
  { name: 'manage_alerts get', tool: 'manage_alerts', input: { action: 'get', alertId: ID }, rows: [[networkMonitorAlert], []] },
  {
    name: 'find_proven_fixes',
    tool: 'find_proven_fixes',
    input: { alertId: ID },
    rows: [[networkMonitorAlert]],
    // The ML gate is off in this test, so a result past the alert lookup is the
    // disabled envelope; "Alert not found" would mean the row was never read.
    reached: '"disabled":true',
  },
  { name: 'manage_alerts list', tool: 'manage_alerts', input: { action: 'list' }, rows: [[{ count: 1 }], [networkMonitorAlert]] },
];

async function runCase(c: SentinelCase): Promise<{ raw: string; chat: string }> {
  dbQueue.responses = [...(c.rows ?? [])];
  c.setup?.();
  const tool = registry.get(c.tool);
  if (!tool) throw new Error(`${c.tool} is not registered by the tool modules this test loads`);
  const raw = await tool.handler(c.input, unrestrictedAuth());
  return { raw, chat: compactToolResultForChat(c.tool, raw) };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('compactToolResultForChat — encrypted-column registry names are masked', () => {
  const registered = encryptedColumnRegistry.map((spec) => `${spec.table}.${spec.column}`);

  it.each(
    [...registered.filter((name) => !GENERIC_NAME_COLUMNS.has(name)), ...UNREGISTERED_SECRET_COLUMNS]
  )('%s is masked under its snake and camel names', (qualified) => {
    const column = qualified.split('.')[1]!;
    expect(maskedByName(column)).toBe(true);
    expect(maskedByName(camel(column))).toBe(true);
  });
});

describe('stored secrets under generic column names — tool readers are declared', () => {
  const files = toolSourceFiles();
  const sources = new Map(files.map((f) => [f, readFileSync(join(SRC_ROOT, f), 'utf8')]));

  it('finds the tool source files', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each(STORED_SECRET_COLUMNS.map((c) => [c.column, c] as const))(
    '%s: every tool file that reads it is declared, with its masking helper',
    (_name, spec) => {
      const declared = new Set(spec.readers.map((r) => r.file));
      const undeclared: string[] = [];
      for (const [file, source] of sources) {
        const signals = readSignals(source, spec);
        if (signals.length > 0 && !declared.has(file)) undeclared.push(`${file} (${signals.join(', ')})`);
      }
      expect(
        undeclared,
        `These tool files read ${spec.column}, which holds credentials under a name the output ` +
          `chokepoint cannot mask. Show it through a masking helper and add the file to ` +
          `STORED_SECRET_COLUMNS plus a SENTINEL_CASES entry.`
      ).toEqual([]);

      for (const reader of spec.readers) {
        const source = sources.get(reader.file);
        expect(source, `${reader.file} is not a tool source file`).toBeDefined();
        expect(readSignals(source!, spec), `${reader.file} no longer reads ${spec.column}; drop the entry`).not.toEqual([]);
        if (reader.masking !== OUTPUT_CHOKEPOINT && reader.masking !== NOT_IN_RESULT) {
          expect(source!, `${reader.file} must use ${reader.masking} for ${spec.column}`).toContain(reader.masking);
        }
        for (const tool of reader.tools) {
          if (tool.startsWith('resource:')) {
            expect(source!).toContain(`'${tool.slice('resource:'.length)}'`);
          } else {
            expect(source!, `${tool} is not defined in ${reader.file}`).toContain(`name: '${tool}'`);
          }
        }
      }
    }
  );

  it('every declared tool has a sentinel case', () => {
    const covered = new Set(SENTINEL_CASES.map((c) => c.tool));
    const declaredTools = STORED_SECRET_COLUMNS.flatMap((c) => c.readers.filter((r) => !r.knownGap).flatMap((r) => r.tools))
      .filter((t) => !t.startsWith('resource:'));
    expect([...new Set(declaredTools)].filter((t) => !covered.has(t))).toEqual([]);
  });
});

describe('stored secrets under generic column names — tool results never show them', () => {
  beforeEach(() => {
    dbQueue.responses = [];
    vi.clearAllMocks();
  });

  it.each(SENTINEL_CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const { raw, chat } = await runCase(c);
    // The case must reach the rows, not stop on a validation or access error.
    expect(JSON.parse(raw).error, raw).toBeUndefined();
    expect(raw, 'the result must come from the stored row').toContain(c.reached ?? ROW_ID);
    expect(chat, 'model-facing tool result').not.toContain(SENTINEL);
  });

  it('the breeze://automations MCP resource is read with field redaction on', () => {
    const source = readFileSync(join(SRC_ROOT, 'routes/mcpServer.ts'), 'utf8');
    const start = source.indexOf("uri === 'breeze://automations'");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf('\n    }\n', start));
    expect(block).toContain('redactFields: true');
  });

  it('field redaction masks automation trigger secrets', () => {
    const rows = redactToolOutputFields(
      JSON.parse(JSON.stringify([{ id: ID, name: 'Hook automation', trigger: automationRow.trigger }])),
      redactAiToolOutputText
    );
    expect(JSON.stringify(rows)).not.toContain(SENTINEL);
  });
});
