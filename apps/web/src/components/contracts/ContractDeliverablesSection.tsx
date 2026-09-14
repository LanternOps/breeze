import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import type { Deliverable } from '../../lib/api/serviceDeliverables';
import DeliverableForm from '../deliverables/DeliverableForm';
import DeliverableTable from '../deliverables/DeliverableTable';
import OccurrenceDrawer from '../deliverables/OccurrenceDrawer';
import ApplyTemplateModal from '../deliverables/ApplyTemplateModal';
import { Dialog } from '../shared/Dialog';

interface Props {
  contractId: string;
  orgId: string;
}

/**
 * Service deliverables owed under one contract (feature #5573 W01): the
 * recurring reports and reviews the customer is entitled to, with their
 * occurrence history in a drawer. The org record's Service tab shows the same
 * table across every contract of the org; this section pins it to one.
 */
export default function ContractDeliverablesSection({ contractId, orgId }: Props) {
  const { t } = useTranslation('deliverables');
  const [adding, setAdding] = useState(false);
  const [applyingTemplate, setApplyingTemplate] = useState(false);
  const [selected, setSelected] = useState<Deliverable | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey((n) => n + 1);

  return (
    <div className="rounded-lg border bg-card shadow-xs" data-testid="contract-deliverables">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('section.title')}</h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setApplyingTemplate(true)}
            className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
            data-testid="contract-deliverables-apply-template"
          >
            {t('templates.actions.apply')}
          </button>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
            data-testid="contract-deliverables-add"
          >
            {t('actions.add')}
          </button>
        </div>
      </div>

      <DeliverableTable
        fetcher={fetchWithAuth}
        orgId={orgId}
        contractId={contractId}
        onSelect={setSelected}
        refreshKey={refreshKey}
      />

      <Dialog open={adding} onClose={() => setAdding(false)} title={t('actions.add')} maxWidth="xl" className="p-5">
        <h3 className="mb-3 text-base font-semibold">{t('actions.add')}</h3>
        {adding && (
          <DeliverableForm
            fetcher={fetchWithAuth}
            orgId={orgId}
            contractId={contractId}
            onSaved={() => {
              setAdding(false);
              refresh();
            }}
            onCancel={() => setAdding(false)}
          />
        )}
      </Dialog>

      {selected && (
        <OccurrenceDrawer
          fetcher={fetchWithAuth}
          orgId={orgId}
          deliverable={selected}
          onClose={() => setSelected(null)}
          onChanged={refresh}
        />
      )}

      {applyingTemplate && (
        <ApplyTemplateModal
          fetcher={fetchWithAuth}
          orgId={orgId}
          contractId={contractId}
          onApplied={() => {
            setApplyingTemplate(false);
            refresh();
          }}
          onClose={() => setApplyingTemplate(false)}
        />
      )}
    </div>
  );
}
