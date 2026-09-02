/**
 * Secret delivery end to end against real Postgres (#3409 PR4c-2).
 *
 * The unit suites (`services/scriptSecretDelivery.test.ts`,
 * `services/scriptDispatch.test.ts`, `services/sourcedParameters.test.ts`)
 * all mock `../db`, so every one of them asserts the SHAPE of a write that
 * never happens. The properties this feature actually exists for only mean
 * something once a row is really stored and read back:
 *
 *   1. ENQUEUE — a `tenantSecret` parameter is resolved, sealed, and STORED
 *      as an AAD-bound `secretEnvEnvelope`; neither the persisted command row
 *      nor the persisted execution row contains the plaintext anywhere, and
 *      the envelope opens — with the stored row's own id as AAD — back to the
 *      exact value the encrypted `tenant_variables` row holds. That round
 *      trip crosses four independent encodings (tenant-variable AAD, jsonb
 *      storage, envelope AAD, canonical envelope JSON); a mocked db proves
 *      none of them agree.
 *   2. CLAIM — after a real agent downgrade (`script_secret_env_version` back
 *      to 0), the real claim batch + `decryptClaimedCommandsForDelivery`
 *      withholds the command AND drives both it and its linked execution row
 *      terminal, with the payload erased. The `status = 'sent'` guard on that
 *      terminal UPDATE only has meaning against a row the claim actually
 *      flipped to `sent`.
 *   3-4. The two enqueue refusals that must leave NO orphan rows behind
 *      (an incapable agent, and a user-context run) — "no orphan" is a
 *      statement about the database, so it is asserted by counting rows.
 *
 * Fixture note: the `tenant_variables` row is sealed through the service's own
 * `encryptTenantVariableValue` (as `tenantVariableResolution.integration.
 * test.ts` does), because the ciphertext AAD binds the row id — a plaintext
 * literal would fail to decrypt, drop out of the resolved scope, and turn
 * every assertion below into a vacuous "unresolved parameter" failure.
 *
 * The device snapshot handed to `dispatchScriptToDevice` deliberately carries
 * NO `agentId`: the immediate-send path would otherwise claim the command
 * itself, and test 2 needs the row to still be `pending` for the real claim
 * batch to take.
 *
 * Lives under `src/__tests__/integration/`, so the config's
 * `src/__tests__/integration/**` include glob already covers it.
 */
import './setup';
import { randomUUID } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ScriptParameterDefinition } from '@breeze/shared';

import { withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { deviceCommands, devices, scriptExecutions, scripts, tenantVariables } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { encryptTenantVariableValue } from '../../services/tenantVariables';
import { loadTenantVariableScope } from '../../services/tenantVariableResolution';
import { dispatchScriptToDevice, type DispatchScriptInput } from '../../services/scriptDispatch';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { decryptClaimedCommandsForDelivery } from '../../services/commandDelivery';
import { openSecretEnv } from '../../services/scriptSecretEnvelope';
import { AGENT_UPGRADE_REQUIRED_MESSAGE } from '../../services/scriptSecretDelivery';

const SECRET_KEY = 'vendor_token';
/** Long enough to clear MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH and distinctive
 * enough that a `JSON.stringify(row)` substring search is meaningful. */
const SECRET_VALUE = 'sk-live-integration-9f3a2b7c4d1e';
const PARAM_NAME = 'api_token';

const SECRET_PARAMETERS: ScriptParameterDefinition[] = [
  { name: PARAM_NAME, type: 'string', required: true, source: 'tenantSecret', variableKey: SECRET_KEY },
];

interface Scenario {
  orgId: string;
  deviceId: string;
  variableId: string;
  variableVersion: number;
  script: typeof scripts.$inferSelect;
  /**
   * The snapshot dispatch receives. `agentId` is nulled on purpose (see the
   * file header) — the column itself is NOT NULL, so this is a property of the
   * caller's snapshot, not of the stored row.
   */
  deviceSnapshot: DispatchScriptInput['device'];
}

async function seedScenario(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site!.id,
      agentId: randomUUID(),
      hostname: `secret-delivery-${randomUUID().slice(0, 8)}`,
      osType: 'linux',
      osVersion: '24.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
      // The PR4b capability floor. Test 2 walks it back down to 0.
      scriptSecretEnvVersion: 1,
    })
    .returning();

  const variableId = randomUUID();
  const [variable] = await getTestDb()
    .insert(tenantVariables)
    .values({
      id: variableId,
      orgId: org.id,
      key: SECRET_KEY,
      value: encryptTenantVariableValue(variableId, SECRET_VALUE),
      isSecret: true,
    })
    .returning();

  const [script] = await getTestDb()
    .insert(scripts)
    .values({
      orgId: org.id,
      name: `secret-delivery-${randomUUID().slice(0, 8)}`,
      osTypes: ['linux'],
      language: 'bash',
      content: '#!/bin/bash\ncurl -H "Authorization: Bearer $BREEZE_VAR_API_TOKEN" https://vendor.example.test',
      parameters: SECRET_PARAMETERS,
      runAs: 'system',
      timeoutSeconds: 300,
    })
    .returning();

  return {
    orgId: org.id,
    deviceId: device!.id,
    variableId: variable!.id,
    variableVersion: variable!.version,
    script: script!,
    deviceSnapshot: {
      id: device!.id,
      orgId: device!.orgId,
      osType: device!.osType,
      status: device!.status,
      // Forces the "queued for later" path — no immediate claim/send.
      agentId: null as unknown as string,
      hostname: device!.hostname,
      siteId: device!.siteId,
      customFields: device!.customFields,
    },
  };
}

