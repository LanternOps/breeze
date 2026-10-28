import { GitBranch, Globe, Lock, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CATALOG_BY_ID, type CatalogEntry } from '@breeze/shared';
import '@/lib/i18n';
import HelpTooltip from '../../shared/HelpTooltip';
import { formatInheritanceValue } from './formatInheritanceValue';
import { usePartnerInheritance } from './inheritanceContext';

/** The five badge variants of spec §5.3 (an `unclassified` field has none). */
export type BadgeVariant = 'locks' | 'locksConditional' | 'overridable' | 'overridableCap' | 'partnerOnly';

export function badgeVariant(entry: CatalogEntry | undefined): BadgeVariant | null {
  if (!entry) return null;
  switch (entry.kind) {
    case 'locks': return entry.qualifier === 'conditional' ? 'locksConditional' : 'locks';
    case 'overridable': return entry.qualifier === 'cap' ? 'overridableCap' : 'overridable';
    case 'partnerOnly': return 'partnerOnly';
    default: return null;
  }
}

/** Kind-level styling; a qualifier changes the words, not the colour. */
export const BADGE_STYLE: Record<'locks' | 'overridable' | 'partnerOnly', { icon: LucideIcon; className: string }> = {
  locks: { icon: Lock, className: 'border-primary/30 bg-primary/10 text-primary' },
  overridable: { icon: GitBranch, className: 'border-border bg-muted text-foreground' },
  partnerOnly: { icon: Globe, className: 'border-border bg-background text-muted-foreground' },
};

export const BADGE_PILL = 'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium leading-4';

const K = 'partnerSettingsPage.inheritance';

/**
 * A small pill next to a field's label stating what the partner value can do
 * to the organizations (spec §5.3): it states capability, set or not. Whether
 * a lock is in force right now is the inline line's job.
 */
export default function SettingBadge({ fieldId }: { fieldId: string }) {
  const { t, i18n } = useTranslation('settings');
  const ui = usePartnerInheritance();
  const entry = CATALOG_BY_ID[fieldId];
  const variant = badgeVariant(entry);
  if (!entry || !variant) return null;

  let limit = '';
  if (variant === 'overridableCap' && entry.capFieldId) {
    const cap = CATALOG_BY_ID[entry.capFieldId];
    const saved = cap ? ui?.savedSetting(cap.paths[0]!) : undefined;
    limit = (cap && (formatInheritanceValue(cap, saved, t, i18n.language) ?? formatInheritanceValue(cap, cap.platformDefault, t, i18n.language))) ?? '';
  }

  const label = t(/* i18n-dynamic */ `${K}.badge.${variant}`, { limit });
  const style = BADGE_STYLE[entry.kind as keyof typeof BADGE_STYLE];
  const Icon = style.icon;

  return (
    <span className="inline-flex items-center gap-0.5">
      <span data-testid={`partner-settings-badge-${fieldId}`} className={`${BADGE_PILL} ${style.className}`}>
        <Icon className="h-3 w-3" aria-hidden="true" />
        {label}
      </span>
      <HelpTooltip
        text={t(/* i18n-dynamic */ `${K}.badgeHelp.${variant}`, { limit })}
        ariaLabel={t(/* i18n-dynamic */ `${K}.badgeHelpLabel`, { badge: label })}
      />
    </span>
  );
}
