import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  senderDisplayNameSchema,
  senderLocalPartSchema,
  type PartnerMailStreamValue,
  type SenderIdentityDto,
  type SendingDomainDto,
} from '@breeze/shared';
import {
  SENDING_DOMAIN_STREAMS,
  SUGGESTED_LOCAL_PARTS,
  fromAddressFor,
  sendableDomains,
} from './domainView';
import '@/lib/i18n';

export interface SenderIdentitiesFormProps {
  domains: SendingDomainDto[];
  identities: SenderIdentityDto[];
  /** From GET /ticket-config — drives the §8.5 no-inbound warning. */
  inbound: { configured: boolean; address: string | null };
  busy: boolean;
  onSave: (input: {
    stream: PartnerMailStreamValue;
    sendingDomainId: string;
    localPart: string;
    displayName: string | null;
    replyTo: string | null;
  }) => void | Promise<void>;
  onClear: (stream: PartnerMailStreamValue) => void | Promise<void>;
}

const STREAM_NAME_SUFFIX: Record<PartnerMailStreamValue, string> = {
  support: 'streamSupportName',
  billing: 'streamBillingName',
  general: 'streamGeneralName',
};

const STREAM_MAIL_SUFFIX: Record<PartnerMailStreamValue, string> = {
  support: 'streamSupportMail',
  billing: 'streamBillingMail',
  general: 'streamGeneralMail',
};

