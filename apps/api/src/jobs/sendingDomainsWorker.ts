import { Job, Queue, Worker } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { isHosted } from '../config/env';
import { db, withSystemDbAccessContext } from '../db';
import { emailProviderDomainReleases, partnerSenderIdentities, partnerSendingDomains, users } from '../db/schema';
import { getEmailDomainsConfig, isPartnerLaneConfigured } from '../services/emailDomains/config';
import { markStaticDomainVerified, syncSendingDomain } from '../services/emailDomains/domainSync';
import { recordProviderKeyProbe } from '../services/emailDomains/keyProbe';
import { getEmailDomainProvider } from '../services/emailDomains/providerRegistry';
import { sendOpsAlert } from '../services/opsAlerts';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

/**
 * The ONE place that talks to the email-domain provider (spec §2). Request
 * handlers only write intent rows and enqueue here, so provider outages, the
 * account's 10 req/s ceiling and retry/backoff are handled once, and no route
 * ever needs SELF_MANAGED_DB_CONTEXT_ROUTES.
 *
 * Registration is conditional: with EMAIL_DOMAINS_PROVIDER unset (the default,
 * and the state hosted ships in until W05) nothing is constructed and nothing
 * is scheduled — the same enable-check shape as initializeAbuseSignalsWorker
 * (jobs/abuseSignalsSweep.ts:149). The readiness manifest carries a matching
 * 'sending_domains_configured' rule so an unconfigured box is not pinned
 * not-ready waiting for a consumer that will never attach.
 */
export const SENDING_DOMAINS_QUEUE = 'sending-domains';

const SWEEP_JOB = 'sweep';
const SYNC_JOB = 'sync-domain';
const TEST_SEND_JOB = 'test-send';
const DAILY_JOB = 'daily-maintenance';
const SWEEP_REPEAT_ID = 'sending-domains-sweep-repeat';
const DAILY_REPEAT_ID = 'sending-domains-daily-repeat';

// Declared in THIS file on purpose: scheduleRegistry.contract.test.ts resolves
// `repeat: { every }` operands only through same-file const declarations, and an
// imported constant reads as UNRESOLVED and fails the suite.
const SWEEP_INTERVAL_MS = 60_000;
const DAILY_CRON = jobSchedule('sending-domains-daily');

/** Rows claimed per sweep. Deliberately small: each one becomes a provider call. */
const SWEEP_BATCH = 25;
/** Outbox rows past this many attempts are alerted and left alone (spec §3.3). */
const MAX_RELEASE_ATTEMPTS = 10;
/** A provider domain younger than this is not drift — it may be mid-provision (spec §6.4). */
const DRIFT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

type SendingDomainsJobData =
  | { domainId: string; lastSendError?: string }
  | { domainId: string; userId: string }
  | Record<string, never>;

let queue: Queue<SendingDomainsJobData> | null = null;
let worker: Worker<SendingDomainsJobData> | null = null;

