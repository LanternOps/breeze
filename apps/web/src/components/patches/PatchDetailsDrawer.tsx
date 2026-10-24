import { useTranslation } from 'react-i18next';
import { Drawer } from '../shared/Drawer';
import '../../lib/i18n';
import { formatDateOnly, parseDateOnly } from '../../lib/dateOnly';
import type { Patch } from './PatchList';
import type { UpdateRingItem } from './UpdateRingList';

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRD_PARTY_SOURCES = ['third_party', 'custom'];

const SEVERITY_KEYS: Record<Patch['severity'], string> = {
  critical: 'patchList.severity.critical',
  important: 'patchList.severity.important',
  moderate: 'patchList.severity.moderate',
  low: 'patchList.severity.low',
  unrated: 'patchList.severity.unrated',
};

export type RingAutoApproval =
  | { kind: 'date'; at: Date; days: number }
  | { kind: 'immediate'; days: number }
  | { kind: 'needsDate'; days: number }
  | { kind: 'manual' };

/**
 * Catalog-level projection of when a ring's auto-approve gate releases a patch.
 * Mirrors the ring-level path of the API's patchApprovalEvaluator (severity
 * gate, third-party toggle, release-date anchor with the first-seen fallback
 * for Linux/third-party, #7800). Category overrides are not projected.
 * `firstSeen` here is the catalog import time, an upper bound on the per-device
 * first-seen the evaluator actually uses.
 */
export function projectRingAutoApproval(patch: Patch, ring: UpdateRingItem): RingAutoApproval {
  const gate = ring.autoApprove;
  if (!ring.enabled || !gate?.enabled) return { kind: 'manual' };

  let days: number;
  if (THIRD_PARTY_SOURCES.includes(patch.source)) {
    if (!gate.thirdPartyApps) return { kind: 'manual' };
    days = gate.thirdPartyDeferralDays ?? gate.deferralDays;
  } else {
    if (gate.severities.length === 0) return { kind: 'manual' };
    if (patch.severity === 'unrated') {
      if (!gate.autoApproveUnrated) return { kind: 'manual' };
    } else if (!gate.severities.includes(patch.severity)) {
      return { kind: 'manual' };
    }
    days = gate.deferralDays;
  }

  if (days <= 0) return { kind: 'immediate', days };

  const usesFirstSeen = patch.source === 'linux' || THIRD_PARTY_SOURCES.includes(patch.source);
  const anchorRaw = patch.releaseDate || (usesFirstSeen ? patch.firstSeenAt : undefined);
  const anchor = anchorRaw ? parseDateOnly(anchorRaw) : null;
  if (!anchor || Number.isNaN(anchor.getTime())) return { kind: 'needsDate', days };
  return { kind: 'date', at: new Date(anchor.getTime() + days * DAY_MS), days };
}

function formatDate(value: string | Date): string {
  if (typeof value === 'string') return formatDateOnly(value);
  return Number.isNaN(value.getTime()) ? String(value) : value.toLocaleDateString();
}

type Props = {
  patch: Patch | null;
  rings: UpdateRingItem[];
  onClose: () => void;
};

function Fact({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm" data-testid={testId}>{children}</dd>
    </div>
  );
}

export default function PatchDetailsDrawer({ patch, rings, onClose }: Props) {
  const { t } = useTranslation('patches');
  if (!patch) return null;

  const unknown = t('patchDetails.unknown');
  return (
    <Drawer open onClose={onClose} title={patch.title} width="max-w-xl" dataTestId="patch-details-drawer">
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Fact label={t('patchDetails.source')} testId="patch-details-source">{patch.source}</Fact>
          <Fact label={t('patchDetails.packageId')} testId="patch-details-package-id">{patch.packageId || patch.externalId || unknown}</Fact>
          <Fact label={t('patchDetails.severity')} testId="patch-details-severity">
            {t(/* i18n-dynamic */ (SEVERITY_KEYS[patch.severity] ?? SEVERITY_KEYS.unrated))}
            {patch.severity !== 'unrated' && patch.severitySource === 'derived' && (
              <span className="ml-2 text-xs text-muted-foreground" data-testid="patch-details-severity-derived">
                {t('patchList.severity.derivedNote')}
              </span>
            )}
          </Fact>
          <Fact label={t('patchDetails.releaseDate')} testId="patch-details-release">
            {patch.releaseDate ? formatDate(patch.releaseDate) : t('patchList.releaseUnknown')}
          </Fact>
          <Fact label={t('patchDetails.firstSeen')} testId="patch-details-first-seen">
            {patch.firstSeenAt ? formatDate(patch.firstSeenAt) : unknown}
          </Fact>
        </dl>

        <section>
          <h3 className="text-sm font-semibold">{t('patchDetails.rings.title')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('patchDetails.rings.note')}</p>
          {rings.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">{t('patchDetails.rings.none')}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {rings.map((ring) => {
                const result = projectRingAutoApproval(patch, ring);
                return (
                  <li
                    key={ring.id}
                    className="rounded-md border px-3 py-2 text-sm"
                    data-testid={`patch-details-ring-${ring.id}`}
                  >
                    <div className="font-medium">{ring.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {result.kind === 'manual' && t('patchDetails.rings.manual')}
                      {result.kind === 'immediate' && t('patchDetails.rings.immediate')}
                      {result.kind === 'needsDate' && t('patchDetails.rings.needsDate', { count: result.days })}
                      {result.kind === 'date' && (
                        <>
                          {t('patchDetails.rings.autoApproves', { date: formatDate(result.at) })}
                          {' · '}
                          {t('patchDetails.rings.hold', { count: result.days })}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  );
}