async function dispatch(
  scn: Scenario,
  overrides: Partial<DispatchScriptInput> = {},
): Promise<Awaited<ReturnType<typeof dispatchScriptToDevice>>> {
  const variableScope = await loadTenantVariableScope([scn.orgId]);
  return withSystemDbAccessContext(() =>
    dispatchScriptToDevice({
      device: scn.deviceSnapshot,
      source: { kind: 'saved', script: scn.script },
      variableScope,
      triggerType: 'manual',
      ...overrides,
    }),
  );
}

async function commandsForDevice(deviceId: string) {
  return getTestDb().select().from(deviceCommands).where(eq(deviceCommands.deviceId, deviceId));
}

async function executionsForDevice(deviceId: string) {
  return getTestDb().select().from(scriptExecutions).where(eq(scriptExecutions.deviceId, deviceId));
}

async function setSecretEnvVersion(deviceId: string, version: number): Promise<void> {
  await getTestDb().update(devices).set({ scriptSecretEnvVersion: version }).where(eq(devices.id, deviceId));
}

describe('script secret delivery (integration)', () => {
  let scn: Scenario;

  beforeEach(async () => {
    scn = await seedScenario();
  });

  it('1. seals the resolved secret into the stored command and never persists the plaintext', async () => {
    const result = await dispatch(scn);
    expect(result).toMatchObject({ ok: true, deliveryOutcome: 'no_agent' });
    if (!result.ok) throw new Error(result.error);

    const [commandRow] = await commandsForDevice(scn.deviceId);
    expect(commandRow).toBeDefined();
    expect(commandRow!.id).toBe(result.commandId);

    const payload = commandRow!.payload as Record<string, unknown>;
    expect(typeof payload.secretEnvEnvelope).toBe('string');
    expect(payload.secretEnvEnvelope as string).toMatch(/^enc:v3:/);
    // The wire-only field name must never survive to storage: seeing BOTH
    // would mean the seal ran but failed to consume its input.
    expect(Object.keys(payload)).not.toContain('secretEnv');
    // The agent substitutes every entry of `parameters` into the script text,
    // so the secret must not be there either.
    expect(payload.parameters).toEqual({});

    const [executionRow] = await executionsForDevice(scn.deviceId);
    expect(executionRow).toBeDefined();
    expect(JSON.stringify(commandRow)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(executionRow)).not.toContain(SECRET_VALUE);

    // The whole point: the STORED envelope, opened with the STORED row's own
    // AAD, is the value the encrypted tenant_variables row holds.
    expect(
      openSecretEnv(payload.secretEnvEnvelope as string, {
        commandId: commandRow!.id,
        deviceId: scn.deviceId,
      }),
    ).toEqual({ [PARAM_NAME]: SECRET_VALUE });

    // History records the binding's IDENTITY and nothing else.
    const bindings = (executionRow!.parameters as Record<string, unknown>).$bindings;
    expect(bindings).toEqual([
      {
        key: PARAM_NAME,
        source: 'tenantSecret',
        variableId: scn.variableId,
        ownerScope: 'organization',
        version: scn.variableVersion,
      },
    ]);
  });

  it('2. fails an already-enqueued secret command when the agent is downgraded before claim', async () => {
    const result = await dispatch(scn);
    if (!result.ok) throw new Error(result.error);

    // The agent restarts on an older build: the heartbeat writes this column
    // non-sticky every beat, so the capability really can drop after enqueue.
    await setSecretEnvVersion(scn.deviceId, 0);

    const deliverable = await withSystemDbAccessContext(async () => {
      const claimed = await claimPendingCommandsForDevice(scn.deviceId);
      expect(claimed).toHaveLength(1);
      return decryptClaimedCommandsForDelivery(
        claimed.map((cmd) => ({
          id: cmd.id,
          type: cmd.type,
          deviceId: cmd.deviceId,
          payload: cmd.payload,
          executedAt: cmd.executedAt,
        })),
      );
    });

    // Nothing reaches the agent...
    expect(deliverable).toEqual([]);

    // ...and the command is TERMINAL, not released back to pending (an
    // incapable agent would only re-claim it), with the envelope erased.
    const [commandRow] = await commandsForDevice(scn.deviceId);
    expect(commandRow!.status).toBe('failed');
    expect(commandRow!.completedAt).toBeInstanceOf(Date);
    expect(commandRow!.result).toMatchObject({ error: AGENT_UPGRADE_REQUIRED_MESSAGE });
    expect(Object.keys(commandRow!.payload as Record<string, unknown>)).not.toContain(
      'secretEnvEnvelope',
    );

    const [executionRow] = await executionsForDevice(scn.deviceId);
    expect(executionRow!.status).toBe('failed');
    expect(executionRow!.errorMessage).toBe(AGENT_UPGRADE_REQUIRED_MESSAGE);
  });

  it('3. refuses at enqueue for an agent without secret-env support, leaving no orphan rows', async () => {
    await setSecretEnvVersion(scn.deviceId, 0);

    const result = await dispatch(scn);
    expect(result).toMatchObject({ ok: false, code: 'agent_upgrade_required' });

    expect(await commandsForDevice(scn.deviceId)).toHaveLength(0);
    expect(await executionsForDevice(scn.deviceId)).toHaveLength(0);
  });

  it('4. refuses a user-context run, leaving no orphan rows', async () => {
    const result = await dispatch(scn, { runAs: 'user' });
    expect(result).toMatchObject({ ok: false, code: 'secrets_unsupported_run_as' });

    expect(await commandsForDevice(scn.deviceId)).toHaveLength(0);
    expect(await executionsForDevice(scn.deviceId)).toHaveLength(0);
  });
});
