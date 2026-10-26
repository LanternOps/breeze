import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { MapPin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';
import { usePermissions } from '../../lib/permissions';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

type PlacementFields = {
  room: string | null;
  rack: string | null;
  rackUnit: number | null;
  heightU: number | null;
};

type PlacementResponse = {
  subject?: { kind: 'device' | 'discovered'; id: string };
  authority: { kind: 'device' | 'discovered'; id: string; linked: boolean };
  placement: PlacementFields | null;
};

type PhysicalPlacementCardProps = {
  subject: 'device' | 'discovered';
  id: string;
  /** Name of the managed device a linked discovered asset defers to (link label only). */
  linkedDeviceName?: string | null;
};

type FormState = { room: string; rack: string; rackUnit: string; heightU: string };
type FormErrors = Partial<Record<keyof FormState, string>>;

const DASH = '—';
const UNIT_RE = /^\d+$/;

function toForm(p: PlacementFields | null): FormState {
  return {
    room: p?.room ?? '',
    rack: p?.rack ?? '',
    rackUnit: p?.rackUnit != null ? String(p.rackUnit) : '',
    heightU: p?.heightU != null ? String(p.heightU) : '',
  };
}

function validate(form: FormState, t: (key: string) => string): { errors: FormErrors; body: PlacementFields | null } {
  const errors: FormErrors = {};
  const room = form.room.trim();
  const rack = form.rack.trim();
  if (room.length > 255) errors.room = t('physicalPlacementCard.validation.roomTooLong');
  if (rack.length > 128) errors.rack = t('physicalPlacementCard.validation.rackTooLong');
  const parseUnit = (raw: string, key: 'rackUnit' | 'heightU'): number | null => {
    const v = raw.trim();
    if (!v) return null;
    const n = UNIT_RE.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      errors[key] = t('physicalPlacementCard.validation.unitRange');
      return null;
    }
    return n;
  };
  const rackUnit = parseUnit(form.rackUnit, 'rackUnit');
  const heightU = parseUnit(form.heightU, 'heightU');
  if (Object.keys(errors).length > 0) return { errors, body: null };
  return { errors, body: { room: room || null, rack: rack || null, rackUnit, heightU } };
}

