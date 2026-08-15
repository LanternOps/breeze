import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Lock } from 'lucide-react';
import {
  isBoundParameter,
  parameterBindingKey,
  parameterSource,
  runtimeParameters,
  type ScriptParameter,
} from './ScriptFormSchema';

type ScriptsT = TFunction<'scripts'>;

type ScriptParametersFormProps = {
  parameters: ScriptParameter[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
};

/**
 * The single validator for every run surface (execution modal, device picker,
 * fleet fix picker).
 *
 * Bound parameters (#3409 PR3) are skipped outright: the invoker cannot supply
 * one — the server resolves it per target device — so requiring a value here
 * would block a run the server is perfectly able to complete. Their `required`
 * flag still matters, but it is evaluated at dispatch AFTER resolution and the
 * definition default, which is information this form does not have.
 */
export function validateParameters(
  parameters: ScriptParameter[],
  values: Record<string, unknown>,
  t?: ScriptsT
): string | null {
  for (const param of parameters) {
    if (isBoundParameter(param)) continue;
    const value = values[param.name];
    if (param.required) {
      if (value === undefined || value === null || value === '' || (param.type === 'string' && String(value).trim() === '')) {
        return t
          ? t('scriptParametersForm.validation.required', { name: param.name })
          : `Parameter "${param.name}" is required`;
      }
    }
    if (param.type === 'number' && value !== undefined && value !== null && value !== '') {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return t
          ? t('scriptParametersForm.validation.number', { name: param.name })
          : `Parameter "${param.name}" must be a valid number`;
      }
    }
  }
  return null;
}

export default function ScriptParametersForm({
  parameters,
  values,
  onChange
}: ScriptParametersFormProps) {
  const { t } = useTranslation('scripts');
  const runtimeParams = runtimeParameters(parameters);
  const boundParams = parameters.filter(isBoundParameter);
  // VISIBILITY is gated on the whole parameter list; PROMPTING is gated on the
  // runtime subset. These are deliberately different questions: a script whose
  // parameters are ALL bound asks the operator for nothing, but it still
  // injects values into a script about to run on customer machines, so the
  // contract must be on screen. Only `parameters.length === 0` renders nothing.
  if (parameters.length === 0) return null;

  return (
    <div className="space-y-4" data-testid="script-parameters">
      <h3 className="text-sm font-semibold">{t('scriptParametersForm.title')}</h3>
      {runtimeParams.length === 0 && (
        <p className="text-xs text-muted-foreground" data-testid="script-parameters-all-supplied">
          {t('scriptParametersForm.allSupplied')}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {runtimeParams.map(param => (
          <div key={param.name} className="space-y-1">
            <label className="text-sm font-medium">
              {param.name}
              {param.required && <span className="text-destructive ml-1">*</span>}
            </label>
            {param.type === 'boolean' ? (
              <div className="flex items-center h-10">
                <input
                  type="checkbox"
                  checked={Boolean(values[param.name])}
                  onChange={e => onChange(param.name, e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                <span className="ml-2 text-sm">{t('common:states.enabled')}</span>
              </div>
            ) : param.type === 'select' && param.options ? (
              <select
                value={String(values[param.name] || '')}
                onChange={e => onChange(param.name, e.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                <option value="">{t('scriptParametersForm.selectPlaceholder')}</option>
                {param.options.split(',').map(opt => (
                  <option key={opt.trim()} value={opt.trim()}>
                    {opt.trim()}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={param.type === 'number' ? 'number' : 'text'}
                value={String(values[param.name] ?? '')}
                onChange={e => {
                  if (param.type === 'number') {
                    if (e.target.value === '') {
                      onChange(param.name, '');
                    } else {
                      const parsed = Number(e.target.value);
                      onChange(param.name, Number.isNaN(parsed) ? e.target.value : parsed);
                    }
                  } else {
                    onChange(param.name, e.target.value);
                  }
                }}
                placeholder={param.defaultValue || ''}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            )}
          </div>
        ))}

        {/* Bound parameters are shown but never editable — the operator should be
            able to see the whole parameter contract, not just the half they're
            asked about. No input is rendered, so nothing can enter the outgoing
            map (a supplied value would be ignored server-side anyway). */}
        {boundParams.map(param => (
          <div
            key={param.name}
            className="space-y-1"
            data-testid={`script-bound-parameter-${param.name}`}
          >
            <label className="text-sm font-medium">{param.name}</label>
            <div className="flex h-10 items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3">
              <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-xs text-muted-foreground">
                {t(/* i18n-dynamic */ `scriptParametersForm.suppliedBy.${parameterSource(param)}`, {
                  key: parameterBindingKey(param) ?? param.name,
                })}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
