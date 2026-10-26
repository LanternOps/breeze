import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '@/stores/auth';
import type { WispState } from '@/stores/aiStore';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import { formatBytes, formatSafeDate } from '@/lib/utils';

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = '.txt,.csv,.tsv,.eml,.json,text/plain,text/csv,message/rfc822,application/json';

type ThreadAttachment = { id: string; label: string; bytes: number; expiresAt: string };

function parseItems(body: unknown): ThreadAttachment[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data.filter((x): x is ThreadAttachment => {
    const r = x as Partial<ThreadAttachment> | null;
    return !!r && typeof r.id === 'string' && typeof r.label === 'string'
      && typeof r.bytes === 'number' && typeof r.expiresAt === 'string';
  });
}

export default function WispThreadAttachments({ wisp }: { wisp: NonNullable<WispState> }) {
  const { t } = useTranslation('ai');
  const [items, setItems] = useState<ThreadAttachment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [text, setText] = useState('');
  const [label, setLabel] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const disabled = wisp.scopeOrgId === null && wisp.focusOrgId === null;

  // Only the newest load may commit: a slow response for a previous thread
  // (or one that lands after unmount) must not overwrite the current list.
  const loadToken = useRef(0);
  const load = useCallback(async () => {
    const token = ++loadToken.current;
    try {
      const res = await fetchWithAuth(`/wisp/thread/${wisp.threadId}/attachments`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const next = parseItems(await res.json());
      if (token !== loadToken.current) return;
      setItems(next);
      setLoadFailed(false);
    } catch {
      if (token === loadToken.current) setLoadFailed(true);
    } finally {
      if (token === loadToken.current) setLoaded(true);
    }
  }, [wisp.threadId]);

  useEffect(() => {
    setLoaded(false);
    void load();
    return () => { loadToken.current++; };
  }, [load]);

  const post = async (body: FormData | string, onDone?: () => void) => {
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/wisp/thread/${wisp.threadId}/attachments`, { method: 'POST', body }),
        errorFallback: t('wisp.toast.attachFailed'),
        successMessage: t('wisp.toast.attached'),
        friendly: (code) => code === 'too_large' ? t('wisp.toast.attachTooLarge')
          : code === 'unsupported_type' ? t('wisp.toast.attachUnsupported')
          : code === 'focus_required' ? t('wisp.attachments.focusRequired') : undefined,
      });
      onDone?.();
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('wisp.toast.attachFailed') });
    } finally {
      setBusy(false);
    }
  };

  const uploadFile = (file: File | undefined) => {
    if (!file || disabled || busy) return;
    if (file.size > MAX_BYTES) {
      showToast({ type: 'error', message: t('wisp.toast.attachTooLarge') });
      return;
    }
    const form = new FormData();
    form.append('file', file);
    if (label.trim()) form.append('label', label.trim());
    void post(form, () => setLabel(''));
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    uploadFile(e.dataTransfer?.files?.[0]);
  };

  const addPasted = () => {
    if (disabled || busy || !text.trim()) return;
    void post(JSON.stringify({ text, label: label.trim() || t('wisp.attachments.paste') }), () => { setText(''); setLabel(''); });
  };

  return (
    <div className="space-y-2 text-xs" data-testid="wisp-attachments">
      <div className="font-medium">{t('wisp.attachments.title')}</div>
      {loadFailed ? (
        <p className="text-destructive" data-testid="wisp-attachments-load-error">{t('wisp.attachments.loadFailed')}</p>
      ) : loaded && items.length === 0 ? (
        <p className="text-muted-foreground" data-testid="wisp-attachments-empty">{t('wisp.attachments.empty')}</p>
      ) : (
        <ul className="space-y-1" data-testid="wisp-attachments-list">
          {items.map((a) => (
            <li key={a.id} className="rounded border px-2 py-1" data-testid="wisp-attachment-item">
              <span className="font-medium">{a.label}</span>
              <span className="ml-2 text-muted-foreground">{formatBytes(a.bytes)}</span>
              <span className="ml-2 text-muted-foreground">{t('wisp.attachments.expires', { date: formatSafeDate(a.expiresAt) })}</span>
            </li>
          ))}
        </ul>
      )}
      {disabled && (
        <p className="text-muted-foreground" data-testid="wisp-attachments-focus-required">{t('wisp.attachments.focusRequired')}</p>
      )}
      <div
        data-testid="wisp-attachment-drop"
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        onClick={() => { if (!disabled) fileRef.current?.click(); }}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileRef.current?.click(); }
        }}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        className={`rounded border border-dashed px-3 py-3 text-center text-muted-foreground ${
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${dragActive ? 'border-primary bg-primary/5' : ''}`}
      >
        {t('wisp.attachments.drop')}
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          disabled={disabled}
          data-testid="wisp-attachment-file"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => { uploadFile(e.target.files?.[0]); e.target.value = ''; }}
        />
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
        rows={3}
        placeholder={t('wisp.attachments.paste')}
        data-testid="wisp-attachment-paste"
        className="w-full rounded border bg-background px-2 py-1 disabled:opacity-50"
      />
      <div className="flex gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={disabled}
          placeholder={t('wisp.attachments.label')}
          maxLength={200}
          data-testid="wisp-attachment-label"
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={addPasted}
          disabled={disabled || busy || !text.trim()}
          data-testid="wisp-attachment-add"
          className="rounded border px-3 py-1 font-medium disabled:opacity-50"
        >
          {t('wisp.attachments.add')}
        </button>
      </div>
      <p className="text-muted-foreground">{t('wisp.attachments.limits')}</p>
    </div>
  );
}
