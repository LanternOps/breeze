import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Info, Loader2 } from 'lucide-react';
import { i18n } from '@/lib/i18n';
import { ActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { Dialog } from '../../shared/Dialog';
import { showToast } from '../../shared/Toast';
import PolicyLinkSelector from '../featureTabs/PolicyLinkSelector';
import { eligibleParentsUrl } from '../ConfigPolicyCreatePage';
import { configFeatureLabel } from '../configPolicyLabels';
import { offersMspOwner, offersOrgChoice, type CreatorKind, type OwnerChoice } from './policyOwner';
import { copyPolicy, previewCopy, type CopyBody, type CopyNotice, type CopyPreview } from './copyPolicyApi';

export type CopySource = {
  id: string;
  name: string;
  /** null = MSP-managed. */
  orgId: string | null;
  parentPolicyId: string | null;
};

type CopyPolicyDialogProps = {
  open: boolean;
  onClose: () => void;
  source: CopySource;
  /** The organizations the caller can access (org switcher's list). */
  organizations: { id: string; name: string }[];
  currentOrgId: string | null;
  creator: CreatorKind;
  /**
   * Start at one organization rather than the source's owner: the way out
   * for OneDrive Helper on an MSP-managed policy (plan D17).
   */
  initialOwner?: 'organization';
};

const MSP_VALUE = '__msp__';

function initialOwnerFor(props: CopyPolicyDialogProps): OwnerChoice {
  const { source, creator, currentOrgId, organizations, initialOwner } = props;
  if (creator === 'org') return { kind: 'org', orgId: currentOrgId };
  if (initialOwner === 'organization') {
    return { kind: 'org', orgId: source.orgId ?? currentOrgId ?? organizations[0]?.id ?? null };
  }
  if (source.orgId) return { kind: 'org', orgId: source.orgId };
  return offersMspOwner(creator) ? { kind: 'msp' } : { kind: 'org', orgId: currentOrgId };
}

const sameOwnerAsSource = (owner: OwnerChoice, source: CopySource) =>
  owner.kind === 'msp' ? source.orgId === null : owner.orgId === source.orgId;

function bodyFor(name: string, owner: OwnerChoice, parentPolicyId: string | null): CopyBody | null {
  if (owner.kind === 'msp') return { name, ownerScope: 'partner', parentPolicyId };
  if (!owner.orgId) return null;
  return { name, ownerScope: 'organization', orgId: owner.orgId, parentPolicyId };
}

/** `key` is the owner and parent the dry run was for. */
type PreviewState = { status: 'idle' } | { status: 'loading' } | { status: 'done'; key: string; result: CopyPreview };

/**
 * Copy a policy (#12309, #11776; plan W05b K3), to the same owner or to
 * another organization or the MSP. A dry run first lists what the copy
 * carries and what it leaves behind, with the reason; only then can the user
 * copy. The copy starts inactive and applies nowhere, and the user lands on it.
 * UX only: the server re-checks the owner, the parent and every gate.
 */
export default function CopyPolicyDialog(props: CopyPolicyDialogProps) {
  const { open, onClose, source, organizations, creator } = props;
  useTranslation(['policies', 'common']);
  const titleId = useId();
  const [name, setName] = useState(() => i18n.t('policies:configurationPolicies.copyPolicy.defaultName', { name: source.name }));
  const [owner, setOwner] = useState<OwnerChoice>(() => initialOwnerFor(props));
  // A parent valid for one owner is not valid for another: the source's parent
  // is kept only while the owner is the source's.
  const [parentId, setParentId] = useState<string | null>(() =>
    sameOwnerAsSource(initialOwnerFor(props), source) ? source.parentPolicyId : null,
  );
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const [copying, setCopying] = useState(false);
  const nameRef = useRef(name);
  nameRef.current = name;
  const previewSeq = useRef(0);

  const trimmed = name.trim();
  const body = bodyFor(trimmed, owner, parentId);
  const ownerKey = owner.kind === 'msp' ? MSP_VALUE : (owner.orgId ?? '');
  const previewKey = `${ownerKey}|${parentId ?? ''}`;

  // The dry run follows the owner and the parent, which decide what can be
  // carried. The name does not, so typing does not re-run it.
  useEffect(() => {
    if (!open) return;
    const draft = bodyFor(nameRef.current.trim() || source.name, owner, parentId);
    const seq = ++previewSeq.current;
    if (!draft) {
      setPreview({ status: 'idle' });
      return;
    }
    setPreview({ status: 'loading' });
    const key = previewKey;
    void previewCopy(source.id, draft).then((result) => {
      if (seq === previewSeq.current) setPreview({ status: 'done', key, result });
    });
    // `ownerKey` stands for `owner`: the same owner as a new object must not re-run it.
  }, [open, source.id, source.name, ownerKey, parentId]);

  const changeOwner = (value: string) => {
    const next: OwnerChoice = value === MSP_VALUE ? { kind: 'msp' } : { kind: 'org', orgId: value || null };
    setOwner(next);
    setParentId(sameOwnerAsSource(next, source) ? source.parentPolicyId : null);
  };

  // Only the dry run for the owner and parent now chosen can enable Copy.
  const ready = preview.status === 'done' && preview.key === previewKey && preview.result.ok
    && !!body && trimmed.length > 0 && !copying;

  const confirm = async () => {
    if (!ready || !body) return;
    setCopying(true);
    try {
      const { policyId, dropped, notices } = await copyPolicy(source.id, body);
      // The real run decides again: say so if it left behind more than the
      // dry run showed (something changed in between).
      const shownPreview = preview.status === 'done' && preview.result.ok ? preview.result : null;
      const shown = new Set(shownPreview ? shownPreview.dropped.map((d) => d.featureType) : []);
      const unexpected = dropped.filter((d) => !shown.has(d.featureType));
      if (unexpected.length > 0) {
        showToast({
          type: 'warning',
          message: i18n.t('policies:configurationPolicies.copyPolicy.droppedSincePreview', {
            features: unexpected.map((d) => configFeatureLabel(d.featureType)).join(', '),
          }),
        });
      }
      // The same for a notice, in the dialog's own words.
      const noticed = new Set(shownPreview ? shownPreview.notices.map((n) => `${n.featureType}:${n.code}`) : []);
      for (const notice of notices.filter((n) => !noticed.has(`${n.featureType}:${n.code}`))) {
        showToast({ type: 'warning', message: `${configFeatureLabel(notice.featureType)}: ${noticeText(notice)}` });
      }
      onClose();
      void navigateTo(`/configuration-policies/${policyId}`);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: i18n.t('policies:configurationPolicies.copyPolicy.failed') });
    } finally {
      setCopying(false);
    }
  };

  const ownerOrgName = owner.kind === 'org' && owner.orgId
    ? (organizations.find((o) => o.id === owner.orgId)?.name ?? null)
    : null;
  const parentsUrl = eligibleParentsUrl(owner.kind === 'msp' ? { kind: 'msp' } : { kind: 'org', orgId: owner.orgId });

  return (
    <Dialog open={open} onClose={onClose} title={i18n.t('policies:configurationPolicies.copyPolicy.title')} labelledBy={titleId} maxWidth="xl" className="p-6">
      <div className="space-y-4" data-testid="config-policy-copy-dialog">
        <div>
          <h2 id={titleId} className="text-lg font-semibold">{i18n.t('policies:configurationPolicies.copyPolicy.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{i18n.t('policies:configurationPolicies.copyPolicy.startsInactive')}</p>
        </div>

        <div>
          <label htmlFor="config-policy-copy-name" className="text-sm font-medium">{i18n.t('common:labels.name')}</label>
          <input
            id="config-policy-copy-name"
            data-testid="config-policy-copy-name"
            value={name}
            maxLength={255}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={trimmed.length === 0 ? true : undefined}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="space-y-1">
          {offersOrgChoice(creator) ? (
            <>
              <label htmlFor="config-policy-copy-owner" className="text-sm font-medium">
                {i18n.t('policies:configurationPolicies.policyCreate.managedByLabel')}
              </label>
              <select
                id="config-policy-copy-owner"
                data-testid="config-policy-copy-owner"
                value={ownerKey}
                onChange={(e) => changeOwner(e.target.value)}
                className="block h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                {offersMspOwner(creator) ? (
                  <option value={MSP_VALUE}>{i18n.t('policies:configurationPolicies.policyCreate.managedByMspOption')}</option>
                ) : (
                  <option value="">{i18n.t('policies:configurationPolicies.policyCreate.chooseOrganizationOption')}</option>
                )}
                {organizations.map((org) => (
                  <option key={org.id} value={org.id}>{org.name}</option>
                ))}
              </select>
            </>
          ) : (
            <p className="text-sm" data-testid="config-policy-copy-owner-fixed">
              {ownerOrgName
                ? i18n.t('policies:configurationPolicies.policyCreate.managedByOrganization', { organization: ownerOrgName })
                : i18n.t('policies:configurationPolicies.policyCreate.managedByOwnOrgFallback')}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <p className="text-sm font-medium">{i18n.t('policies:configurationPolicies.policyCreate.startFromParent')}</p>
          {parentsUrl ? (
            <PolicyLinkSelector
              key={parentsUrl}
              fetchUrl={parentsUrl}
              selectedId={parentId}
              excludeId={source.id}
              onSelect={setParentId}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {i18n.t('policies:configurationPolicies.policyCreate.parentNeedsOrganization')}
            </p>
          )}
        </div>

        <CopyPreviewPanel preview={preview} needsOrganization={!body && owner.kind === 'org'} />

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
          >
            {i18n.t('common:actions.cancel')}
          </button>
          <button
            type="button"
            data-testid="config-policy-copy-confirm"
            disabled={!ready}
            onClick={() => void confirm()}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {copying ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
            {copying ? i18n.t('policies:configurationPolicies.copyPolicy.copying') : i18n.t('policies:configurationPolicies.copyPolicy.confirm')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function CopyPreviewPanel({ preview, needsOrganization }: { preview: PreviewState; needsOrganization: boolean }) {
  if (needsOrganization) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="config-policy-copy-needs-org">
        {i18n.t('policies:configurationPolicies.policyCreate.organizationRequired')}
      </p>
    );
  }
  if (preview.status !== 'done') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="config-policy-copy-checking">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {i18n.t('policies:configurationPolicies.copyPolicy.checking')}
      </p>
    );
  }
  const { result } = preview;
  if (!result.ok) {
    return (
      <p role="alert" data-testid="config-policy-copy-preview-error" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {result.message}
      </p>
    );
  }
  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
      <div data-testid="config-policy-copy-carried">
        <p className="font-medium">{i18n.t('policies:configurationPolicies.copyPolicy.carriedHeading')}</p>
        <p className="mt-0.5 text-muted-foreground">
          {result.carried.length > 0
            ? result.carried.map((ft) => configFeatureLabel(ft)).join(', ')
            : i18n.t('policies:configurationPolicies.copyPolicy.carriedNone')}
        </p>
      </div>
      {result.dropped.length > 0 && (
        <div data-testid="config-policy-copy-dropped">
          <p className="flex items-center gap-1.5 font-medium text-warning">
            <Info className="h-4 w-4" aria-hidden="true" />
            {i18n.t('policies:configurationPolicies.copyPolicy.droppedHeading')}
          </p>
          <ul className="mt-1 space-y-1">
            {result.dropped.map((drop) => (
              <li key={drop.featureType}>
                <span className="font-medium">{configFeatureLabel(drop.featureType)}</span>
                {': '}
                <span className="text-muted-foreground">
                  {i18n.t(/* i18n-dynamic */ `policies:configurationPolicies.copyPolicy.reasons.${drop.reason}`)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.notices.length > 0 && (
        <div data-testid="config-policy-copy-notices">
          <p className="flex items-center gap-1.5 font-medium text-warning">
            <Info className="h-4 w-4" aria-hidden="true" />
            {i18n.t('policies:configurationPolicies.copyPolicy.noticesHeading')}
          </p>
          <ul className="mt-1 space-y-1">
            {result.notices.map((notice) => (
              <li key={`${notice.featureType}:${notice.code}`}>
                <span className="font-medium">{configFeatureLabel(notice.featureType)}</span>
                {': '}
                <span className="text-muted-foreground">{noticeText(notice)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One text per notice code, shown by the dry run and by the real copy alike. */
function noticeText(notice: CopyNotice): string {
  return i18n.t(/* i18n-dynamic */ `policies:configurationPolicies.copyPolicy.notices.${notice.code}`);
}
