import '@/lib/i18n';
import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { DETECTION_CLASSES } from './constants';

type Policy = {
  id: string;
  name: string;
  detectionClasses: unknown;
  isActive: boolean;
};

type CreateScanModalProps = {
  onClose: () => void;
  onCreated: (scans: Array<{ id: string; deviceId: string; orgId: string }>) => void;
};

export default function CreateScanModal({ onClose, onCreated }: CreateScanModalProps) {
  const { t } = useTranslation('security');
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policyId, setPolicyId] = useState('');
  const [deviceIds, setDeviceIds] = useState('');
  const [detectionClasses, setDetectionClasses] = useState<string[]>(['credential']);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetchWithAuth('/sensitive-data/policies')
      .then(async (res) => {
        if (res.ok) {
          const json = await res.json();
          setPolicies((json.data ?? []).filter((p: Policy) => p.isActive));
        }
      })
      .catch(() => {});
  }, []);

  const toggleClass = (cls: string) => {
    setDetectionClasses((prev) => {
      if (prev.includes(cls)) {
        return prev.length > 1 ? prev.filter((c) => c !== cls) : prev;
      }
      return [...prev, cls];
    });
  };

  const handleSubmit = async () => {
    const ids = deviceIds
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (ids.length === 0) {
      setError(
        t('sensitiveDataCreateScanModal.errors.deviceRequired', {
          defaultValue: 'Enter at least one device ID',
        }),
      );
      return;
    }

    try {
      setSubmitting(true);
      setError(undefined);
      const body: Record<string, unknown> = { deviceIds: ids };
      if (policyId) body.policyId = policyId;
      if (detectionClasses.length > 0) body.detectionClasses = detectionClasses;

      const res = await fetchWithAuth('/sensitive-data/scan', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(
          json.error ||
            t('sensitiveDataCreateScanModal.errors.createScan', {
              defaultValue: 'Failed to create scan',
            }),
        );
      }

      const json = await res.json();
      onCreated(json.data?.scans ?? []);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('sensitiveDataCreateScanModal.errors.createScan', {
              defaultValue: 'Failed to create scan',
            }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title={t('sensitiveDataCreateScanModal.title', { defaultValue: 'Create Scan' })}
      className="p-6"
    >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {t('sensitiveDataCreateScanModal.title', { defaultValue: 'Create Scan' })}
          </h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          {/* Policy selector */}
          <div>
            <label className="text-sm font-medium">
              {t('sensitiveDataCreateScanModal.form.policyOptional', {
                defaultValue: 'Policy (optional)',
              })}
            </label>
            <select
              value={policyId}
              onChange={(e) => setPolicyId(e.target.value)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">
                {t('sensitiveDataCreateScanModal.form.noPolicy', {
                  defaultValue: 'No policy (manual config)',
                })}
              </option>
              {policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          {/* Device IDs */}
          <div>
            <label className="text-sm font-medium">
              {t('sensitiveDataCreateScanModal.form.deviceIds', { defaultValue: 'Device IDs' })}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('sensitiveDataCreateScanModal.form.deviceIdsHelp', {
                defaultValue: 'One UUID per line, or comma-separated.',
              })}
            </p>
            <textarea
              value={deviceIds}
              onChange={(e) => setDeviceIds(e.target.value)}
              rows={4}
              placeholder={t('sensitiveDataCreateScanModal.form.deviceIdsPlaceholder', {
                defaultValue: 'device-uuid-1&#10;device-uuid-2',
              })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Detection Classes */}
          {!policyId && (
            <div>
              <label className="text-sm font-medium">
                {t('sensitiveDataCreateScanModal.form.detectionClasses', {
                  defaultValue: 'Detection Classes',
                })}
              </label>
              <div className="mt-2 flex flex-wrap gap-2">
                {DETECTION_CLASSES.map((cls) => (
                  <button
                    key={cls.value}
                    type="button"
                    onClick={() => toggleClass(cls.value)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                      detectionClasses.includes(cls.value)
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'hover:bg-muted'
                    }`}
                  >
                    {cls.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="h-10 rounded-md border px-4 text-sm font-medium hover:bg-muted">
              {t('common:actions.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {submitting
                ? t('sensitiveDataCreateScanModal.actions.creating', {
                    defaultValue: 'Creating...',
                  })
                : t('sensitiveDataCreateScanModal.actions.createScan', {
                    defaultValue: 'Create Scan',
                  })}
            </button>
          </div>
        </div>
    </Dialog>
  );
}
