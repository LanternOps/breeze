import React, { useState } from 'react';
import { TELEMETRY_CONTROL_IDS, type TelemetryControlId } from '@breeze/shared';
import { withBase } from '@/lib/basePath';
import {
  changedTrustDraftFields,
  trustEditorApi,
  type PortalTrustDraftFields,
  type PortalTrustPageDraft,
} from '@/lib/trustEditorApi';
import { BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, CHECKBOX, INPUT, LINK, Notice, type MarkTone } from '@/components/portal/ui';
import { controlCopy } from './trustPageFormat';

/**
 * Trust Center W3d: the customer org admin's editor for part of the trust page
 * draft. Five fields, a preview and a withdrawal. There is deliberately no
 * Publish: the MSP publishes (with MFA and the customer's attestation), so a
 * saved change reaches the public page only on the MSP's next publish.
 */

type Message = { tone: MarkTone; text: string; testId: string };

const fieldsOf = (p: PortalTrustPageDraft): PortalTrustDraftFields => ({
  securityContactEmail: p.securityContactEmail,
  websiteUrl: p.websiteUrl,
  hiddenControlIds: [...p.hiddenControlIds],
  showPercentages: p.showPercentages,
  showDeviceCount: p.showDeviceCount,
});

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

export function TrustPageEditor({ initialPage, orgName }: { initialPage: PortalTrustPageDraft; orgName: string }) {
  const [loaded, setLoaded] = useState<PortalTrustPageDraft>(initialPage);
  const [form, setForm] = useState<PortalTrustDraftFields>(() => fieldsOf(initialPage));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');

  const adopt = (page: PortalTrustPageDraft) => {
    setLoaded(page);
    setForm(fieldsOf(page));
  };
  const update = (patch: Partial<PortalTrustDraftFields>) => setForm((f) => ({ ...f, ...patch }));
  const toggleHidden = (id: TelemetryControlId, hidden: boolean) =>
    update({ hiddenControlIds: hidden ? [...form.hiddenControlIds.filter((x) => x !== id), id] : form.hiddenControlIds.filter((x) => x !== id) });

  const save = async () => {
    if (busy) return;
    const changes = changedTrustDraftFields(fieldsOf(loaded), form);
    if (Object.keys(changes).length === 0) {
      setMessage({ tone: 'neutral', text: 'No changes to save.', testId: 'trust-editor-nochange' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await trustEditorApi.save({ expectedRevision: loaded.publicationRevision, ...changes });
      if (res.statusCode === 409) {
        // Someone (usually the provider) saved or published since this page loaded: show their version.
        const fresh = await trustEditorApi.get();
        if (fresh.data?.data.page) adopt(fresh.data.data.page);
        setMessage({ tone: 'warning', text: 'Your provider changed this page; review and save again.', testId: 'trust-editor-conflict' });
        return;
      }
      const page = res.data?.data.page;
      if (page) {
        adopt(page);
        setMessage({ tone: 'success', text: 'Saved. The public page shows these changes once your provider publishes them.', testId: 'trust-editor-saved' });
        return;
      }
      setMessage({ tone: 'destructive', text: res.error ?? 'We could not save your changes. Try again in a moment.', testId: 'trust-editor-error' });
    } finally {
      setBusy(false);
    }
  };

  const preview = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await trustEditorApi.previewToken();
      const path = res.data?.data.previewPath;
      if (!path) {
        setMessage({ tone: 'destructive', text: res.error ?? 'We could not open a preview. Try again in a moment.', testId: 'trust-editor-error' });
        return;
      }
      const url = withBase(path);
      setPreviewPath(url);
      globalThis.open?.(url, '_blank', 'noopener,noreferrer');
    } finally {
      setBusy(false);
    }
  };

  const nameMatches = confirmName.trim() === orgName.trim() && orgName.trim() !== '';
  const unpublish = async () => {
    if (busy || !nameMatches) return;
    setBusy(true);
    try {
      const res = await trustEditorApi.unpublish();
      const page = res.data?.data.page;
      if (page) {
        adopt(page);
        setConfirmOpen(false);
        setConfirmName('');
        setMessage({ tone: 'success', text: 'Withdrawn. Your trust page is not published any more; your provider can publish it again.', testId: 'trust-editor-withdrawn' });
        return;
      }
      setMessage({ tone: 'destructive', text: res.error ?? 'We could not withdraw the page. Try again in a moment.', testId: 'trust-editor-error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8" data-testid="trust-page-editor">
      <section className="space-y-2 text-sm text-muted-foreground">
        <p>
          Your provider publishes your changes. What you save here is a draft: the public trust page shows it after your provider
          reviews and publishes it.
        </p>
        <p data-testid="trust-editor-status">
          {loaded.publishedAt ? (
            <>
              Status: published on {formatDate(loaded.publishedAt)}.{' '}
              {loaded.publicPath && (
                <a className={LINK} href={withBase(loaded.publicPath)} target="_blank" rel="noopener noreferrer" data-testid="trust-editor-public-link">
                  View the public page
                </a>
              )}
            </>
          ) : (
            'Status: not public.'
          )}
        </p>
      </section>

      {message && <Notice tone={message.tone} data-testid={message.testId}>{message.text}</Notice>}

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-foreground">Contact details</h2>
        <div>
          <label htmlFor="trust-editor-email" className="text-sm font-medium text-foreground">Security contact email</label>
          <input
            id="trust-editor-email"
            type="email"
            maxLength={320}
            className={INPUT}
            value={form.securityContactEmail ?? ''}
            onChange={(e) => update({ securityContactEmail: e.target.value })}
            data-testid="trust-editor-email"
          />
        </div>
        <div>
          <label htmlFor="trust-editor-website" className="text-sm font-medium text-foreground">Website</label>
          <input
            id="trust-editor-website"
            type="url"
            placeholder="https://"
            className={INPUT}
            value={form.websiteUrl ?? ''}
            onChange={(e) => update({ websiteUrl: e.target.value })}
            data-testid="trust-editor-website"
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">What the page shows</h2>
        <label className="flex items-start gap-3 text-sm text-foreground">
          <input
            type="checkbox"
            className={CHECKBOX}
            checked={form.showPercentages}
            onChange={(e) => update({ showPercentages: e.target.checked })}
            data-testid="trust-editor-show-percentages"
          />
          <span>Show coverage percentages</span>
        </label>
        <label className="flex items-start gap-3 text-sm text-foreground">
          <input
            type="checkbox"
            className={CHECKBOX}
            checked={form.showDeviceCount}
            onChange={(e) => update({ showDeviceCount: e.target.checked })}
            data-testid="trust-editor-show-device-count"
          />
          <span>Show the number of devices</span>
        </label>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Hidden controls</h2>
        <p className="text-sm text-muted-foreground">A hidden control does not appear on the public page.</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {TELEMETRY_CONTROL_IDS.map((id) => (
            <li key={id}>
              <label className="flex items-start gap-3 text-sm text-foreground">
                <input
                  type="checkbox"
                  className={CHECKBOX}
                  checked={form.hiddenControlIds.includes(id)}
                  onChange={(e) => toggleHidden(id, e.target.checked)}
                  data-testid={`trust-editor-hide-${id}`}
                />
                <span>Hide “{controlCopy(id).title}”</span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={BTN_PRIMARY} onClick={() => void save()} disabled={busy} data-testid="trust-editor-save">
          Save changes
        </button>
        <button type="button" className={BTN_SECONDARY} onClick={() => void preview()} disabled={busy} data-testid="trust-editor-preview">
          Preview
        </button>
        {previewPath && (
          <a className={LINK} href={previewPath} target="_blank" rel="noopener noreferrer" data-testid="trust-editor-preview-link">
            Open the preview
          </a>
        )}
      </div>

      {loaded.publishedAt && (
        <section className="space-y-3 border-t border-border pt-6">
          <h2 className="text-lg font-semibold text-foreground">Withdraw the page</h2>
          <p className="text-sm text-muted-foreground">
            Unpublishing takes the public page down at once. Only your provider can publish it again.
          </p>
          {!confirmOpen ? (
            <button type="button" className={BTN_SECONDARY} onClick={() => setConfirmOpen(true)} disabled={busy} data-testid="trust-editor-unpublish">
              Unpublish this page
            </button>
          ) : (
            <div className="space-y-3">
              <label htmlFor="trust-editor-unpublish-name" className="block text-sm font-medium text-foreground">
                Type {orgName} to confirm
              </label>
              <input
                id="trust-editor-unpublish-name"
                className={INPUT}
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                autoComplete="off"
                data-testid="trust-editor-unpublish-name"
              />
              <div className="flex flex-wrap gap-3">
                <button type="button" className={BTN_DANGER} onClick={() => void unpublish()} disabled={busy || !nameMatches} data-testid="trust-editor-unpublish-confirm">
                  Unpublish now
                </button>
                <button
                  type="button"
                  className={BTN_SECONDARY}
                  onClick={() => { setConfirmOpen(false); setConfirmName(''); }}
                  data-testid="trust-editor-unpublish-cancel"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
