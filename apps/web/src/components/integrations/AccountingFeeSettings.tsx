import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { accountingPath, type AccountingProviderId } from '../../lib/accountingProviders';

type Saved = { feeIncomeItemRef: string | null; feeIncomeAccountRef: string | null };

type Props = {
  provider: AccountingProviderId;
  itemRef: string | null;
  accountRef: string | null;
  disabled: boolean;
  onSaved: (value: Saved) => void;
};

export default function AccountingFeeSettings({ provider, itemRef, accountRef, disabled, onSaved }: Props) {
  const { t } = useTranslation('integrations');
  const current = provider === 'xero' ? accountRef : itemRef;
  const [draft, setDraft] = useState(current ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setDraft(current ?? '');
    setError(false);
  }, [current, provider]);

  const save = async () => {
    if (saving || disabled || draft.trim().length > 64) return;
    setSaving(true);
    setError(false);
    try {
      const ref = draft.trim() || null;
      const result = await runAction<Saved>({
        request: () => fetchWithAuth(accountingPath(provider, '/settings'), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(provider === 'xero' ? { feeIncomeAccountRef: ref } : { feeIncomeItemRef: ref }),
        }),
        errorFallback: t('accountingFees.failed'),
        successMessage: t('accountingFees.saved'),
      });
      onSaved(result);
    } catch (e) {
      setError(true);
      handleActionError(e, t('accountingFees.failed'));
    } finally {
      setSaving(false);
    }
  };

  return <section data-testid="autopay-accounting-fees" className="rounded-lg border p-4 space-y-3">
    <h3 className="font-medium">{t('accountingFees.title')}</h3>
    <label className="block" htmlFor="autopay-accounting-fee-ref">
      {provider === 'xero' ? t('accountingFees.account') : t('accountingFees.item')}
    </label>
    <input id="autopay-accounting-fee-ref" data-testid="autopay-accounting-fee-ref" value={draft} maxLength={64}
      disabled={disabled || saving} onChange={e => setDraft(e.target.value)} className="rounded border px-3 py-2" />
    <p>{t('accountingFees.help')}</p>
    {error && <p role="alert" data-testid="autopay-accounting-fee-error">{t('accountingFees.failed')}</p>}
    <button type="button" data-testid="autopay-accounting-fee-save" disabled={disabled || saving || draft.trim().length > 64}
      onClick={() => void save()}>{t('accountingFees.save')}</button>
  </section>;
}
