/**
 * W06 (#7604, Decision D6): the deployment-wide MCP_LLM_PROVIDER=openai-compatible
 * path becomes data — one env-managed `openai_compatible` connection per
 * partner (`provider_config.managedBy = 'env'`) plus one manual offering for
 * MCP_LLM_MODEL priced from MCP_LLM_PRICE_* (USD/M → cents/M; cache read at the
 * input price, cache write 0 — the env path never had cache prices).
 *
 * Runs at boot (detached, with a bounded retry schedule) and is idempotent:
 *  - per partner, ensurePartnerCutover FIRST (Codex review #4: the cutover
 *    rewrites assignments and must never run after this), then ONE system
 *    transaction holding the partner registry lock (envOpenAiBootstrapStore),
 *    so concurrent replicas serialise per partner and the second sees the
 *    first's connection;
 *  - the boot that CREATES the connection re-points the partner's `chat`
 *    default to it, only from a platform offering (or no default) — exactly
 *    where legacy routing sent chat to the env endpoint. Never redone: an
 *    admin who later moves chat elsewhere is respected;
 *  - later boots re-sync drift: URL/key → updateGatewayConnectionLocked
 *    (allowManaged, bumps config_version); MCP_LLM_MODEL → that model's
 *    offering (enabled), chat moved from the old env offering only where the
 *    default is exactly it, the old one disabled unless still referenced;
 *    prices → re-priced;
 *  - variables unset → every env-managed connection is RELEASED
 *    (provider_config.envReleasedAt): nothing deleted or disabled, so chat
 *    keeps working, but the row still holds the operator's endpoint and key,
 *    so it stays read-only for the partner, who may only disconnect it;
 *  - variables set again → the released row is re-adopted (marker cleared,
 *    URL/key/model re-synced as on any later boot). Never a second connection,
 *    and never a second platform-default re-point.
 * The base URL goes through validateByoBaseUrl once, outside any DB context
 * (same self-host private-network policy as the deleted env runtime).
 * Verification jobs are enqueued only after the partner's transaction
 * committed, ids only, with a delayed retry of a failed verdict; an offering
 * without a passing record for its current endpoint is re-queued on every
 * boot. A URL/key re-sync revokes the connection's live gateway grants after
 * commit. After boot, partners created later are picked up every 10 minutes
 * (syncEnvOpenAiNewPartners). Neither the report nor a log line ever carries
 * the key.
 */
import type { ModelRates } from '@breeze/shared';
import { getConfig, type AppConfig } from '../../config/validate';
import { isHosted } from '../../config/env';
import { runOutsideDbContext } from '../../db';
import { enqueueOfferingVerification } from '../../jobs/aiModelDiscoveryWorker';
import { hmacFingerprint } from '../secretCrypto';
import { captureException } from '../sentry';
import { ByoEndpointRejected, validateByoBaseUrl } from './gateway/byoEndpointPolicy';
import { scrubSecrets } from './gateway/scrub';
import { revokeGatewayConnectionGrants } from './gatewayConnectionState';
import { updateGatewayConnectionLocked } from './gatewayConnections';
import * as store from './envOpenAiBootstrapStore';
import { ensurePartnerCutover, REGISTRY_CUTOVER_RETRY_DELAYS_MS } from './registryCutover';
import { safeErrorMessage } from './safeDbError';

export const ENV_CONNECTION_NAME = 'Instance OpenAI-compatible endpoint';

export interface EnvOpenAiSettings {
  baseUrl: string;
  /** null = keyless endpoint. */
  apiKey: string | null;
  model: string;
  inputCentsPerM: number;
  outputCentsPerM: number;
}

export interface EnvBootstrapReport {
  partners: number;
  created: number;
  resynced: number;
  chatRepointed: number;
  /** Env-managed connections released because the variables are unset. */
  released: number;
  failed: string[];
  failures: Array<{ partnerId: string; reason: string }>;
  /** A run-wide failure (base URL refused, hosted), or null. */
  error: string | null;
  verificationEnqueueFailed: number;
}

