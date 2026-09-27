import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import {
  fetchAccountingProviders,
  isAccountingProviderVisible,
  type AccountingProviderId,
  type AccountingProvidersResponse,
} from '../../lib/accountingProviders';

interface Props {
  selected: AccountingProviderId | null;
  onSelect: (p: AccountingProviderId) => void;
  /**
   * Hands the parent the provider list this component loaded (`null` when it
   * could not be loaded), so IntegrationsPage can gate each provider's panel on
   * the same answer that decides which cards render — one request, one truth.
   */
  onLoaded?: (providers: AccountingProvidersResponse | null) => void;
}

/**
 * One card per accounting provider this instance has configured, plus the
 * provider holding the partner's connection even if it is no longer configured
 * so it can still be disconnected (`isAccountingProviderVisible`, Xero W01).
 * A partner holds at most one accounting connection, so while one provider is
 * connected every other provider's card is greyed out and says which one to
 * disconnect first — the API would answer a connect there with 409
 * `accounting_provider_conflict` anyway.
 */
export default function AccountingProviderCards({ selected, onSelect, onLoaded }: Props) {
  const { t } = useTranslation('integrations');
  const [state, setState] = useState<AccountingProvidersResponse | null>(null);
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  });

  useEffect(() => {
    let live = true;
    void fetchAccountingProviders().then((result) => {
      if (!live) return;
      setState(result);
      onLoadedRef.current?.(result);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!state) return null;
  const active = state.activeConnection;
  const activeName = active
    ? state.data.find((p) => p.id === active.provider)?.displayName ?? active.provider
    : null;
  const visible = state.data.filter((p) => isAccountingProviderVisible(p, active));
  if (visible.length === 0) {
    return (
      <p
        className="rounded-lg border bg-card p-4 text-sm text-muted-foreground"
        data-testid="accounting-provider-cards-empty"
      >
        {t('accountingProviders.noProviderConfigured')}
      </p>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="accounting-provider-cards">
      {visible.map((p) => {
          const blocked = !!active && active.provider !== p.id;
          const isSelected = selected === p.id;
          // A reauth-required connection still "has" a provider — it just
          // can't push/pull anything until reconnected — so the card must
          // not claim "Connected" (finding: it read that way even when the
          // connection needed reauth).
          const needsReauth = active?.provider === p.id && active.status === 'reauth_required';
          return (
            <button
              key={p.id}
              type="button"
              data-testid={`accounting-provider-card-${p.id}`}
              aria-pressed={isSelected}
              aria-disabled={blocked}
              disabled={blocked}
              onClick={() => onSelect(p.id)}
              className={`rounded-lg border p-4 text-left transition ${
                blocked ? 'cursor-not-allowed opacity-50' : 'hover:bg-muted'
              } ${isSelected ? 'border-primary bg-primary/5' : 'border-border'}`}
            >
              <div className="font-medium">{p.displayName}</div>
              <div className="text-sm text-muted-foreground">
                {blocked
                  ? t('accountingProviders.disconnectOtherFirst', { provider: activeName })
                  : needsReauth
                    ? t('accountingProviders.reconnectRequired')
                    : active?.provider === p.id
                      ? t('accountingProviders.connected')
                      : t('accountingProviders.notConnected')}
              </div>
            </button>
          );
        })}
    </div>
  );
}
