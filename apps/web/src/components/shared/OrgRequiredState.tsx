import { useState } from 'react';
import { Building2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOrgStore } from '@/stores/orgStore';
import { applyOrgSwitch } from '@/lib/orgSwitch';
import { useTranslation } from 'react-i18next';

// Don't turn the empty state into a second org directory — offer a quick pick
// of the first few orgs and defer to the header switcher (with its search) for
// longer lists.
const QUICK_PICK_LIMIT = 6;

/**
 * The standard body for an org-required page seen in fleet view: states that
 * the page needs one organization and offers a one-click way to pick it,
 * instead of a raw 400, a silent empty table, or a page-specific prompt.
 * `description` carries the page's own sentence ("Network monitoring is
 * per-organization…"); the title, quick-pick, and switcher hint are shared.
 */
export function OrgRequiredState({ description }: { description?: string }) {
  const { t } = useTranslation('common');
  const organizations = useOrgStore((s) => s.organizations);
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const quickPick = organizations.slice(0, QUICK_PICK_LIMIT);

  const pick = async (orgId: string, name: string) => {
    if (switchingId) return;
    setSwitchingId(orgId);
    await applyOrgSwitch(orgId, t('layout.org.toast.switched', { name }));
  };

  return (
    <div
      data-testid="org-required-state"
      className="flex flex-col items-center rounded-lg border border-dashed px-6 py-12 text-center"
    >
      <Building2 className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <h2 className="mt-3 text-base font-semibold">{t('layout.orgRequired.title')}</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        {description ?? t('layout.orgRequired.description')}
      </p>

      {quickPick.length > 0 && (
        <div className="mt-5 flex max-w-xl flex-wrap items-center justify-center gap-2">
          {quickPick.map((org) => (
            <button
              key={org.id}
              type="button"
              onClick={() => void pick(org.id, org.name)}
              disabled={switchingId !== null}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-60'
              )}
            >
              {switchingId === org.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              {org.name}
            </button>
          ))}
        </div>
      )}

      {organizations.length > QUICK_PICK_LIMIT && (
        <p className="mt-3 text-xs text-muted-foreground">{t('layout.orgRequired.moreHint')}</p>
      )}
    </div>
  );
}
