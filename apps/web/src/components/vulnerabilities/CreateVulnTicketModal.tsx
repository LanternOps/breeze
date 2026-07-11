import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { VULN_TICKET_PRIORITIES, type VulnTicketPriority } from '@breeze/shared';
import '@/lib/i18n';

import { Dialog } from '../shared/Dialog';
import type { GroupFinding } from '../../lib/api/vulnerabilities';

const BTN =
  'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50';

const INPUT =
  'mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary';

export function CreateVulnTicketModal({
  findings,
  defaultTitle,
  busy,
  onCancel,
  onSubmit,
}: {
  findings: GroupFinding[];
  defaultTitle: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: { title: string; priority: VulnTicketPriority; note: string }) => void;
}) {
  const { t } = useTranslation('vulnerabilities');
  const [title, setTitle] = useState(defaultTitle);
  const [note, setNote] = useState('');
  const [priority, setPriority] = useState<VulnTicketPriority>('normal');
  const titleId = useId();

  const orgCount = useMemo(() => new Set(findings.map((f) => f.orgId)).size, [findings]);

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onCancel();
      }}
      title={t('createVulnTicketModal.title')}
      labelledBy={titleId}
      maxWidth="md"
      className="p-5"
    >
      <div data-testid="vuln-ticket-modal">
        <h3 id={titleId} className="text-base font-semibold">
          {t('createVulnTicketModal.heading', { count: findings.length })}
        </h3>
        {orgCount > 1 && (
          <p data-testid="vuln-ticket-cross-org-note" className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            {t('createVulnTicketModal.crossOrgNote', { count: orgCount })}
          </p>
        )}
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('createVulnTicketModal.fields.title')}</span>
            <input
              data-testid="vuln-ticket-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={255}
              className={INPUT}
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('createVulnTicketModal.fields.note')}</span>
            <textarea
              data-testid="vuln-ticket-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              placeholder={t('createVulnTicketModal.fields.notePlaceholder')}
              className={INPUT}
            />
          </label>
          {/* The affected devices and CVEs are enumerated server-side, scoped to
              each organization, so a cross-org selection never leaks one org's
              device/CVE list into another org's ticket. */}
          <p data-testid="vuln-ticket-auto-detail-note" className="text-xs text-muted-foreground">
            {t('createVulnTicketModal.autoDetailNote')}
          </p>
          <label className="block text-sm">
            <span className="text-muted-foreground">{t('createVulnTicketModal.fields.priority')}</span>
            <select
              data-testid="vuln-ticket-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as VulnTicketPriority)}
              className={INPUT}
            >
              {VULN_TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>{t(`createVulnTicketModal.priorities.${p}`)}{/* i18n-dynamic */}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" data-testid="vuln-ticket-cancel" className={`${BTN} hover:bg-muted`} onClick={onCancel} disabled={busy}>
            {t('common:actions.cancel')}
          </button>
          <button
            type="button"
            data-testid="vuln-ticket-submit"
            className={`${BTN} bg-primary text-primary-foreground hover:bg-primary/90`}
            disabled={busy || title.trim().length === 0}
            onClick={() => onSubmit({ title: title.trim(), priority, note: note.trim() })}
          >
            {t('createVulnTicketModal.actions.create')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export default CreateVulnTicketModal;
