/**
 * The `portal-self-registration` worker (portal registration W6, plan D5–D7).
 *
 * One job per public submit. The worker, never the submit handler, decides:
 *   - eligible        → mint a `self_register` link token and email the link;
 *   - existing account → email "you already have an account" (no token);
 *   - ineligible      → nothing is sent and nothing is audited against an org.
 * Every sent email writes `portal.auth.self_register.email_sent` against the
 * matched org (D12), so MSPs see who tried to register.
 *
 * PII: logs carry the domain and org id only, never the address or the name.
 * A send failure is logged and NOT retried (attempts: 1), so a retry can
 * never send a second email.
 */
import { Worker, type Job } from 'bullmq';
import { buildPortalUrl } from '../../routes/portal/helpers';
import { issuePortalSelfRegistrationToken } from '../../routes/portal/capabilityTokens';
import { ANONYMOUS_ACTOR_ID, requestLikeFromSnapshot, writeAuditEventAsync } from '../auditEvents';
import { getEmailService } from '../email';
import { getBullMQConnection } from '../redis';
import { captureException } from '../sentry';
import { attachWorkerObservability } from '../../jobs/workerObservability';
import { emailDomainOf, resolveSelfRegistrationTarget } from './eligibility';
import { reportSelfRegistrationFailure, safeErrorFields, sanitizedError } from './errors';
import { PORTAL_SELF_REGISTRATION_QUEUE, type PortalSelfRegistrationJobData, type SelfRegistrationTarget } from './types';

export type PortalSelfRegistrationJobResult = 'link_sent' | 'existing_account_sent' | 'ineligible' | 'not_sent';

const LOG = '[portal-self-registration]';
const WORKER_CONCURRENCY = 5;

/** The portal page that consumes the link. The token rides in the FRAGMENT (D9): never sent to a server. */
export function buildSelfRegistrationVerifyUrl(rawToken: string): string {
  return `${buildPortalUrl('/request-access/verify')}#token=${encodeURIComponent(rawToken)}`;
}

async function auditEmailSent(
  email: string,
  target: Extract<SelfRegistrationTarget, { kind: 'eligible' | 'existing_account' }>,
  kind: 'verify_link' | 'existing_account',
): Promise<void> {
  await writeAuditEventAsync(requestLikeFromSnapshot({}), {
    orgId: target.orgId,
    actorType: 'system',
    actorId: ANONYMOUS_ACTOR_ID,
    actorEmail: email,
    initiatedBy: 'manual',
    action: 'portal.auth.self_register.email_sent',
    resourceType: 'portal_auth',
    result: 'success',
    details: { kind, domain: target.domain, mode: target.mode },
  });
}

export async function processPortalSelfRegistration(data: PortalSelfRegistrationJobData): Promise<PortalSelfRegistrationJobResult> {
  const email = data.email.trim().toLowerCase();
  const target = await resolveSelfRegistrationTarget({ email, host: data.host });

  if (target.kind === 'ineligible') {
    console.debug(`${LOG} ineligible`, { reason: target.reason, domain: emailDomainOf(email) });
    return 'ineligible';
  }

  const emailService = getEmailService();
  if (!emailService) {
    console.warn(`${LOG} email service not configured; nothing sent`, { orgId: target.orgId, domain: target.domain });
    reportSelfRegistrationFailure('not sent: email_unconfigured');
    return 'not_sent';
  }

  if (target.kind === 'existing_account') {
    try {
      await emailService.sendPortalSelfRegistrationExistingAccount({
        to: email,
        loginUrl: buildPortalUrl('/login'),
        forgotPasswordUrl: buildPortalUrl('/forgot-password'),
        orgName: target.orgName,
        partnerId: target.partnerId,
        partnerName: target.partnerName,
      });
    } catch (err) {
      console.error(`${LOG} existing-account email failed`, { orgId: target.orgId, domain: target.domain, ...safeErrorFields(err) });
      reportSelfRegistrationFailure('not sent: email_send_failed', err);
      return 'not_sent';
    }
    await auditEmailSent(email, target, 'existing_account');
    return 'existing_account_sent';
  }

  const rawToken = await issuePortalSelfRegistrationToken({
    orgId: target.orgId,
    email,
    name: data.name,
    domain: target.domain,
    policyFingerprint: target.policyFingerprint,
  });
  if (!rawToken) {
    console.error(`${LOG} link token not issued (state backend unavailable)`, { orgId: target.orgId, domain: target.domain });
    reportSelfRegistrationFailure('not sent: token_store_unavailable');
    return 'not_sent';
  }
  try {
    await emailService.sendPortalSelfRegistrationLink({
      to: email,
      verifyUrl: buildSelfRegistrationVerifyUrl(rawToken),
      orgName: target.orgName,
      partnerId: target.partnerId,
      partnerName: target.partnerName,
    });
  } catch (err) {
    console.error(`${LOG} verify email failed`, { orgId: target.orgId, domain: target.domain, ...safeErrorFields(err) });
    reportSelfRegistrationFailure('not sent: email_send_failed', err);
    return 'not_sent';
  }
  await auditEmailSent(email, target, 'verify_link');
  return 'link_sent';
}

/** The error BullMQ, the shared failure listener and Sentry see: class name only, no message, no cause. */
export function sanitizedJobError(err: unknown): Error {
  return sanitizedError('job failed', err);
}

/**
 * A job older than the link lifetime is dropped unsent: its requester has
 * long since been told "we've emailed you", and a waiting job's address and
 * name should not sit in Redis while the consumer is down.
 */
export const PORTAL_SELF_REGISTRATION_JOB_MAX_AGE_MS = 30 * 60 * 1000;

export async function processPortalSelfRegistrationJob(
  job: Pick<Job<PortalSelfRegistrationJobData>, 'data' | 'timestamp'>,
  now: number = Date.now(),
): Promise<PortalSelfRegistrationJobResult> {
  if (now - job.timestamp > PORTAL_SELF_REGISTRATION_JOB_MAX_AGE_MS) {
    console.warn(`${LOG} stale job dropped unsent`, { ageMs: now - job.timestamp });
    reportSelfRegistrationFailure('not sent: stale_job');
    return 'not_sent';
  }
  try {
    return await processPortalSelfRegistration(job.data);
  } catch (err) {
    // Sanitize BEFORE BullMQ and the shared observability listener see it: a
    // failed query's message embeds its parameters (the address).
    throw sanitizedJobError(err);
  }
}

let worker: Worker<PortalSelfRegistrationJobData> | null = null;

export async function initializePortalSelfRegistrationWorker(): Promise<void> {
  worker = new Worker<PortalSelfRegistrationJobData>(
    PORTAL_SELF_REGISTRATION_QUEUE,
    async (job: Job<PortalSelfRegistrationJobData>) => processPortalSelfRegistrationJob(job),
    // A stalled job (worker crash mid-send) is failed, never re-run: a re-run
    // could send a second email.
    { connection: getBullMQConnection(), concurrency: WORKER_CONCURRENCY, maxStalledCount: 0 },
  );
  attachWorkerObservability(worker, 'portalSelfRegistrationWorker');
  worker.on('error', (error) => {
    // A connection-level error carries no job data.
    console.error(`${LOG} worker error:`, error);
    captureException(error);
  });
  // Failures are logged and reported by attachWorkerObservability, which only
  // ever sees the sanitized error thrown above.
  console.log(`${LOG} worker initialized`);
}

export async function shutdownPortalSelfRegistrationWorker(): Promise<void> {
  if (worker) {
    const w = worker;
    worker = null;
    await w.close();
  }
}
