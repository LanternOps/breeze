import { sql } from 'drizzle-orm';
import * as dbModule from '../../db';
import { sendOpsAlert, isOpsAlertingConfigured } from '../opsAlerts';
import { recordAbuseSignalFired } from '../abuseMetrics';
import { loadSignalConfig } from './config';
import { computeInvariantSignals } from './invariants';
import { loadPartnerAggregates, computeHeuristicSignals, loadHostnameIndicators } from './heuristics';
import { loadScriptFindings, computeScriptSignals, loadScriptIndicators } from './scriptContent';
import { loadBillingIdentityAggregates, computeBillingIdentitySignals } from './billingIdentity';
import { syncEndpointFingerprints, loadRecidivistMatches, computeRecidivistSignals } from './recidivistEndpoint';
import { loadOriginIpAggregates, computeOriginIpSignals } from './originIp';
import { computeCorroborationSignals } from './corroboration';
import { persistSignals, markDelivered } from './persistence';
import type { ComputedSignal } from './types';

const { db } = dbModule;

// #1105: hold the system DB context only around DB work; alert delivery
// (network) happens outside it.
const runSystemDbCompute = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  const runOutside = dbModule.runOutsideDbContext;
  if (typeof withSystem !== 'function' || typeof runOutside !== 'function') {
    // Never legitimate in production: running without the system context would
    // silently read 0 rows under forced RLS and report a "healthy" empty sweep.
    throw new Error('[AbuseSignals] db context helpers missing — refusing to run sweep without system context');
  }
  return runOutside(() => withSystem(fn));
};

// Ordering matters: opsAlerts.formatContent truncates the final message to
// Discord's 2000-char limit, and the evidence JSON below is itself capped at
// 800 chars — but neither cap should ever be able to cut off the actionable
// line (full partner id + playbook pointer). Keep those BEFORE evidence.
function formatSignalAlert(s: ComputedSignal & { rowId: string }): { title: string; body: string } {
  const shortId = s.partnerId.slice(0, 8);
  return {
    title: `Abuse signal: ${s.signalKey} (${s.severity})`,
    body: [
      `Partner: ${String(s.evidence.partnerName ?? 'unknown')} (${shortId})`,
      `Score: ${s.score}`,
      `Partner id: ${s.partnerId}`,
      `Review: docs/superpowers/specs/security-auth/2026-07-11-signup-abuse-detection-design.md — suspend playbook applies`,
      `Evidence: ${JSON.stringify(s.evidence).slice(0, 800)}`,
    ].join('\n'),
  };
}

