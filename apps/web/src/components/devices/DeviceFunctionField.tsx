import { useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DeviceFunctionDto } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import {
  CUSTOM_FUNCTION_PREFIX,
  CUSTOM_FUNCTION_SLUG_PATTERN,
  DEVICE_FUNCTION_KEYS,
  getDeviceFunctionLabel,
  getDeviceFunctionSourceColor,
  isCustomFunctionKey,
  type DeviceFunctionSource,
} from '../../lib/deviceFunctions';
import '../../lib/i18n';

/**
 * Device Function field (Fleet Designer W02, #5652) — rendered beside Role on
 * the device page. The chip reads the projection off the device DTO
 * (`deviceFunction` / `deviceFunctionSource`); the assessment detail
 * (confidence, evidence) is fetched from `GET /devices/:id/function` only when
 * the technician opens the "why" details of an AI-assessed function. Saving
 * writes a MANUAL assessment via `PUT /devices/:id/function`, which the
 * designer never overrides; "Clear" sends `functionKey: null`.
 */

const CUSTOM_OPTION = '__custom__';

export interface DeviceFunctionChange {
  functionKey: string | null;
  source: DeviceFunctionSource | null;
  label: string | null;
}

interface Props {
  deviceId: string;
  functionKey: string | null | undefined;
  functionSource: string | null | undefined;
  /** Stored label for a custom key, when the parent has it. */
  functionLabel?: string | null;
  onChanged: (next: DeviceFunctionChange) => void;
}

