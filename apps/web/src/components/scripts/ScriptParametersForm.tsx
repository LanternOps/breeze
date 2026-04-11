import type { ScriptParameter } from './ScriptFormSchema';

type ScriptParametersFormProps = {
  parameters: ScriptParameter[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
};

export function validateParameters(
  parameters: ScriptParameter[],
  values: Record<string, unknown>
): string | null {
  for (const param of parameters) {
    const value = values[param.name];
    if (param.required) {
      if (value === undefined || value === null || value === '' || (param.type === 'string' && String(value).trim() === '')) {
        return `Parameter "${param.name}" is required`;
      }
    }
    if (param.type === 'number' && value !== undefined && value !== null && value !== '') {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return `Parameter "${param.name}" must be a valid number`;
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
  if (parameters.length === 0) return null;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold">Parameters</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {parameters.map(param => (
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
                <span className="ml-2 text-sm">Enabled</span>
              </div>
            ) : param.type === 'select' && param.options ? (
              <select
                value={String(values[param.name] || '')}
                onChange={e => onChange(param.name, e.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Select...</option>
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
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
