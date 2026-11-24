// The device's tags, edited in place on the Details tab — the only place a
// single device's tags are edited. Always rendered, so a device with no tags
// can get its first one.
import { useState } from 'react';
import { Loader2, Pencil, Plus, Tag, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '@/lib/runAction';

/** Tags are stored lowercased and trimmed; adding one that exists is a no-op. */
export function addTag(tags: readonly string[], raw: string): string[] {
  const tag = raw.trim().toLowerCase();
  return tag && !tags.includes(tag) ? [...tags, tag] : [...tags];
}

export default function DeviceTagsCard({
  deviceId,
  tags,
  onSaved,
}: {
  deviceId: string;
  tags: string[];
  /** Called with the saved list once the PATCH succeeds. */
  onSaved: (tags: string[]) => void;
}) {
  const { t } = useTranslation(['devices', 'common']);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(tags);
  const [newTag, setNewTag] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEditing = () => {
    setDraft(tags);
    setNewTag('');
    setError(null);
    setEditing(true);
  };

  const commitNewTag = () => {
    setDraft((d) => addTag(d, newTag));
    setNewTag('');
  };

  const save = async () => {
    // A tag typed but not yet added is still meant to be saved.
    const next = addTag(draft, newTag);
    if (JSON.stringify(next) === JSON.stringify(tags)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/devices/${deviceId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags: next }),
          }),
        errorFallback: t('deviceInfoTab.tagsSaveFailed'),
        successMessage: t('deviceInfoTab.tagsSaved'),
      });
      onSaved(next);
      setEditing(false);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      setError(err instanceof Error ? err.message : t('deviceInfoTab.tagsSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="device-tags" aria-labelledby="device-tags-title" className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="mb-4 flex items-center gap-2">
        <Tag className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h2 id="device-tags-title" className="text-sm font-semibold">{t('deviceInfoTab.tags')}</h2>
        {!editing && (
          <button
            type="button"
            onClick={startEditing}
            aria-label={t('deviceInfoTab.editTags')}
            title={t('deviceInfoTab.editTags')}
            className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {!editing ? (
        tags.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <li key={tag} className="inline-flex items-center rounded-full border bg-muted/40 px-3 py-1 text-xs font-medium text-foreground">
                {tag}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('deviceInfoTab.noTags')}</p>
        )
      ) : (
        <div className="space-y-3">
          {draft.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {draft.map((tag) => (
                <li key={tag} className="inline-flex items-center gap-1 rounded-full border bg-muted/40 py-0.5 pl-3 pr-1 text-xs font-medium text-foreground">
                  {tag}
                  <button
                    type="button"
                    onClick={() => setDraft((d) => d.filter((x) => x !== tag))}
                    aria-label={t('deviceInfoTab.removeTag', { tag })}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitNewTag();
                }
                if (e.key === 'Escape') setEditing(false);
              }}
              aria-label={t('deviceInfoTab.addTag')}
              placeholder={t('deviceInfoTab.addTag')}
              maxLength={100}
              autoFocus
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
            <button
              type="button"
              onClick={commitNewTag}
              disabled={!newTag.trim()}
              className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('common:actions.add')}
            </button>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="h-8 rounded-md border px-3 text-sm text-muted-foreground hover:text-foreground disabled:opacity-60"
            >
              {t('deviceInfoTab.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('deviceInfoTab.save')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