export async function runAbuseSweep(): Promise<{ fired: number; notified: number }> {
  const cfg = loadSignalConfig();
  const now = new Date();

  const { invariants, aggregates, scriptFindings, billingIdentity, recidivist, originIp } = await runSystemDbCompute(
    async () => {
      // syncEndpointFingerprints refreshes the corpus before the correlation
      // read below runs, same ordering scriptContent uses for its own scan.
      await syncEndpointFingerprints(now);
      return {
        invariants: await computeInvariantSignals(),
        aggregates: await loadPartnerAggregates(),
        scriptFindings: await loadScriptFindings(now),
        billingIdentity: await loadBillingIdentityAggregates(),
        recidivist: await loadRecidivistMatches(),
        originIp: await loadOriginIpAggregates(),
      };
    },
  );

  const computed = [
    ...invariants,
    ...computeHeuristicSignals(aggregates, cfg, now, loadHostnameIndicators()),
    // Content-based signals are never age-decayed (computeScriptSignals takes
    // no partner age at all) — a malicious installer is malicious regardless
    // of account age.
    ...computeScriptSignals(scriptFindings.findings, scriptFindings.sharedHosts, cfg, loadScriptIndicators()),
    // Identity signals are likewise never age-decayed — a cardholder name that
    // matches nothing about the account is evidence at any account age. The
    // scorer takes no clock at all; card-testing is scored on the span the
    // billing service recorded, not on how recently the sweep ran.
    ...computeBillingIdentitySignals(billingIdentity.aggregates, billingIdentity.sharedFingerprints, cfg),
    // Recidivist-endpoint signals are likewise never age-decayed —
    // computeRecidivistSignals takes no clock and no partner age at all; a
    // re-established aged account matching a suspended partner's fingerprint
    // is more suspicious, not less (see the scorer's own header comment).
    ...computeRecidivistSignals(recidivist.matches, cfg),
    // Origin-IP recidivism is likewise never age-decayed — a pre-positioned
    // account sits dormant for weeks by design, so weighting it by account age
    // would silence it exactly when it matures into a live operator.
    ...computeOriginIpSignals(originIp.aggregates, originIp.corpus, cfg, now),
  ];
  // Corroboration runs LAST and reads only what the detectors above produced —
  // no extra queries. It promotes a partner whose evidence spans two or more
  // independent axes, which is the mechanism the capped watch scores in
  // config.ts have always assumed. Deliberately not added to
  // evaluatedPartnerIds below: every partner it can fire on already got there
  // via the detector that produced the underlying watch signal, and widening
  // that set would change stale-resolution for OTHER signals on that partner.
  computed.push(...computeCorroborationSignals(computed, cfg));
  // Script-scanned and billing-scanned partners join the evaluated set so open
  // rows for those detectors stale-resolve when the evidence disappears
  // (script edited/deleted, cardholder name corrected). persistSignals only
  // auto-resolves `invariant.*` rows or rows whose partner is in this set.
  const evaluatedPartnerIds = new Set([
    ...aggregates.map((a) => a.partnerId),
    ...scriptFindings.scannedPartnerIds,
    ...billingIdentity.scannedPartnerIds,
    ...recidivist.scannedPartnerIds,
    ...originIp.scannedPartnerIds,
  ]);
  const { toNotify } = await runSystemDbCompute(() => persistSignals(computed, now, evaluatedPartnerIds));

  for (const s of computed) recordAbuseSignalFired(s.severity);

  const deliveredIds: string[] = [];
  for (const n of toNotify) {
    if (await sendOpsAlert(formatSignalAlert(n))) deliveredIds.push(n.rowId);
  }
  if (deliveredIds.length > 0) {
    await runSystemDbCompute(() => markDelivered(deliveredIds, new Date()));
  }

  return { fired: computed.length, notified: deliveredIds.length };
}

export async function runAbuseDigest(): Promise<void> {
  if (!isOpsAlertingConfigured()) {
    console.warn('[AbuseSignals] Digest skipped — ops alerting not configured');
    return;
  }

  const stats = await runSystemDbCompute(async () => {
    const openBySeverity = (await db.execute(sql`
      SELECT severity, COUNT(*) AS count FROM partner_abuse_signals
      WHERE resolved_at IS NULL AND acknowledged_at IS NULL
      GROUP BY severity
    `)) as unknown as Array<{ severity: string; count: string }>;
    const watchRows = (await db.execute(sql`
      SELECT s.signal_key, s.score, p.name
      FROM partner_abuse_signals s JOIN partners p ON p.id = s.partner_id
      WHERE s.resolved_at IS NULL AND s.acknowledged_at IS NULL AND s.severity = 'watch'
      ORDER BY s.score DESC LIMIT 20
    `)) as unknown as Array<{ signal_key: string; score: number; name: string }>;
    const newPartners = (await db.execute(sql`
      SELECT COUNT(*) AS count FROM partners WHERE created_at > now() - interval '7 days' AND deleted_at IS NULL
    `)) as unknown as Array<{ count: string }>;
    return { openBySeverity, watchRows, newPartnerCount: Number(newPartners[0]?.count ?? 0) };
  });

  const severityLine = stats.openBySeverity.map((r) => `${r.severity}: ${r.count}`).join(', ') || 'none open';
  const watchLines = stats.watchRows.map((r) => `- ${r.name}: ${r.signal_key} (score ${r.score})`).join('\n');
  const delivered = await sendOpsAlert({
    title: 'Weekly abuse-signals digest',
    body: [
      `New partners this week: ${stats.newPartnerCount}`,
      `Open unacknowledged signals — ${severityLine}`,
      watchLines ? `Watch tier:\n${watchLines}` : 'Watch tier: empty',
      'Invariants checked hourly all week (any breach would have alerted immediately).',
    ].join('\n'),
  });
  if (!delivered) {
    throw new Error('[AbuseSignals] Weekly digest delivery failed');
  }
}
