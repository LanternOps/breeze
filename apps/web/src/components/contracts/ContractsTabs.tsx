import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { useHashState } from '@/lib/useHashState';
import { ContractsList } from './ContractsList';
import TemplatesTab from './TemplatesTab';
import DocumentsTab from './DocumentsTab';
import CurrencyMismatchesTab from './CurrencyMismatchesTab';

// Four-tab landing shell for the contracts area: the recurring-contracts
// list, the contract-template library, unattached executed documents
// (Task 18), and the read-only contract-vs-org currency mismatch report
// (#3778, Task 15). Only one child mounts at a time so each owns the URL hash
// exclusively — the Contracts tab lets ContractsList manage its own
// `#orgId=…&status=…` filter fragment; Templates/Documents park on their own
// `#tab=…` fragment (CLAUDE.md: hash for transient UI state, never query params).
type Tab = 'contracts' | 'templates' | 'documents' | 'currency-mismatches';

function parseTab(hash: string): Tab | undefined {
  const tab = new URLSearchParams(hash).get('tab');
  return tab === 'templates' || tab === 'documents' || tab === 'currency-mismatches' ? tab : undefined;
}

export default function ContractsTabs() {
  const { t } = useTranslation('billing');
  const [tab, setTab] = useHashState<Tab>('contracts', parseTab);

  const select = (next: Tab) => {
    setTab(next);
    // Templates/Documents park on a dedicated fragment; switching back to
    // Contracts hands the hash back to ContractsList by clearing it.
    window.location.hash = next === 'contracts' ? '' : `tab=${next}`;
  };

  const tabClass = (active: boolean) =>
    `border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
      active
        ? 'border-primary text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground'
    }`;

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b" role="tablist" data-testid="contracts-tabs">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'contracts'}
          onClick={() => select('contracts')}
          data-testid="contracts-tab-contracts"
          className={tabClass(tab === 'contracts')}
        >
          {t('contracts.tabs.contracts')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'templates'}
          onClick={() => select('templates')}
          data-testid="contracts-tab-templates"
          className={tabClass(tab === 'templates')}
        >
          {t('contracts.tabs.templates')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'documents'}
          onClick={() => select('documents')}
          data-testid="contracts-tab-documents"
          className={tabClass(tab === 'documents')}
        >
          {t('contracts.tabs.documents')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'currency-mismatches'}
          onClick={() => select('currency-mismatches')}
          data-testid="contracts-tab-currency-mismatches"
          className={tabClass(tab === 'currency-mismatches')}
        >
          {t('contracts.tabs.currencyMismatches')}
        </button>
      </div>
      {tab === 'templates' ? (
        <TemplatesTab />
      ) : tab === 'documents' ? (
        <DocumentsTab />
      ) : tab === 'currency-mismatches' ? (
        <CurrencyMismatchesTab />
      ) : (
        <ContractsList />
      )}
    </div>
  );
}