function getQueue(): Queue<SendingDomainsJobData> {
  if (!queue) {
    queue = new Queue<SendingDomainsJobData>(SENDING_DOMAINS_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

function extractRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

// ---------------------------------------------------------------------------
// Producers. Callable from a route; both no-op when the lane is unconfigured so
// a route that somehow reached them on a dark instance cannot queue orphan work.
// ---------------------------------------------------------------------------

/**
 * `jobId = domainId` so a burst of route calls and sweep claims for the same
 * row collapses into one in-flight job rather than N concurrent provider calls
 * against the same domain.
 */
export async function enqueueSyncDomain(domainId: string, opts: { lastSendError?: string } = {}): Promise<void> {
  if (!isPartnerLaneConfigured()) return;
  await getQueue().add(
    SYNC_JOB,
    opts.lastSendError ? { domainId, lastSendError: opts.lastSendError } : { domainId },
    { jobId: domainId, attempts: 5, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: { count: 50 }, removeOnFail: { count: 200 } },
  );
}

export async function enqueueTestSend(domainId: string, userId: string): Promise<void> {
  if (!isPartnerLaneConfigured()) return;
  await getQueue().add(
    TEST_SEND_JOB,
    { domainId, userId },
    { attempts: 2, backoff: { type: 'fixed', delay: 15_000 }, removeOnComplete: { count: 50 }, removeOnFail: { count: 100 } },
  );
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/**
 * One sweep pass, in the three-phase shape of jobs/ticketOutboxPublisher.ts:
 * claim inside a short system transaction, then do the Redis/provider work with
 * NO context held, then write back in a second short transaction.
 */
export async function runSendingDomainsSweep(now: Date = new Date()): Promise<{ enqueued: number; released: number; stuck: number }> {
  const provider = getEmailDomainProvider();
  if (!provider) return { enqueued: 0, released: 0, stuck: 0 };

  // Phase 1: claim due rows. FOR UPDATE SKIP LOCKED so two replicas sweeping the
  // same second take disjoint sets instead of duplicating every provider call.
  const due = await withSystemDbAccessContext(async () => {
    const result = await db.execute<{ id: string }>(sql`
      select id
      from ${partnerSendingDomains}
      where ${partnerSendingDomains.nextCheckAt} <= ${now.toISOString()}::timestamptz
        and ${partnerSendingDomains.status} <> 'suspended'
      order by ${partnerSendingDomains.nextCheckAt} asc
      limit ${SWEEP_BATCH}
      for update skip locked
    `);
    return extractRows<{ id: string }>(result);
  }, 'sendingDomainsSweepClaim');

  // Phase 2: Redis only, outside any DB context.
  let enqueued = 0;
  for (const row of due) {
    try {
      await enqueueSyncDomain(row.id);
      enqueued += 1;
    } catch (err) {
      console.error(`[SendingDomains] enqueue failed for ${row.id}:`, err instanceof Error ? err.message : err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  const { released, stuck } = await drainReleaseOutbox(provider, now);
  return { enqueued, released, stuck };
}

/**
 * Drain `email_provider_domain_releases` (spec §3.3). These rows exist because
 * `cascadeDeletePartner` erases every table with a `partner_id` column: the
 * outbox has none, so it survives the partner and still knows which provider
 * object to release. Rows are only ever written for `provider_managed` domains,
 * so anything in here is by construction ours to delete.
 */
async function drainReleaseOutbox(
  provider: NonNullable<ReturnType<typeof getEmailDomainProvider>>,
  now: Date,
): Promise<{ released: number; stuck: number }> {
  const rows = await withSystemDbAccessContext(async () => {
    const result = await db.execute<{ id: string; provider: string; provider_domain_id: string; attempts: number }>(sql`
      select id, provider, provider_domain_id, attempts
      from ${emailProviderDomainReleases}
      -- next_attempt_at is NOT NULL DEFAULT now() in W02's schema, so a
      -- freshly written row is due immediately and no IS NULL arm is needed.
      where ${emailProviderDomainReleases.nextAttemptAt} <= ${now.toISOString()}::timestamptz
      order by ${emailProviderDomainReleases.requestedAt} asc
      limit ${SWEEP_BATCH}
      for update skip locked
    `);
    return extractRows<{ id: string; provider: string; provider_domain_id: string; attempts: number }>(result);
  }, 'sendingDomainsOutboxClaim');

  let released = 0;
  let stuck = 0;
  for (const row of rows) {
    if (row.attempts >= MAX_RELEASE_ATTEMPTS) {
      stuck += 1;
      await sendOpsAlert({
        title: 'Sending domain release stuck',
        body: `Provider ${row.provider} domain ${row.provider_domain_id} has failed ${row.attempts} release attempts. It is still held at the provider. Release it by hand and delete email_provider_domain_releases row ${row.id}.`,
      });
      continue;
    }
    if (row.provider !== provider.id) {
      // A row left by a different configured provider. Alert rather than guess:
      // deleting the wrong provider's domain is unrecoverable.
      stuck += 1;
      await sendOpsAlert({
        title: 'Sending domain release for another provider',
        body: `email_provider_domain_releases row ${row.id} names provider ${row.provider}, but this instance runs ${provider.id}. Not attempted.`,
      });
      continue;
    }
    try {
      await provider.deleteDomain(row.provider_domain_id);   // 404 is success per the adapter contract
      await withSystemDbAccessContext(
        () => db.delete(emailProviderDomainReleases).where(eq(emailProviderDomainReleases.id, row.id)),
        'sendingDomainsOutboxDelete',
      );
      released += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = row.attempts + 1;
      const backoffMs = Math.min(60 * 60 * 1000, 30_000 * 2 ** attempts);
      await withSystemDbAccessContext(
        () => db.update(emailProviderDomainReleases)
          .set({ attempts, nextAttemptAt: new Date(now.getTime() + backoffMs), lastError: message.slice(0, 2000) })
          .where(eq(emailProviderDomainReleases.id, row.id)),
        'sendingDomainsOutboxBackoff',
      );
    }
  }
  return { released, stuck };
}

// ---------------------------------------------------------------------------
// Test send (spec §6.1, §7)
// ---------------------------------------------------------------------------

/**
 * Calls the adapter's `send` DIRECTLY, bypassing resolveSender, so a domain can
 * be tested before any identity exists. From is the support identity's local
 * part when one is configured, else `test`; To is always the requesting user's
 * own address, never a typed one.
 *
 * On `static` this is the verification step itself: the relay accepting the
 * message is the only proof Breeze can obtain that it may send as the domain,
 * so acceptance moves a `pending` row to `verified` (spec §5.1).
 *
 * NOTE (W03): the daily partner-lane cap of spec §6.1 is NOT counted here —
 * `tryCountPartnerLaneSend` ships in W04. Until then the only bound is the
 * route's 5/h/partner limit. W04 adds the call.
 */
export async function runTestSend(domainId: string, userId: string): Promise<'sent' | 'refused' | 'skipped'> {
  const provider = getEmailDomainProvider();
  if (!provider) return 'skipped';

  const context = await withSystemDbAccessContext(async () => {
    const found = await db
      .select()
      .from(partnerSendingDomains)
      .where(eq(partnerSendingDomains.id, domainId))
      .limit(1);
    const domain = found[0];
    if (!domain) return null;
    const recipient = await db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.partnerId, domain.partnerId), eq(users.status, 'active')))
      .limit(1);
    const support = await db
      .select({ localPart: partnerSenderIdentities.localPart })
      .from(partnerSenderIdentities)
      .where(and(
        eq(partnerSenderIdentities.sendingDomainId, domainId),
        eq(partnerSenderIdentities.stream, 'support'),
      ))
      .limit(1);
    return { domain, to: recipient[0]?.email ?? null, localPart: support[0]?.localPart ?? 'test' };
  }, 'sendingDomainTestSendLoad');

  if (!context || !context.to) return 'skipped';
  const { domain, to, localPart } = context;

  const sendable = domain.status === 'verified' || domain.status === 'at_risk'
    || (domain.status === 'pending' && !provider.verifiesByDns);
  if (!sendable) return 'skipped';

  const from = `${localPart}@${domain.domain}`;
  try {
    await provider.send({
      from,
      to,
      subject: `Breeze test message from ${domain.domain}`,
      html: `<p>This is a test message sent from <strong>${from}</strong> to confirm Breeze can send as this domain.</p>`,
      text: `This is a test message sent from ${from} to confirm Breeze can send as this domain.`,
      partnerRef: domain.partnerId,
      tags: {
        partner_id: domain.partnerId,
        domain_id: domain.id,
        stream: 'support',
        purpose: 'sending_domain.test',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withSystemDbAccessContext(
      () => db.update(partnerSendingDomains)
        .set({ lastTestAt: new Date(), lastTestStatus: 'failed', lastTestError: message.slice(0, 2000), updatedAt: sql`now()` })
        .where(eq(partnerSendingDomains.id, domainId)),
      'sendingDomainTestSendFailed',
    );
    return 'refused';
  }

  await withSystemDbAccessContext(
    () => db.update(partnerSendingDomains)
      .set({ lastTestAt: new Date(), lastTestStatus: 'sent', lastTestError: null, updatedAt: sql`now()` })
      .where(eq(partnerSendingDomains.id, domainId)),
    'sendingDomainTestSendPassed',
  );

  // `static` only: an accepted test send IS the verification (spec §5.1). This
  // must NOT be an enqueued sync — `syncSendingDomain` deliberately treats a
  // `static` adapter's `pending` as no change (W02 amendment 5), so a sync
  // would leave the row pending forever. The transition is made here, with its
  // audit row and its status mail.
  if (!provider.verifiesByDns && domain.status === 'pending') {
    await markStaticDomainVerified(domainId);
  }
  return 'sent';
}

// ---------------------------------------------------------------------------
// Daily maintenance: hosted drift report + static delist re-check (spec §6.4)
// ---------------------------------------------------------------------------

export async function runDailyMaintenance(now: Date = new Date()): Promise<{ drift: number; rechecked: number }> {
  const provider = getEmailDomainProvider();
  if (!provider) return { drift: 0, rechecked: 0 };

  let drift = 0;
  if (isHosted()) {
    // Hosted only: the partner-lane account is dedicated to this instance, so a
    // provider domain with no local row and no outbox row is a real leak. On
    // self-hosted the account is the operator's own and holds domains Breeze
    // knows nothing about, which would make this pure noise.
    try {
      const remote = await provider.listDomains();
      await recordProviderKeyProbe('ok');
      const known = await withSystemDbAccessContext(async () => {
        const result = await db.execute<{ provider_domain_id: string }>(sql`
          select provider_domain_id from ${partnerSendingDomains} where provider_domain_id is not null
          union
          select provider_domain_id from ${emailProviderDomainReleases}
        `);
        return new Set(extractRows<{ provider_domain_id: string }>(result).map((r) => r.provider_domain_id));
      }, 'sendingDomainsDriftKnown');

      // `listDomains()` returns only { providerDomainId, domain } (W02 pins the
      // interface), so the age each candidate is judged on comes from a second
      // call. That is affordable precisely because it is made ONLY for domains
      // we cannot account for: in a healthy account that list is empty, and a
      // non-empty one is an incident, not a routine cost.
      const candidates = remote.filter((d) => !known.has(d.providerDomainId));
      const unknown: Array<{ providerDomainId: string; domain: string }> = [];
      for (const candidate of candidates) {
        let createdAt: Date | undefined;
        try {
          createdAt = (await provider.findDomainByName(candidate.domain))?.createdAt;
        } catch {
          // Treat an unreadable candidate as reportable: silence here is the
          // failure mode this report exists to prevent.
        }
        // Spec §6.4 alerts only past 24 h, so a domain mid-provision is not
        // flagged. No creation time means we cannot tell a leak from a
        // just-created object — report it rather than suppress it.
        if (!createdAt || now.getTime() - createdAt.getTime() > DRIFT_MIN_AGE_MS) {
          unknown.push(candidate);
        }
      }
      drift = unknown.length;
      if (drift > 0) {
        // NOTHING is deleted here, ever. Drift is reported and repaired by a
        // human (spec §2, §6.4).
        await sendOpsAlert({
          title: `Sending-domain drift: ${drift} provider domain(s) with no Breeze row`,
          body: unknown.map((d) => `${d.domain} (${d.providerDomainId})`).join('\n'),
        });
      }
    } catch (err) {
      await recordProviderKeyProbe('send_only');
      console.warn('[SendingDomains] drift report could not list domains:', err instanceof Error ? err.message : err);
    }
  }

  let rechecked = 0;
  if (!provider.verifiesByDns) {
    // `static`: getDomain is a local lookup against EMAIL_DOMAINS_STATIC_ALLOWED,
    // so re-running it is how a domain the operator delisted stops being used
    // (spec §5.1, §13). Enqueue rather than sync inline so the limiter applies.
    const rows = await withSystemDbAccessContext(async () => {
      const result = await db.execute<{ id: string }>(sql`
        select id from ${partnerSendingDomains}
        where ${partnerSendingDomains.status} in ('pending', 'verified', 'at_risk')
      `);
      return extractRows<{ id: string }>(result);
    }, 'sendingDomainsStaticRecheck');
    for (const row of rows) {
      await enqueueSyncDomain(row.id);
      rechecked += 1;
    }
  }

  return { drift, rechecked };
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

function createSendingDomainsWorker(): Worker<SendingDomainsJobData> {
  return new Worker<SendingDomainsJobData>(
    SENDING_DOMAINS_QUEUE,
    async (job: Job<SendingDomainsJobData>) => {
      switch (job.name) {
        case SYNC_JOB: {
          const data = job.data as { domainId: string; lastSendError?: string };
          return syncSendingDomain(data.domainId, { lastSendError: data.lastSendError });
        }
        case SWEEP_JOB:
          return runSendingDomainsSweep();
        case TEST_SEND_JOB: {
          const data = job.data as { domainId: string; userId: string };
          return runTestSend(data.domainId, data.userId);
        }
        case DAILY_JOB:
          return runDailyMaintenance();
        default:
          console.warn(`[SendingDomains] unknown job name: ${job.name}`);
          return null;
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
      // 5 management calls a second leaves headroom under the account's 10 req/s
      // for the partner-lane SENDS that share it (spec §6).
      limiter: { max: 5, duration: 1000 },
    },
  );
}

async function scheduleRepeatables(): Promise<void> {
  const q = getQueue();
  for (const job of await q.getRepeatableJobs()) {
    if (job.name === SWEEP_JOB || job.name === DAILY_JOB) {
      await q.removeRepeatableByKey(job.key);
    }
  }
  await q.add(SWEEP_JOB, {}, {
    jobId: SWEEP_REPEAT_ID,
    repeat: { every: SWEEP_INTERVAL_MS },
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 100 },
  });
  await q.add(DAILY_JOB, {}, {
    jobId: DAILY_REPEAT_ID,
    repeat: { pattern: DAILY_CRON },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 20 },
  });
  // One un-repeated run at boot: the `static` re-check has to happen on start,
  // not only at 21:03 (spec §6.1). Harmless on hosted — the drift report is
  // read-only.
  await q.add(DAILY_JOB, {}, { removeOnComplete: true, removeOnFail: { count: 10 } });
}

/**
 * Probe the management key once (spec §5.1). A `sending_access` key can send
 * but cannot manage domains; degrading the capability to an explained
 * "unavailable" is far better than failing every add-domain request with a
 * provider error the partner cannot act on.
 */
async function probeManagementKey(): Promise<void> {
  const provider = getEmailDomainProvider();
  if (!provider) return;
  try {
    await provider.listDomains();
    await recordProviderKeyProbe('ok');
  } catch (err) {
    console.warn('[SendingDomains] management key probe failed — treating the key as send-only:', err instanceof Error ? err.message : err);
    await recordProviderKeyProbe('send_only');
  }
}

export async function initializeSendingDomainsWorker(): Promise<void> {
  if (worker) return;
  if (!isPartnerLaneConfigured()) {
    // The default. Nothing is constructed and nothing is scheduled, and the
    // readiness manifest's 'sending_domains_configured' rule declares this
    // consumer optional-disabled so /ready is unaffected.
    console.log(`[SendingDomains] Disabled (EMAIL_DOMAINS_PROVIDER unset) — worker not registered`);
    return;
  }

  worker = createSendingDomainsWorker();
  attachWorkerObservability(worker, 'sendingDomainsWorker');
  worker.on('error', (error) => {
    console.error('[SendingDomains] Worker error:', error);
    captureException(error);
  });
  worker.on('failed', (job, error) => {
    console.error(`[SendingDomains] Job ${job?.id} (${job?.name}) failed:`, error);
    captureException(error);
  });

  try {
    await scheduleRepeatables();
    await probeManagementKey();
  } catch (err) {
    await worker.close();
    worker = null;
    throw err;
  }

  console.log(`[SendingDomains] Worker initialized (provider=${getEmailDomainsConfig().provider})`);
}

export async function shutdownSendingDomainsWorker(): Promise<void> {
  const w = worker;
  const q = queue;
  worker = null;
  queue = null;
  if (w) {
    try { await w.close(); } catch (err) { console.error('[SendingDomains] Error closing worker:', err); }
  }
  if (q) {
    try { await q.close(); } catch (err) { console.error('[SendingDomains] Error closing queue:', err); }
  }
}
