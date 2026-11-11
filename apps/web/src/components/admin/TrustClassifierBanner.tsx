import { AlertTriangle, Network } from 'lucide-react';

export type OfflineSourceStatus = {
  source: 'snapshot' | 'download' | 'disk' | 'unavailable' | string;
  entries: number;
  updatedAt: string | null;
  lastError: string | null;
};

export type TrustQueueClassifier = {
  active: 'offline' | 'ipinfo' | 'ipdata' | string;
  offline: {
    tor: OfflineSourceStatus;
    hosting: OfflineSourceStatus;
    asn: OfflineSourceStatus;
    reportedAt: string;
  } | null;
};

export type RecordedPromotionBlockers = {
  blockers: string[];
  evaluatedAt: string;
};

const BLOCKER_LABELS: Record<string, string> = {
  card_not_settled: 'Card not settled',
  settled_too_recent: 'Card settled less than 24 hours ago',
  signup_ip_hosting: 'Signup IP is hosting, VPN or Tor',
  signup_ip_unclassified: 'Signup IP unclassified',
  device_on_tor: 'A device enrolled from Tor',
  unresolved_alert: 'Unresolved abuse alert',
  billing_hold: 'Billing risk hold',
  billing_hold_unknown: 'Billing risk hold unknown',
  email_unverified: 'Email not verified',
  too_young: 'Partner younger than 24 hours',
};

export function blockerLabel(blocker: string): string {
  return BLOCKER_LABELS[blocker] ?? blocker;
}

/** How the stored signup class was produced, for the queue's signup IP cell. */
export function signupSourceLabel(ipClass: string, source: string | null | undefined): string {
  if (!source) return 'not recorded';
  if (source === 'offline') return ipClass === 'unknown' ? 'offline: nothing found' : 'offline baseline';
  if (source === 'offline-partial') return 'offline: Tor list only';
  if (source === 'none') return 'private address, not checked';
  return source;
}

const count = (value: number) => value.toLocaleString('en-US');

function sourceText(label: string, status: OfflineSourceStatus, unit: string): string {
  if (status.source === 'unavailable') return `${label}: unavailable`;
  const origin = status.source === 'snapshot' ? 'bundled snapshot' : status.source === 'disk' ? 'cached download' : 'downloaded';
  const date = status.updatedAt ? `, ${status.updatedAt.slice(0, 10)}` : '';
  return `${label}: ${count(status.entries)} ${unit} (${origin}${date})`;
}

/**
 * Which IP classifier the trust gate is using (#11698). With the offline
 * baseline missing its ASN database, only Tor exits are detected and every
 * other signup stays unclassified, which blocks auto-promotion: say so.
 */
export function TrustClassifierBanner({ classifier }: { classifier: TrustQueueClassifier | undefined }) {
  if (!classifier) return null;
  if (classifier.active !== 'offline') {
    return (
      <div className="flex items-start gap-2 rounded-lg border bg-card p-4 text-sm" data-testid="trust-queue-classifier">
        <Network className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p>IP classification: provider <span className="font-medium">{classifier.active}</span></p>
      </div>
    );
  }

  const offline = classifier.offline;
  const degraded = !offline || offline.asn.source === 'unavailable';
  return (
    <div className="space-y-2 rounded-lg border bg-card p-4 text-sm" data-testid="trust-queue-classifier">
      <div className="flex items-start gap-2">
        <Network className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <p>
            IP classification: <span className="font-medium">Offline baseline</span> (Tor exits and hosting ASNs; no provider configured)
          </p>
          {offline ? (
            <p className="mt-1 text-muted-foreground">
              {[
                sourceText('Tor exit list', offline.tor, 'addresses'),
                sourceText('Hosting ASNs', offline.hosting, 'ASNs'),
                sourceText('ASN database', offline.asn, 'ranges'),
              ].join(' · ')}
            </p>
          ) : (
            <p className="mt-1 text-muted-foreground">No classification has run since the worker started, so no data status is available yet.</p>
          )}
        </div>
      </div>
      {degraded && offline && (
        <p className="flex items-start gap-2 text-amber-700 dark:text-amber-400" data-testid="trust-queue-classifier-degraded">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          The ASN database is unavailable, so only Tor exits are detected. Other signup IPs stay unclassified and block auto-promotion until it loads.
        </p>
      )}
    </div>
  );
}