export function readEnvOpenAiSettings(config: AppConfig = getConfig()): EnvOpenAiSettings | null {
  if (config.MCP_LLM_PROVIDER !== 'openai-compatible') return null;
  const toCents = (usd: number | undefined) => Math.round((usd ?? 0) * 100 * 1e6) / 1e6;
  return {
    baseUrl: (config.MCP_LLM_BASE_URL ?? '').trim().replace(/\/+$/, ''),
    apiKey: config.MCP_LLM_API_KEY?.trim() || null,
    model: (config.MCP_LLM_MODEL ?? '').trim(),
    inputCentsPerM: toCents(config.MCP_LLM_PRICE_INPUT_PER_M_USD),
    outputCentsPerM: toCents(config.MCP_LLM_PRICE_OUTPUT_PER_M_USD),
  };
}

function ratesFor(s: EnvOpenAiSettings): ModelRates {
  return { inputCentsPerM: s.inputCentsPerM, outputCentsPerM: s.outputCentsPerM, cacheReadCentsPerM: s.inputCentsPerM, cacheWriteCentsPerM: 0 };
}

interface PartnerOutcome {
  created: boolean;
  resynced: boolean;
  chatRepointed: boolean;
  verifyOfferingId: string | null;
  /** The URL or key was rewritten: live gateway grants for this connection are revoked after commit. */
  revokeConnectionId: string | null;
}

/** Inside the partner's locked transaction. `baseUrl` is the policy-normalised URL. */
async function syncPartner(partnerId: string, s: EnvOpenAiSettings, baseUrl: string): Promise<PartnerOutcome> {
  const prices = ratesFor(s);
  const conn = await store.findEnvConnection(partnerId);
  if (!conn) {
    const connectionId = await store.insertEnvConnection({ partnerId, name: ENV_CONNECTION_NAME, baseUrl, apiKey: s.apiKey, model: s.model });
    const off = await store.upsertEnvOffering({ partnerId, connectionId, baseUrl, model: s.model, prices, enable: true });
    const chatRepointed = await store.repointChatDefault({ partnerId, to: off.id, from: 'platform' });
    return { created: true, resynced: false, chatRepointed, verifyOfferingId: off.id, revokeConnectionId: null };
  }

  let resynced = false;
  let reverify = false;
  let endpointRewritten = false;
  if (conn.released) {
    await store.readoptEnvConnection(partnerId, conn.id, conn.envModel);
    resynced = true;
  }
  // Fingerprint, not last4: a rotated key can share its last four characters.
  const keyChanged = s.apiKey === null ? conn.keyFingerprint !== null : conn.keyFingerprint !== hmacFingerprint(s.apiKey);
  const urlChanged = conn.baseUrl !== baseUrl;
  if (urlChanged || keyChanged) {
    await updateGatewayConnectionLocked({
      partnerId,
      connectionId: conn.id,
      ...(urlChanged ? { baseUrl } : {}),
      // A new URL always carries the configured key (or keyless): the stored
      // key never follows a connection to a new endpoint.
      ...(keyChanged || urlChanged ? { apiKey: s.apiKey } : {}),
      expectedConfigVersion: conn.configVersion,
      allowManaged: true,
    });
    resynced = reverify = endpointRewritten = true;
  }

  // Codex review #14: track the CONFIGURED model, not "an offering exists",
  // so A -> B -> A moves chat back to A and retires B.
  const modelChanged = conn.envModel !== s.model;
  const off = await store.upsertEnvOffering({ partnerId, connectionId: conn.id, baseUrl, model: s.model, prices, enable: modelChanged });
  let chatRepointed = false;
  if (modelChanged) {
    if (conn.envModel !== null) {
      const oldId = await store.findConnectionOffering(partnerId, conn.id, conn.envModel);
      if (oldId && oldId !== off.id) {
        chatRepointed = await store.repointChatDefault({ partnerId, to: off.id, from: oldId });
        await store.disableOfferingIfUnused(partnerId, oldId);
      }
    }
    await store.setEnvModel(partnerId, conn.id, s.model);
    resynced = reverify = true;
  }
  if (off.created || off.repriced) resynced = true;
  // Anything short of a passing record for the CURRENT endpoint is re-queued:
  // never verified (last boot's enqueue was lost), failed (the endpoint was
  // still loading), or stale (bound to an earlier URL or harness version).
  if (off.created || !off.verified) reverify = true;
  return {
    created: false, resynced, chatRepointed, verifyOfferingId: reverify ? off.id : null,
    revokeConnectionId: endpointRewritten ? conn.id : null,
  };
}

export interface BootstrapEnvOpenAiOptions {
  settings?: EnvOpenAiSettings | null;
  /** Test seam: restrict the run to these partners (default: every partner). */
  partnerIds?: string[];
  /** Test seam: the verification enqueue (default: the BullMQ job, ids only). */
  enqueueVerification?: (input: { offeringId: string; partnerId: string }) => Promise<void>;
}

