import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PresenceSiteRef, PresenceSuggestion } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';
import { formatDate } from '../../lib/dateTimeFormat';

/**
 * Wrong-site suggestion for one device (topology site location W3, spec S§10.3, S§11). Shown on the assigned site's
 * roster entry and on the suggested site's visitor. It is a SUGGESTION: Breeze never moves a device by itself.
 *  - "Move to <B>": an explicit, confirmed, audited move through PATCH /devices/:id with the expected source site
 *    (409 if someone else moved it first) and siteMoveTrigger 'topology_suggestion'; the server derives the evidence.
 *  - "Keep at <A>": records the confirmation (PUT …/site-assignment-confirmation); nothing moves.
 *  - Confirmed device: "Suggestions off" with "Turn on" (DELETE).
 * Both actions need devices:write (`canMove`); the routes re-check it, MFA and both sites. Every mutation goes through
 * runAction. The API only sends a suggestion the viewer may see (both sites), so this never names a hidden site.
 * Copy never says "always" or "away" (S§10.3).
 */
export type SiteMoveSuggestionProps = {
  deviceId: string;
  deviceName: string;
  /** The device's current (assigned) site, A. */
  assignedSite: PresenceSiteRef;
  /** The network the device reports on B, for the evidence line. */
  prefix: string | null;
  suggestion: PresenceSuggestion | null;
  confirmedAt: string | null;
  canMove: boolean;
  /** Called after a successful move, dismissal or "Turn on" so the caller refetches presence. */
  onChanged: () => void;
};

const devicePath = (deviceId: string) => `/devices/${encodeURIComponent(deviceId)}`;

export function moveDeviceToSuggestedSite(input: { deviceId: string; fromSiteId: string; toSiteId: string; errorFallback: string; successMessage: string; siteChanged: string }) {
  return runAction({
    request: () => fetchWithAuth(devicePath(input.deviceId), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: input.toSiteId, expectedSiteId: input.fromSiteId, siteMoveTrigger: 'topology_suggestion' }),
    }),
    errorFallback: input.errorFallback, successMessage: input.successMessage,
    friendly: (code) => (code === 'device_site_changed' ? input.siteChanged : undefined),
  });
}

export function setSiteAssignmentConfirmation(input: { deviceId: string; confirmed: boolean; errorFallback: string; successMessage: string; siteChanged: string }) {
  return runAction({
    request: () => fetchWithAuth(`${devicePath(input.deviceId)}/site-assignment-confirmation`, { method: input.confirmed ? 'PUT' : 'DELETE' }),
    errorFallback: input.errorFallback, successMessage: input.successMessage,
    friendly: (code) => (code === 'device_site_changed' ? input.siteChanged : undefined),
  });
}

export default function SiteMoveSuggestion({ deviceId, deviceName, assignedSite, prefix, suggestion, confirmedAt, canMove, onChanged }: SiteMoveSuggestionProps) {
  const { t } = useTranslation('topology');
  const [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false), [moved, setMoved] = useState(false);
  const titleId = useId(), confirmId = useId();
  const siteChanged = t('grouped.crossSite.suggestion.siteChanged');

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    try { await action(); setConfirming(false); onChanged(); }
    catch (cause) {
      // Someone else moved the device (or the confirmation raced a move): the suggestion no longer applies.
      if (cause instanceof ActionError && cause.status === 409 && (cause.body as { error?: unknown } | undefined)?.error === 'device_site_changed') setMoved(true);
      handleActionError(cause, fallback);
    }
    finally { setBusy(false); }
  };

  if (moved) return <p data-testid="topology-suggestion-site-changed" role="status" className="text-xs text-muted-foreground">{siteChanged}</p>;

  if (confirmedAt) {
    const date = formatDate(confirmedAt, { day: 'numeric', month: 'short' });
    return <p data-testid="topology-suggestion-off" className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      <span>{t('grouped.crossSite.suggestion.confirmed', { date })}</span>
      {canMove && <button type="button" data-testid="topology-suggestion-turn-on" disabled={busy}
        className="rounded text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
        onClick={() => void run(() => setSiteAssignmentConfirmation({ deviceId, confirmed: false, siteChanged,
          errorFallback: t('grouped.crossSite.suggestion.turnOnFailed'), successMessage: t('grouped.crossSite.suggestion.turnedOn', { device: deviceName }) }),
          t('grouped.crossSite.suggestion.turnOnFailed'))}>{t('grouped.crossSite.suggestion.turnOn')}</button>}
    </p>;
  }

  if (!suggestion) return null;
  const range = { from: formatDate(suggestion.firstObservedAt, { day: 'numeric', month: 'short' }), to: formatDate(suggestion.lastObservedAt, { day: 'numeric', month: 'short' }) };
  const evidence = prefix
    ? t('grouped.crossSite.suggestion.evidence', { site: suggestion.siteName, prefix, days: suggestion.days, ...range, assigned: assignedSite.name })
    : t('grouped.crossSite.suggestion.evidenceNoPrefix', { site: suggestion.siteName, days: suggestion.days, ...range, assigned: assignedSite.name });
  const move = () => run(() => moveDeviceToSuggestedSite({ deviceId, fromSiteId: assignedSite.id, toSiteId: suggestion.siteId, siteChanged,
    errorFallback: t('grouped.crossSite.suggestion.moveFailed'), successMessage: t('grouped.crossSite.suggestion.moved', { device: deviceName, site: suggestion.siteName }) }),
  t('grouped.crossSite.suggestion.moveFailed'));
  const keep = () => run(() => setSiteAssignmentConfirmation({ deviceId, confirmed: true, siteChanged,
    errorFallback: t('grouped.crossSite.suggestion.keepFailed'), successMessage: t('grouped.crossSite.suggestion.kept', { device: deviceName, site: assignedSite.name }) }),
  t('grouped.crossSite.suggestion.keepFailed'));
  const button = 'rounded border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50';

  return <div data-testid="topology-suggestion" role="group" aria-labelledby={titleId} className="mt-1 space-y-1.5 rounded border border-dashed px-2 py-1.5">
    <p id={titleId} className="text-xs font-medium">{t('grouped.crossSite.suggestion.title')}</p>
    <p data-testid="topology-suggestion-evidence" className="text-xs text-muted-foreground">{evidence}</p>
    {canMove && !confirming && <div className="flex flex-wrap gap-1.5">
      <button type="button" data-testid="topology-suggestion-move" className={button} disabled={busy} onClick={() => setConfirming(true)}>
        {t('grouped.crossSite.suggestion.move', { site: suggestion.siteName })}</button>
      <button type="button" data-testid="topology-suggestion-keep" className={button} disabled={busy} onClick={() => void keep()}>
        {t('grouped.crossSite.suggestion.keep', { site: assignedSite.name })}</button>
    </div>}
    {canMove && confirming && <div data-testid="topology-suggestion-confirm" role="alertdialog" aria-labelledby={confirmId} className="space-y-1.5">
      <p id={confirmId} className="text-xs">{t('grouped.crossSite.suggestion.confirmMove', { device: deviceName })}</p>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" data-testid="topology-suggestion-confirm-move" className={`${button} border-primary text-primary`} disabled={busy} onClick={() => void move()}>
          {t('grouped.crossSite.suggestion.move', { site: suggestion.siteName })}</button>
        <button type="button" data-testid="topology-suggestion-cancel" className={button} disabled={busy} onClick={() => setConfirming(false)}>
          {t('grouped.crossSite.suggestion.cancel')}</button>
      </div>
    </div>}
  </div>;
}
