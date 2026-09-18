import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import '@/lib/i18n';
import {
  PSA_PROVIDER_NAMES,
  SYSTEM_DISPLAY_NAMES,
  type BoardRow,
  type IntegrationBadge,
  type IntegrationSystem,
} from '@/lib/orgReadiness';

/** Brand names come from code; only PSA, DNS filter and the external label are locale-dependent. */
export function integrationSystemName(
  t: TFunction,
  system: IntegrationSystem,
  opts: { provider?: string; label?: string } = {},
): string {
  if (system === 'psa') return (opts.provider && PSA_PROVIDER_NAMES[opts.provider]) || t('orgBoard.integrations.system.psa');
  if (system === 'dns_filter') return t('orgBoard.integrations.system.dns_filter');
  if (system === 'external') return opts.label ?? '';
  return SYSTEM_DISPLAY_NAMES[system];
}

/** Semantic tokens only, as lib/orgStatus.ts does — dark mode themes itself. */
const DOT_CLASS: Record<IntegrationBadge['state'], string> = {
  linked: 'bg-success',
  pending: 'bg-warning',
  error: 'bg-destructive',
  identity: 'bg-muted-foreground/60',
  not_linked: 'border border-dashed border-muted-foreground/60 bg-transparent',
};

/**
 * The Integrations cell. Same state conventions as ReadinessChips: a skeleton
 * while the row's batch is in flight, "Unavailable" when it failed, a dash when
 * the section is withheld, "Nothing linked" when the org has no mapping, else
 * one badge per system (dot = state, label = system, reason in the title).
 * Badges are not links (plan §10); they stop propagation so the row's
 * open-record hit area does not fire on a click meant to read the title.
 */
export default function IntegrationBadges({
  row,
  psaProvider,
  testIdPrefix = 'org-board-badge',
}: {
  row: BoardRow;
  /** Provider of the partner-level PSA connection, for the PSA badge's label. */
  psaProvider?: string;
  /** `org-board-badge` on the table, `org-board-card-badge` on the phone cards. */
  testIdPrefix?: string;
}) {
  const { t } = useTranslation('organizations');
  const orgId = row.org.id;
  const orgName = row.org.name;

  if (row.state === 'pending') {
    return (
      <span data-testid="org-board-badges-pending" className="inline-flex items-center gap-1.5" aria-busy="true">
        <span className="skeleton h-5 w-20 rounded-full" aria-hidden="true" />
        <span className="sr-only">{t('orgBoard.band.pending')}</span>
      </span>
    );
  }
  if (row.state === 'failed') {
    return (
      <span data-testid="org-board-badges-unavailable" className="text-xs text-muted-foreground">
        {t('orgBoard.chips.unavailable')}
      </span>
    );
  }
  const badges = row.badges;
  if (badges === null) return <span className="text-muted-foreground">—</span>;
  if (badges.length === 0) {
    // The desktop table cell and the phone card render the same row's IntegrationBadges
    // simultaneously (ResponsiveTable renders both, CSS hides one) — the testid must vary
    // with testIdPrefix like every other testid in this component, or Playwright's
    // getByTestId resolves to two elements. Derived from testIdPrefix so the default
    // ('org-board-badge' → 'org-board-nothing-linked') stays exactly what every existing
    // test and the E2E page object already expect.
    const nothingLinkedTestId = `${testIdPrefix.replace(/-?badge$/, '')}-nothing-linked-${orgId}`.replace(/^-/, '');
    return (
      <span className="text-xs text-muted-foreground" data-testid={nothingLinkedTestId}>
        {t('orgBoard.integrations.nothingLinked')}
      </span>
    );
  }
  return (
    <ul className="flex flex-wrap gap-1.5" data-testid={`org-board-badges-${orgId}`} onClick={(event) => event.stopPropagation()}>
      {badges.map((badge) => {
        const system = integrationSystemName(t, badge.system, { provider: psaProvider, label: badge.label });
        const stateLabel = t(/* i18n-dynamic */ `orgBoard.integrations.state.${badge.state}`);
        const reasonText = badge.reason ? t(/* i18n-dynamic */ `orgBoard.integrations.reason.${badge.reason}`) : null;
        const ariaLabel = reasonText
          ? t('orgBoard.integrations.badgeLabelWithReason', { orgName, system, state: stateLabel, reason: reasonText })
          : t('orgBoard.integrations.badgeLabel', { orgName, system, state: stateLabel });
        // Every badge must have a `title` — mouse users have no other way to see
        // this info on hover. Muted explains itself; otherwise prefer the reason
        // and fall back to the same text as the accessible name so a linked/identity
        // badge with no reason still shows something on hover.
        const title = badge.muted ? t('orgBoard.integrations.connectorMuted', { system }) : (reasonText ?? ariaLabel);
        const testId = badge.system === 'external'
          ? `${testIdPrefix}-${orgId}-external-${badge.label ?? ''}`
          : `${testIdPrefix}-${orgId}-${badge.system}`;
        const text = badge.state === 'not_linked' ? t('orgBoard.integrations.notLinked', { system }) : system;
        return (
          <li
            key={testId}
            data-testid={testId}
            aria-label={ariaLabel}
            title={title}
            className={[
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs leading-none',
              badge.state === 'not_linked' ? 'border-dashed text-muted-foreground' : 'border-border text-foreground',
              badge.muted ? 'opacity-60' : '',
            ].join(' ')}
          >
            <span data-dot aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${DOT_CLASS[badge.state]}`} />
            {text}
          </li>
        );
      })}
    </ul>
  );
}