export default function DeviceFunctionField({ deviceId, functionKey, functionSource, functionLabel, onChanged }: Props) {
  const { t } = useTranslation('devices');
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string>('');
  const [customSlug, setCustomSlug] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<DeviceFunctionDto | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [localLabel, setLocalLabel] = useState<string | null>(functionLabel ?? null);

  const current = functionKey ?? null;
  const source = (functionSource === 'ai' || functionSource === 'manual') ? functionSource : null;
  const displayLabel = getDeviceFunctionLabel(current, detail?.label ?? localLabel);

  const beginEdit = () => {
    if (current && isCustomFunctionKey(current)) {
      setSelected(CUSTOM_OPTION);
      setCustomSlug(current.slice(CUSTOM_FUNCTION_PREFIX.length));
      setCustomLabel(detail?.label ?? localLabel ?? '');
    } else {
      setSelected(current ?? DEVICE_FUNCTION_KEYS[0]);
      setCustomSlug('');
      setCustomLabel('');
    }
    setEditing(true);
  };

  const submit = async (body: { functionKey: string | null; label?: string }, successMessage: string) => {
    setSaving(true);
    try {
      const dto = await runAction<DeviceFunctionDto>({
        request: () =>
          fetchWithAuth(`/devices/${deviceId}/function`, { method: 'PUT', body: JSON.stringify(body) }),
        errorFallback: t('deviceInfoTab.functionSaveFailed'),
        successMessage,
      });
      setDetail(dto);
      setLocalLabel(dto.label ?? null);
      onChanged({ functionKey: dto.functionKey, source: dto.source, label: dto.label ?? null });
      setEditing(false);
    } catch (err) {
      // 401: the auth redirect is the feedback. Any other ActionError was
      // already toasted by runAction; anything else (a throw from the parent's
      // onChanged, say) must not vanish silently.
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        console.error('Failed to apply device function change:', err);
        showToast({ type: 'error', message: t('deviceInfoTab.functionSaveFailed') });
      }
    } finally {
      setSaving(false);
    }
  };

  const customValid = CUSTOM_FUNCTION_SLUG_PATTERN.test(customSlug) && customLabel.trim().length > 0;
  const canSave = selected === CUSTOM_OPTION ? customValid : selected !== '';

  const handleSave = () => {
    if (!canSave) return;
    if (selected === CUSTOM_OPTION) {
      void submit(
        { functionKey: `${CUSTOM_FUNCTION_PREFIX}${customSlug}`, label: customLabel.trim() },
        t('deviceInfoTab.functionSaved'),
      );
    } else {
      void submit({ functionKey: selected }, t('deviceInfoTab.functionSaved'));
    }
  };

  const handleClear = () => {
    void submit({ functionKey: null }, t('deviceInfoTab.functionCleared'));
  };

  const loadDetail = async () => {
    if (detail || detailError) return;
    try {
      const res = await fetchWithAuth(`/devices/${deviceId}/function`);
      if (!res.ok) {
        console.error(`Failed to load device function detail (HTTP ${res.status})`);
        setDetailError(t('deviceInfoTab.functionEvidenceUnavailable'));
        return;
      }
      setDetail((await res.json()) as DeviceFunctionDto);
    } catch (err) {
      console.error('Failed to load device function detail:', err);
      setDetailError(t('deviceInfoTab.functionEvidenceUnavailable'));
    }
  };

  return (
    <>
      <div className="flex items-center justify-between py-2">
        <dt className="text-sm text-muted-foreground">{t('deviceInfoTab.function')}</dt>
        <dd className="text-sm font-medium text-right flex items-center gap-2 flex-wrap justify-end">
          {editing ? (
            <>
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="h-8 w-48 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                autoFocus
              >
                {DEVICE_FUNCTION_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {getDeviceFunctionLabel(key)}
                  </option>
                ))}
                <option value={CUSTOM_OPTION}>{t('deviceInfoTab.functionCustom')}</option>
              </select>
              {selected === CUSTOM_OPTION && (
                <>
                  <input
                    type="text"
                    value={customSlug}
                    onChange={(e) => setCustomSlug(e.target.value.trim().toLowerCase())}
                    placeholder={t('deviceInfoTab.functionCustomSlug')}
                    maxLength={40}
                    className="h-8 w-40 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                  <input
                    type="text"
                    value={customLabel}
                    onChange={(e) => setCustomLabel(e.target.value)}
                    placeholder={t('deviceInfoTab.functionCustomLabel')}
                    maxLength={80}
                    className="h-8 w-40 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </>
              )}
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !canSave}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-primary hover:bg-primary/10 disabled:opacity-50"
                title={t('deviceInfoTab.save')}
              >
                <Check className="h-4 w-4" />
              </button>
              {current && (
                <button
                  type="button"
                  onClick={handleClear}
                  disabled={saving}
                  className="inline-flex h-7 items-center rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {t('deviceInfoTab.functionClear')}
                </button>
              )}
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={saving}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                title={t('deviceInfoTab.cancel')}
              >
                <X className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              {current ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-1 text-xs font-medium">
                  {displayLabel}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">{t('deviceInfoTab.functionNone')}</span>
              )}
              {source && (
                <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${getDeviceFunctionSourceColor(source)}`}>
                  {source === 'ai' ? t('deviceInfoTab.functionSource.ai') : t('deviceInfoTab.functionSource.manual')}
                </span>
              )}
              <button
                type="button"
                onClick={beginEdit}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                title={t('deviceInfoTab.changeFunction')}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </dd>
      </div>
      {source === 'ai' && current && (
        <details className="py-2" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) void loadDetail(); }}>
          <summary className="cursor-pointer text-xs text-muted-foreground">{t('deviceInfoTab.functionEvidence')}</summary>
          {detailError && <p className="mt-1 text-xs text-destructive">{detailError}</p>}
          {detail && (
            <div className="mt-1 space-y-1">
              {detail.confidence != null && (
                <p className="text-xs text-muted-foreground">
                  {t('deviceInfoTab.functionConfidence', { pct: Math.round(detail.confidence * 100) })}
                </p>
              )}
              {detail.evidence.length > 0 && (
                <ul className="list-disc pl-4 text-xs">
                  {detail.evidence.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </details>
      )}
    </>
  );
}
