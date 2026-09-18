// Per-OID collection state (spec §6.2). The column that matters is `state`:
// before this wave nothing anywhere said that 145 of the built-in template OIDs
// had never collected a value (spec §1 F3), and a table of blanks reads as
// "quiet" rather than "broken". Every non-collecting state therefore carries
// its own explanation on the row.

import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatLastSeen } from '@/lib/formatTime';
import { Section } from './primitives';
import { formatAbsolute } from './reachabilityCopy';
import type { Collection, CollectionOid, CollectionOidState } from './types';

const STATE_KEYS: Record<CollectionOidState, string> = {
  collecting: 'networkDeviceDetailPage.collection.oidState.collecting',
  unsupported: 'networkDeviceDetailPage.collection.oidState.unsupported',
  stale: 'networkDeviceDetailPage.collection.oidState.stale',
  never_polled: 'networkDeviceDetailPage.collection.oidState.neverPolled',
  unknown: 'networkDeviceDetailPage.collection.oidState.unknown',
};

const STATE_CLASSES: Record<CollectionOidState, string> = {
  collecting: 'bg-success/15 text-success border-success/30',
  unsupported: 'bg-warning/15 text-warning border-warning/30',
  stale: 'bg-warning/15 text-warning border-warning/30',
  never_polled: 'bg-muted text-muted-foreground border-muted',
  unknown: 'bg-muted text-muted-foreground border-muted',
};

/** A scalar GET returns one unnamed instance; there is nothing to expand. */
function isExpandable(entry: CollectionOid): boolean {
  return entry.instances.length > 1 || (entry.instances.length === 1 && entry.instances[0].instance !== '');
}

function OidRow({ entry, timezone }: { entry: CollectionOid; timezone: string }) {
  const { t } = useTranslation('devices');
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const expandable = isExpandable(entry);
  const latest = entry.instances[0]?.value ?? null;

  return (
    <div className="border-b py-2 last:border-b-0" data-testid={`network-detail-oid-row-${entry.baseOid}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        {expandable ? (
          <button
            type="button"
            data-testid={`network-detail-oid-toggle-${entry.baseOid}`}
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => setExpanded((open) => !open)}
            className="flex shrink-0 items-center gap-1 rounded-sm text-left font-medium hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight aria-hidden="true" className={`h-3.5 w-3.5 transition ${expanded ? 'rotate-90' : ''}`} />
            {entry.name}
            <span className="text-xs font-normal text-muted-foreground">({entry.instances.length})</span>
          </button>
        ) : (
          <span className="shrink-0 font-medium">{entry.name}</span>
        )}

        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={entry.baseOid}>
          {entry.baseOid}
        </span>
        <span className="shrink-0 rounded-sm border px-1 py-0.5 font-mono text-xs text-muted-foreground">{entry.mode}</span>
        <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-xs ${STATE_CLASSES[entry.state]}`}>
          {t(/* i18n-dynamic */ STATE_KEYS[entry.state])}
        </span>
        <span className="ml-auto shrink-0 tabular-nums">
          {latest === null ? <span aria-label={t('common:states.unknown')}>—</span> : latest}
        </span>
        <span
          className="shrink-0 text-xs text-muted-foreground"
          title={entry.observedAt ? formatAbsolute(entry.observedAt, timezone) : undefined}
        >
          {entry.observedAt ? formatLastSeen(entry.observedAt, timezone) : ''}
        </span>
      </div>

      {entry.state === 'unsupported' && entry.error && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('networkDeviceDetailPage.collection.unsupportedWithCode', { code: entry.error })}
        </p>
      )}
      {entry.state === 'unknown' && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('networkDeviceDetailPage.collection.unknownNeedsAgentUpdate')}
        </p>
      )}
      {entry.error === 'truncated' && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('networkDeviceDetailPage.collection.partialRows')}
        </p>
      )}

      {expandable && expanded && (
        <dl id={panelId} className="mt-2 space-y-1 border-l pl-3 text-xs">
          {entry.instances.map((row) => (
            <div key={row.instance} className="flex items-baseline justify-between gap-3" data-testid={`network-detail-oid-instance-${row.instance}`}>
              <dt className="min-w-0 truncate font-mono text-muted-foreground" title={row.oid}>{row.instance}</dt>
              <dd className="shrink-0 tabular-nums" title={formatAbsolute(row.observedAt, timezone)}>
                {row.value ?? <span aria-label={t('common:states.unknown')}>—</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function OidTable({ collection, timezone }: { collection: Collection | null; timezone: string }) {
  const { t } = useTranslation('devices');

  if (!collection) {
    return (
      <Section title={t('networkDeviceDetailPage.sections.oids')} testId="network-detail-oids">
        <p className="text-xs text-muted-foreground" data-testid="network-detail-oid-not-configured">
          {t('networkDeviceDetailPage.collection.status.notConfigured')}
        </p>
      </Section>
    );
  }

  if (collection.status === 'no_template') {
    return (
      <Section title={t('networkDeviceDetailPage.sections.oids')} testId="network-detail-oids">
        <p className="text-xs text-muted-foreground" data-testid="network-detail-oid-no-template">
          {t('networkDeviceDetailPage.health.noTemplate')}
        </p>
      </Section>
    );
  }

  return (
    <Section title={t('networkDeviceDetailPage.sections.oids')} testId="network-detail-oids">
      <div data-testid="network-detail-oid-table">
        {collection.oids.map((entry) => (
          <OidRow key={entry.baseOid} entry={entry} timezone={timezone} />
        ))}
      </div>
    </Section>
  );
}