/**
 * The env path's verification job retries a failed run with a delay: at boot
 * the operator's endpoint is often still loading its model, and the next
 * chance otherwise is the next restart.
 */
const enqueueEnvVerification = (input: { offeringId: string; partnerId: string }): Promise<void> =>
  enqueueOfferingVerification(input, { retryFailed: true });

export async function bootstrapEnvOpenAiConnections(opts: BootstrapEnvOpenAiOptions = {}): Promise<EnvBootstrapReport> {
  const settings = opts.settings === undefined ? readEnvOpenAiSettings() : opts.settings;
  const enqueue = opts.enqueueVerification ?? enqueueEnvVerification;
  const report: EnvBootstrapReport = {
    partners: 0, created: 0, resynced: 0, chatRepointed: 0, released: 0,
    failed: [], failures: [], error: null, verificationEnqueueFailed: 0,
  };
  const secrets = [settings?.apiKey ?? null];
  const reasonOf = (error: unknown) => scrubSecrets(safeErrorMessage(error), secrets);

  if (!settings) {
    // No grant revocation: a release changes no routing field (URL, key and
    // config_version are untouched), so live sessions keep working on it.
    report.released = (await store.releaseEnvManagedConnections()).length;
    if (report.released > 0) {
      console.log(`[envOpenAiBootstrap] MCP_LLM_PROVIDER is not openai-compatible: released ${report.released} env-managed connection(s); nothing deleted, they stay read-only (partners may disconnect them)`);
    }
    return report;
  }
  if (isHosted()) {
    // Config validation already refuses this; never write per-partner rows on hosted.
    report.error = 'MCP_LLM_PROVIDER=openai-compatible is refused on hosted Breeze';
    console.error(`[envOpenAiBootstrap] ${report.error}`);
    return report;
  }

  // DNS-bearing policy check: once, before any partner work, outside every DB context.
  let baseUrl: string | null = null;
  try {
    baseUrl = await runOutsideDbContext(() => validateByoBaseUrl(settings.baseUrl));
  } catch (error) {
    report.error = error instanceof ByoEndpointRejected
      ? `MCP_LLM_BASE_URL refused: ${error.message}`
      : `MCP_LLM_BASE_URL could not be checked: ${reasonOf(error)}`;
  }

  const partnerIds = opts.partnerIds ?? await store.listPartnerIds();
  report.partners = partnerIds.length;
  if (baseUrl === null) {
    report.failed.push(...partnerIds);
    console.error(`[envOpenAiBootstrap] ${report.error} — no partner was bootstrapped`);
    return report;
  }

  const verify: Array<{ offeringId: string; partnerId: string }> = [];
  for (const partnerId of partnerIds) {
    try {
      if (!(await ensurePartnerCutover(partnerId))) throw new Error('AI model registry cutover failed for this partner');
      const outcome = await store.inPartnerEnvLock(partnerId, () => syncPartner(partnerId, settings, baseUrl));
      if (outcome.created) report.created += 1;
      if (outcome.resynced) report.resynced += 1;
      if (outcome.chatRepointed) report.chatRepointed += 1;
      if (outcome.verifyOfferingId) verify.push({ offeringId: outcome.verifyOfferingId, partnerId });
      // Committed: grants issued for the old URL or key must stop dialling.
      if (outcome.revokeConnectionId) await revokeGatewayConnectionGrants(outcome.revokeConnectionId);
    } catch (error) {
      const reason = reasonOf(error);
      report.failed.push(partnerId);
      report.failures.push({ partnerId, reason });
      console.warn(`[envOpenAiBootstrap] partner ${partnerId} failed: ${reason}`);
    }
  }

  // Every partner transaction above has committed (Codex review #10): enqueue now, ids only.
  for (const job of verify) {
    try {
      await enqueue({ offeringId: job.offeringId, partnerId: job.partnerId });
    } catch (error) {
      report.verificationEnqueueFailed += 1;
      console.warn(`[envOpenAiBootstrap] verification enqueue failed for partner ${job.partnerId}: ${reasonOf(error)}`);
    }
  }
  console.log(
    `[envOpenAiBootstrap] partners=${report.partners} created=${report.created} resynced=${report.resynced} `
    + `chatRepointed=${report.chatRepointed} failed=${report.failed.length} verificationEnqueueFailed=${report.verificationEnqueueFailed}`,
  );
  return report;
}