export default function PhysicalPlacementCard({ subject, id, linkedDeviceName }: PhysicalPlacementCardProps) {
  const { t } = useTranslation('devices');
  const { can } = usePermissions();
  const canWrite = can('devices', 'write');
  const base = subject === 'device' ? `/devices/${id}/placement` : `/discovery/assets/${id}/placement`;

  const [data, setData] = useState<PlacementResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(toForm(null));
  const [errors, setErrors] = useState<FormErrors>({});
  const mountedRef = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetchWithAuth(base);
      if (!mountedRef.current) return;
      if (res.ok) {
        setData((await res.json()) as PlacementResponse);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch {
      if (mountedRef.current) setLoadError(true);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    setData(null);
    setEditing(false);
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const friendly = (code: string): string | undefined => {
    switch (code) {
      case 'PLACEMENT_CONCURRENT_UPDATE': return t('physicalPlacementCard.toasts.concurrent');
      case 'PLACEMENT_AUTHORITY_DEVICE': return t('physicalPlacementCard.toasts.authorityDevice');
      case 'MFA_REQUIRED': return t('physicalPlacementCard.toasts.mfaRequired');
      default: return undefined;
    }
  };

  const save = async (body: PlacementFields, removing: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      const next = await runAction<PlacementResponse>({
        request: () =>
          fetchWithAuth(base, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
        errorFallback: t('physicalPlacementCard.toasts.saveFailed'),
        successMessage: removing ? t('physicalPlacementCard.toasts.removed') : t('physicalPlacementCard.toasts.saved'),
        friendly,
        onUnauthorized: UNAUTHORIZED,
      });
      if (mountedRef.current) {
        setData(next);
        setEditing(false);
      }
    } catch (err) {
      handleActionError(err, t('physicalPlacementCard.toasts.saveFailed'));
      // Stale view (lost a race, or the asset was linked meanwhile): re-read the truth.
      if (err instanceof ActionError && err.status === 409) {
        if (mountedRef.current) setEditing(false);
        await load();
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const { errors: errs, body } = validate(form, t);
    setErrors(errs);
    if (!body) return;
    void save(body, body.room === null && body.rack === null && body.rackUnit === null && body.heightU === null);
  };

  const startEdit = () => {
    setForm(toForm(data?.placement ?? null));
    setErrors({});
    setEditing(true);
  };

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-4 shadow-xs animate-pulse">
        <div className="h-4 w-32 rounded bg-muted" />
        <div className="mt-3 h-6 w-48 rounded bg-muted" />
      </div>
    );
  }

  const header = (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <MapPin className="h-4 w-4" aria-hidden="true" />
      {t('physicalPlacementCard.title')}
    </div>
  );

  if (!data) {
    return (
      <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="physical-placement-card">
        {header}
        <p className="mt-2 text-sm text-muted-foreground">
          {t('physicalPlacementCard.loadFailed')}{' '}
          {loadError && (
            <button
              type="button"
              onClick={() => { setLoading(true); void load(); }}
              className="font-medium text-primary hover:underline"
            >
              {t('common:actions.retry')}
            </button>
          )}
        </p>
      </div>
    );
  }

  const linked = data.authority.linked;
  const placement = data.placement;
  const readOnly = linked || !canWrite;

  const fields: Array<{ key: keyof FormState; label: string; value: string }> = [
    { key: 'room', label: t('physicalPlacementCard.room'), value: placement?.room ?? DASH },
    { key: 'rack', label: t('physicalPlacementCard.rack'), value: placement?.rack ?? DASH },
    { key: 'rackUnit', label: t('physicalPlacementCard.rackUnit'), value: placement?.rackUnit != null ? String(placement.rackUnit) : DASH },
    { key: 'heightU', label: t('physicalPlacementCard.heightU'), value: placement?.heightU != null ? String(placement.heightU) : DASH },
  ];

  return (
    <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="physical-placement-card">
      <div className="flex items-center justify-between">
        {header}
        {!readOnly && !editing && (
          <button
            type="button"
            data-testid="physical-placement-edit"
            onClick={startEdit}
            className="text-sm font-medium text-primary hover:underline"
          >
            {placement ? t('physicalPlacementCard.edit') : t('physicalPlacementCard.add')}
          </button>
        )}
      </div>

      {linked && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="physical-placement-linked">
          {t('physicalPlacementCard.linkedNotice')}{' '}
          <a
            href={`/devices/${data.authority.id}`}
            className="font-medium text-primary hover:underline"
          >
            {linkedDeviceName || t('physicalPlacementCard.openDevice')}
          </a>
        </p>
      )}

      {editing ? (
        <form onSubmit={onSubmit} className="mt-3 grid gap-3 sm:grid-cols-2" noValidate>
          {fields.map((f) => {
            const inputId = `physical-placement-${f.key}`;
            const isUnit = f.key === 'rackUnit' || f.key === 'heightU';
            return (
              <div key={f.key}>
                <label htmlFor={inputId} className="text-xs text-muted-foreground">{f.label}</label>
                <input
                  id={inputId}
                  data-testid={inputId}
                  type="text"
                  inputMode={isUnit ? 'numeric' : undefined}
                  value={form[f.key]}
                  onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  aria-invalid={errors[f.key] ? true : undefined}
                  className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
                {errors[f.key] && <p className="mt-1 text-xs text-destructive" role="alert">{errors[f.key]}</p>}
              </div>
            );
          })}
          <div className="flex items-center gap-2 sm:col-span-2">
            <button
              type="submit"
              disabled={saving}
              className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? t('physicalPlacementCard.saving') : t('physicalPlacementCard.save')}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => setEditing(false)}
              className="h-8 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {t('physicalPlacementCard.cancel')}
            </button>
            {placement && (
              <button
                type="button"
                data-testid="physical-placement-remove"
                disabled={saving}
                onClick={() => void save({ room: null, rack: null, rackUnit: null, heightU: null }, true)}
                className="ml-auto h-8 rounded-md border px-3 text-sm font-medium text-destructive hover:bg-muted disabled:opacity-50"
              >
                {t('physicalPlacementCard.remove')}
              </button>
            )}
          </div>
        </form>
      ) : (
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          {fields.map((f) => (
            <div key={f.key}>
              <dt className="text-xs text-muted-foreground">{f.label}</dt>
              <dd
                className="text-sm font-medium"
                data-testid={`physical-placement-value-${f.key}`}
                aria-label={f.value === DASH ? t('common:states.unknown') : undefined}
              >
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
