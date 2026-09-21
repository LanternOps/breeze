import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { promoteScriptProposal } from '@/lib/api/scriptProposals';
import { ActionError } from '@/lib/runAction';

export interface SaveProposalToLibraryDialogProps {
  proposalId: string;
  goal: string;
  onClose: () => void;
  onPromoted?: (scriptId: string) => void;
}

/**
 * Promotes a verified proposal into the script library. `ownerScope` is a
 * CREATE-ONLY selector (CLAUDE.md partner-wide playbook, step 2): chosen once
 * here and never editable on the resulting script afterwards.
 */
export default function SaveProposalToLibraryDialog({
  proposalId,
  goal,
  onClose,
  onPromoted,
}: SaveProposalToLibraryDialogProps) {
  const { t } = useTranslation(['ai', 'common']);
  const [name, setName] = useState(goal);
  const [description, setDescription] = useState('');
  const [ownerScope, setOwnerScope] = useState<'organization' | 'partner'>('organization');
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t('ai:scriptProposal.nameRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const result = await promoteScriptProposal(proposalId, {
        name: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        ownerScope,
      });
      onPromoted?.(result.scriptId);
      onClose();
    } catch (err) {
      // 401 lets the auth redirect handle it; a non-401 ActionError was
      // already toasted by runAction, and the dialog STAYS OPEN so the user
      // can correct the name or the scope rather than losing their input.
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) setNameError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/20 p-3" role="dialog" aria-label={t('ai:scriptProposal.saveToLibrary')}>
      <div className="space-y-2">
        <label className="block text-sm font-medium" htmlFor="promote-name">
          {t('common:labels.name')}
        </label>
        <input
          id="promote-name"
          data-testid="promote-name-input"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameError(null);
          }}
        />
        {nameError && (
          <p data-testid="promote-name-error" className="text-xs text-destructive">
            {nameError}
          </p>
        )}

        <label className="block text-sm font-medium" htmlFor="promote-description">
          {t('ai:scriptProposal.promoteDescription')}
        </label>
        <textarea
          id="promote-description"
          data-testid="promote-description-input"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <fieldset className="space-y-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="promote-owner-scope"
              value="organization"
              checked={ownerScope === 'organization'}
              onChange={() => setOwnerScope('organization')}
              data-testid="promote-owner-scope-organization"
            />
            {t('ai:scriptProposal.ownerScopeOrganization')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="promote-owner-scope"
              value="partner"
              checked={ownerScope === 'partner'}
              onChange={() => setOwnerScope('partner')}
              data-testid="promote-owner-scope-partner"
            />
            {t('ai:scriptProposal.ownerScopePartner')}
          </label>
        </fieldset>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="button"
            data-testid="promote-submit"
            disabled={submitting}
            onClick={() => void submit()}
            className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50"
          >
            {t('common:actions.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