/** A complete address, deliberately looser than the RFC and identical to what the route's zod `.email()` accepts in practice. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface StreamRowProps extends Pick<SenderIdentitiesFormProps, 'busy' | 'inbound' | 'onSave' | 'onClear'> {
  stream: PartnerMailStreamValue;
  targets: SendingDomainDto[];
  existing: SenderIdentityDto | undefined;
}

function StreamRow({ stream, targets, existing, inbound, busy, onSave, onClear }: StreamRowProps) {
  const { t } = useTranslation('settings');
  const [sendingDomainId, setSendingDomainId] = useState(existing?.sendingDomainId ?? targets[0]!.id);
  const [localPart, setLocalPart] = useState(existing?.localPart ?? SUGGESTED_LOCAL_PARTS[stream]);
  const [displayName, setDisplayName] = useState(existing?.displayName ?? '');
  const [replyTo, setReplyTo] = useState(existing?.replyTo ?? '');
  const [error, setError] = useState<string | null>(null);

  // The From address is COMPOSED here: the partner never types a full address
  // (spec §4.4). A saved identity carries its own `fromAddress` from the API,
  // but this preview has to follow the local part and domain being EDITED.
  const preview = fromAddressFor({ localPart, sendingDomainId }, targets);

  const repliesSuffix =
    stream === 'support'
      ? (inbound.configured ? 'repliesSupport' : 'repliesSupportNoInbound')
      : stream === 'billing'
        ? 'repliesBilling'
        : 'repliesGeneral';

  const save = () => {
    const parsedLocal = senderLocalPartSchema.safeParse(localPart);
    if (!parsedLocal.success) {
      const reserved = parsedLocal.error.issues.some((issue) => issue.message === 'local_part_reserved');
      setError(t(/* i18n-dynamic */ reserved
        ? 'partnerSendingDomains.identityLocalPartReserved'
        : 'partnerSendingDomains.identityLocalPartInvalid'));
      return;
    }
    const trimmedName = displayName.trim();
    if (trimmedName.length > 0 && !senderDisplayNameSchema.safeParse(trimmedName).success) {
      setError(t('partnerSendingDomains.identityDisplayNameInvalid'));
      return;
    }
    const trimmedReplyTo = replyTo.trim();
    if (trimmedReplyTo.length > 0 && !EMAIL_RE.test(trimmedReplyTo)) {
      setError(t('partnerSendingDomains.identityReplyToInvalid'));
      return;
    }
    setError(null);
    void onSave({
      stream,
      sendingDomainId,
      localPart: parsedLocal.data,
      displayName: trimmedName.length > 0 ? trimmedName : null,
      replyTo: trimmedReplyTo.length > 0 ? trimmedReplyTo : null,
    });
  };

  return (
    <div className="mt-4 rounded-md border bg-muted/20 p-3" data-testid={`sending-identity-${stream}`}>
      <p className="text-sm font-medium">
        {t(/* i18n-dynamic */ `partnerSendingDomains.${STREAM_NAME_SUFFIX[stream]}`)}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {t(/* i18n-dynamic */ `partnerSendingDomains.${STREAM_MAIL_SUFFIX[stream]}`)}
      </p>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <label className="text-xs font-medium" htmlFor={`sending-identity-${stream}-localpart`}>
            {t('partnerSendingDomains.identityLocalPart')}
          </label>
          <input
            id={`sending-identity-${stream}-localpart`}
            type="text"
            value={localPart}
            disabled={busy}
            onChange={(e) => { setLocalPart(e.target.value); if (error) setError(null); }}
            className="mt-0.5 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid={`sending-identity-${stream}-localpart`}
          />
        </div>
        <div>
          <label className="text-xs font-medium" htmlFor={`sending-identity-${stream}-domain`}>
            {t('partnerSendingDomains.identityDomain')}
          </label>
          <select
            id={`sending-identity-${stream}-domain`}
            value={sendingDomainId}
            disabled={busy}
            onChange={(e) => setSendingDomainId(e.target.value)}
            className="mt-0.5 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid={`sending-identity-${stream}-domain`}
          >
            {targets.map((d) => (
              <option key={d.id} value={d.id}>{d.domain}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium" htmlFor={`sending-identity-${stream}-displayname`}>
            {t('partnerSendingDomains.identityDisplayName')}
          </label>
          <input
            id={`sending-identity-${stream}-displayname`}
            type="text"
            value={displayName}
            disabled={busy}
            onChange={(e) => { setDisplayName(e.target.value); if (error) setError(null); }}
            placeholder={t('partnerSendingDomains.identityDisplayNamePlaceholder')}
            className="mt-0.5 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid={`sending-identity-${stream}-displayname`}
          />
        </div>
        <div>
          <label className="text-xs font-medium" htmlFor={`sending-identity-${stream}-replyto`}>
            {t('partnerSendingDomains.identityReplyTo')}
          </label>
          <input
            id={`sending-identity-${stream}-replyto`}
            type="text"
            value={replyTo}
            disabled={busy}
            onChange={(e) => { setReplyTo(e.target.value); if (error) setError(null); }}
            className="mt-0.5 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid={`sending-identity-${stream}-replyto`}
          />
        </div>
      </div>

      {preview && (
        <p className="mt-2 font-mono text-xs" data-testid={`sending-identity-${stream}-from`}>
          {t('partnerSendingDomains.identityFrom', { address: preview })}
        </p>
      )}

      <p className="mt-1.5 text-xs text-muted-foreground" data-testid={`sending-identity-${stream}-replies`}>
        {t(/* i18n-dynamic */ `partnerSendingDomains.${repliesSuffix}`, { inbound: inbound.address ?? '' })}
      </p>

      {error && (
        <p className="mt-1.5 text-xs text-destructive" data-testid={`sending-identity-${stream}-error`}>
          {error}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={save}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          data-testid={`sending-identity-${stream}-save`}
        >
          {t('common:actions.save')}
        </button>
        {existing && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void onClear(stream)}
            className="rounded-md border px-2.5 py-1.5 text-sm disabled:opacity-50"
            data-testid={`sending-identity-${stream}-clear`}
          >
            {t('partnerSendingDomains.identityClear')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One block per mail stream (spec §3.2). A stream with no row sends from the
 * platform sender and there is no implicit fallback between streams, so each
 * block is independent — and each states where replies actually go, following
 * the §8.3 precedence (call site, then the identity's Reply-To, then none).
 */
export default function SenderIdentitiesForm({
  domains, identities, inbound, busy, onSave, onClear,
}: SenderIdentitiesFormProps) {
  const { t } = useTranslation('settings');
  const targets = sendableDomains(domains);

  return (
    <section className="rounded-lg border p-4" data-testid="sending-domains-identities">
      <h3 className="mb-1 text-sm font-semibold">{t('partnerSendingDomains.identitiesTitle')}</h3>
      <p className="text-xs text-muted-foreground">{t('partnerSendingDomains.identitiesDescription')}</p>

      {targets.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="sending-domains-identities-empty">
          {t('partnerSendingDomains.identitiesNoDomain')}
        </p>
      ) : (
        <>
          <p className="mt-2 text-xs text-muted-foreground">{t('partnerSendingDomains.repliesMailboxHint')}</p>
          {SENDING_DOMAIN_STREAMS.map((stream) => {
            const existing = identities.find((i) => i.stream === stream);
            return (
              <StreamRow
                // Remount when the saved identity changes so the inputs re-seed
                // from the server's normalised values after a save.
                key={`${stream}-${existing?.updatedAt ?? 'none'}`}
                stream={stream}
                targets={targets}
                existing={existing}
                inbound={inbound}
                busy={busy}
                onSave={onSave}
                onClear={onClear}
              />
            );
          })}
        </>
      )}
    </section>
  );
}
