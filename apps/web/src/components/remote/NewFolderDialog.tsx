import { useEffect, useState, type FormEvent } from 'react';
import { FolderPlus, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../shared/Dialog';
import { validateFolderName } from './filePathUtils';
import '@/lib/i18n';

type NewFolderDialogProps = {
  open: boolean;
  parentPath: string;
  existingNames: string[];
  osType?: string;
  busy: boolean;
  onSubmit: (name: string) => void;
  onClose: () => void;
};

export default function NewFolderDialog({
  open,
  parentPath,
  existingNames,
  osType,
  busy,
  onSubmit,
  onClose,
}: NewFolderDialogProps) {
  const { t } = useTranslation('remote');
  const [name, setName] = useState('');

  useEffect(() => {
    if (open) setName('');
  }, [open]);

  const trimmed = name.trim();
  const problem = trimmed ? validateFolderName(trimmed, parentPath, existingNames, osType) : null;
  const canSubmit = trimmed !== '' && problem === null && !busy;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) onSubmit(trimmed);
  };

  const title = t('fileManager.newFolder.title');

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      maxWidth="md"
      className="p-6"
    >
      <form onSubmit={handleSubmit} data-testid="new-folder-form">
        <div className="flex items-center gap-2">
          <FolderPlus className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">{title}</h2>
        </div>

        <label htmlFor="new-folder-name" className="mt-4 block text-sm font-medium">
          {t('fileManager.newFolder.nameLabel')}
        </label>
        <input
          id="new-folder-name"
          data-testid="new-folder-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={255}
          autoComplete="off"
          aria-invalid={problem !== null}
          aria-describedby={problem ? 'new-folder-error' : undefined}
          className="mt-1.5 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <p className="mt-1.5 break-all text-xs text-muted-foreground">
          {t('fileManager.newFolder.location', { path: parentPath })}
        </p>
        {problem && (
          <p
            id="new-folder-error"
            data-testid="new-folder-error"
            role="alert"
            className="mt-1.5 text-xs text-destructive"
          >
            {problem === 'exists'
              ? t('fileManager.newFolder.nameExists')
              : t('fileManager.newFolder.invalidName')}
          </p>
        )}

        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="submit"
            data-testid="new-folder-submit"
            disabled={!canSubmit}
            className="flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('common:actions.create')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
