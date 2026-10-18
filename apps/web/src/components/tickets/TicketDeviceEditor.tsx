import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDeviceOptions } from '../../hooks/useDeviceOptions';
import { DeviceOptionPicker } from '../filters/DeviceOptionPicker';

type Props = {
  orgId: string;
  hasDevice: boolean;
  hasAssignee: boolean;
  /** Persist the chosen device; the caller owns the PATCH (runAction). */
  onSelect: (deviceId: string) => void;
  onUnlink: () => void;
};

/**
 * Device row editor for an existing ticket (#8962). Reuses the Create-ticket
 * device search, scoped to the ticket's org (the API re-enforces same-org).
 */
export function TicketDeviceEditor({ orgId, hasDevice, hasAssignee, onSelect, onUnlink }: Props) {
  const { t } = useTranslation('tickets');
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState('');
  const options = useDeviceOptions({ search, orgId, enabled: editing });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          data-testid="ticket-workbench-device-edit"
          className="text-primary hover:underline"
          onClick={() => setEditing((v) => !v)}
        >
          {hasDevice ? t('ticketWorkbench.device.change') : t('ticketWorkbench.device.link')}
        </button>
        {hasDevice && (
          <button
            type="button"
            data-testid="ticket-workbench-device-unlink"
            className="hover:text-destructive"
            onClick={onUnlink}
          >
            {t('ticketWorkbench.device.unlink')}
          </button>
        )}
      </div>
      {editing && (
        <div className="space-y-2 rounded-md border p-2">
          {hasAssignee && (
            <p data-testid="ticket-workbench-device-assignee-warning" className="text-xs text-muted-foreground">
              {t('ticketWorkbench.device.assigneeWarning')}
            </p>
          )}
          <DeviceOptionPicker
            result={options}
            selectedIds={[]}
            onSelectedIdsChange={([id]) => {
              if (!id) return;
              setEditing(false);
              setSearch('');
              onSelect(id);
            }}
            search={search}
            onSearchChange={setSearch}
            selectionMode="single"
          />
          <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => setEditing(false)}>
            {t('ticketWorkbench.device.cancel')}
          </button>
        </div>
      )}
    </div>
  );
}
