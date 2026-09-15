import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { useHashState } from '@/lib/useHashState';
import { ContractsList } from './ContractsList';
import CurrencyMismatchesTab from './CurrencyMismatchesTab';

// The contracts landing page (spec §6). Agreement templates and signed
// agreements moved out to /agreements in W03, so what is left is the contracts
// LIST plus the read-only currency-mismatch report — and the report is reached
// from a banner on the list, not a tab. Net: no tab bar in the default state.
type Tab = 'contracts' | 'currency-mismatches';

// Deep links minted before the split. This uses `window.location.replace`
// rather than Astro's `navigate()` (via `navigateTo`): on a fresh deep-link
// load `history.state` is null, and Astro's `navigate()` throws reading it
// inside its own async `updateDOM` — an error Astro swallows internally, so
// it never reaches `navigateTo`'s try/catch and its fallback never fires,
// leaving the address bar and title stranded on /contracts. A full navigation
// is correct here regardless: this is a cross-page redirect, it must work
// from a cold load, and `replace` (not `assign`) keeps it out of the back
// stack, so Back from /agreements/templates returns to whatever the user was
// on before, not to a URL that immediately re-redirects.
const LEGACY_REDIRECTS: Record<string, string> = {
  templates: '/agreements/templates',
  documents: '/agreements/signed',
};

function parseTab(hash: string): Tab | undefined {
  return new URLSearchParams(hash).get('tab') === 'currency-mismatches' ? 'currency-mismatches' : undefined;
}

export default function ContractsTabs() {
  const { t } = useTranslation('billing');
  const [tab, setTab] = useHashState<Tab>('contracts', parseTab);

  useEffect(() => {
    const redirect = () => {
      const raw = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('tab');
      const target = raw ? LEGACY_REDIRECTS[raw] : undefined;
      if (target) window.location.replace(target);
    };
    redirect();
    window.addEventListener('hashchange', redirect);
    return () => window.removeEventListener('hashchange', redirect);
  }, []);

  const showContracts = () => { setTab('contracts'); window.location.hash = ''; };

  return (
    <div className="space-y-4" data-testid="contracts-tabs">
      {tab === 'currency-mismatches' ? (
        <>
          <button type="button" onClick={showContracts} data-testid="contracts-back-to-list"
                  className="text-xs text-muted-foreground hover:underline">
            {t('contracts.contractWorkspace.backToContracts')}
          </button>
          <CurrencyMismatchesTab />
        </>
      ) : (
        <ContractsList />
      )}
    </div>
  );
}