/**
 * Boot entrypoint (index.ts, detached): runs the bootstrap, then re-runs it
 * after each delay while it reports a failure — e.g. the endpoint's hostname
 * not resolving yet while its container starts. Idempotent, so a re-run only
 * finishes what the last one could not.
 */
export async function runEnvOpenAiBootstrapWithRetry(opts: {
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  bootstrap?: () => Promise<EnvBootstrapReport>;
} = {}): Promise<EnvBootstrapReport | null> {
  const delays = opts.retryDelaysMs ?? REGISTRY_CUTOVER_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
  const bootstrap = opts.bootstrap ?? (() => bootstrapEnvOpenAiConnections());
  let last: EnvBootstrapReport | null = null;
  for (let attempt = 0; ; attempt += 1) {
    let ok = false;
    try {
      last = await bootstrap();
      ok = last.error === null && last.failed.length === 0 && last.verificationEnqueueFailed === 0;
    } catch (error) {
      console.error(`[envOpenAiBootstrap] run failed: ${safeErrorMessage(error)}`);
    }
    if (ok) return last;
    const delay = delays[attempt];
    if (delay === undefined) return last;
    console.warn(`[envOpenAiBootstrap] incomplete; retrying in ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }
}

/** How often a running API re-checks for partners created since boot. */
export const ENV_NEW_PARTNER_SYNC_INTERVAL_MS = 10 * 60_000;

/**
 * Partners created after boot get their env connection here, without a
 * restart: the same idempotent per-partner bootstrap, scoped to partners with
 * no live env-managed connection (so a steady state does no partner work and
 * takes no lock). Null when there was nothing to do. Never releases: the
 * variables only change at a restart, and the boot run owns that.
 */
export async function syncEnvOpenAiNewPartners(opts: {
  settings?: EnvOpenAiSettings | null;
} = {}): Promise<EnvBootstrapReport | null> {
  const settings = opts.settings === undefined ? readEnvOpenAiSettings() : opts.settings;
  if (!settings || isHosted()) return null;
  const partnerIds = await store.listPartnerIdsWithoutEnvConnection();
  if (partnerIds.length === 0) return null;
  return bootstrapEnvOpenAiConnections({ settings, partnerIds });
}

/** Starts the new-partner sync on an unref'd interval; a tick is skipped while the previous one runs. Returns a stop function. */
export function startEnvOpenAiNewPartnerSync(opts: {
  run?: () => Promise<EnvBootstrapReport | null>;
  intervalMs?: number;
} = {}): () => void {
  const run = opts.run ?? (() => syncEnvOpenAiNewPartners());
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    run()
      .catch((error: unknown) => {
        console.error(`[envOpenAiBootstrap] new-partner sync failed: ${safeErrorMessage(error)}`);
      })
      .finally(() => { running = false; });
  }, opts.intervalMs ?? ENV_NEW_PARTNER_SYNC_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Fixed text: never a partner id, URL or key. */
export const ENV_BOOTSTRAP_INCOMPLETE_MESSAGE =
  'MCP_LLM_* env bootstrap did not complete after its retries; the API log lists the partners and reasons.';

/**
 * Boot entrypoint (index.ts, detached): the retried bootstrap, one Sentry
 * event if it still ended incomplete, then (variables set, self-hosted) the
 * interval that picks up partners created later.
 */
export async function runEnvOpenAiBootstrapAtBoot(deps: {
  runWithRetry?: () => Promise<EnvBootstrapReport | null>;
  startNewPartnerSync?: () => () => void;
  settings?: EnvOpenAiSettings | null;
} = {}): Promise<void> {
  const report = await (deps.runWithRetry ?? (() => runEnvOpenAiBootstrapWithRetry()))();
  const complete = report !== null
    && report.error === null && report.failed.length === 0 && report.verificationEnqueueFailed === 0;
  if (!complete) {
    captureException(new Error(ENV_BOOTSTRAP_INCOMPLETE_MESSAGE), undefined, { area: 'ai_env_openai_bootstrap' });
  }
  const settings = deps.settings === undefined ? readEnvOpenAiSettings() : deps.settings;
  if (settings && !isHosted()) (deps.startNewPartnerSync ?? (() => startEnvOpenAiNewPartnerSync()))();
}
