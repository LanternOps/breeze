// Anonymous gated-document request form (W02d). The confirmation is identical for every outcome so the
// response never reveals whether the page, email or rate limit matched.
import { useState, type FormEvent } from 'react';
import { requestAccess } from '@/lib/trustAccessApi';
import { pickTrustCopy, useTrustLocale } from '../trustCopy';
import { accessCopy } from './accessCopy';

interface Props {
  partnerSlug: string;
  orgSlug: string | null;
  ndaText: string | null;
  onCancel?: () => void;
}

const INPUT = 'w-full rounded-md border bg-background px-3 py-2 text-sm';

export default function RequestAccessForm({ partnerSlug, orgSlug, ndaText, onCancel }: Props) {
  const t = pickTrustCopy(accessCopy, useTrustLocale());
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [purpose, setPurpose] = useState('');
  const [nda, setNda] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (done) {
    return <p className="mt-4 rounded-lg border bg-card px-4 py-3 text-sm" data-testid="trust-access-submitted" role="status">{t.submitted}</p>;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || (ndaText && !nda)) return;
    setBusy(true);
    try {
      await requestAccess({
        partnerSlug, orgSlug, email: email.trim(), name: name.trim(), company: company.trim(),
        purpose: purpose.trim(), ndaAccepted: ndaText ? nda : false,
      });
    } catch {
      // never reveal the outcome
    }
    setDone(true);
  }

  return (
    <form className="mt-4 space-y-3 rounded-lg border bg-card p-4 text-sm" onSubmit={onSubmit} data-testid="trust-access-form">
      <p className="text-muted-foreground">{t.formIntro}</p>
      <label className="block">
        <span className="mb-1 block font-medium">{t.nameLabel}</span>
        <input className={INPUT} data-testid="trust-access-name" required minLength={2} maxLength={200} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="block">
        <span className="mb-1 block font-medium">{t.emailLabel}</span>
        <input className={INPUT} type="email" data-testid="trust-access-email" required maxLength={320} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="block">
        <span className="mb-1 block font-medium">{t.companyLabel}</span>
        <input className={INPUT} data-testid="trust-access-company" required minLength={2} maxLength={200} autoComplete="organization" value={company} onChange={(e) => setCompany(e.target.value)} />
      </label>
      <label className="block">
        <span className="mb-1 block font-medium">{t.purposeLabel}</span>
        <textarea className={INPUT} rows={4} data-testid="trust-access-purpose" required minLength={10} maxLength={2000} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      </label>
      {ndaText && (
        <div className="space-y-2 rounded-md border p-3" data-testid="trust-access-nda">
          <h3 className="font-medium">{t.ndaHeading}</h3>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-xs text-muted-foreground">{ndaText}</pre>
          <label className="flex items-center gap-2">
            <input type="checkbox" required data-testid="trust-access-nda-checkbox" checked={nda} onChange={(e) => setNda(e.target.checked)} />
            <span>{t.ndaAccept}</span>
          </label>
        </div>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="rounded-md border px-3 py-2 text-sm font-medium doc-accent-text hover:underline disabled:opacity-50" data-testid="trust-access-submit">{t.submit}</button>
        {onCancel && <button type="button" className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:underline" data-testid="trust-access-cancel" onClick={onCancel}>{t.cancel}</button>}
      </div>
    </form>
  );
}
