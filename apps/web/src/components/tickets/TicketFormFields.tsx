import type { TicketFormField } from '@breeze/shared';

interface Props {
  fields: TicketFormField[];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  onChange: (key: string, value: unknown) => void;
}

// Shared, controlled, stateless renderer for a ticket form's fields. Used by BOTH
// the settings builder's live preview AND the create-ticket page, so end users
// and admins always see the exact same field UI — the preview cannot drift.
const inputCls = 'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm';

export default function TicketFormFields({ fields, values, errors, onChange }: Props) {
  return (
    <div className="space-y-3">
      {fields.map((f) => {
        const err = errors[f.key];
        const common = {
          id: `tf-${f.key}`,
          'data-testid': `ticket-form-field-${f.key}`
        } as const;
        return (
          <div key={f.key}>
            {f.type === 'checkbox' ? (
              <label htmlFor={`tf-${f.key}`} className="flex items-center gap-2 text-sm font-medium">
                <input
                  {...common}
                  type="checkbox"
                  className="h-4 w-4 rounded border"
                  checked={values[f.key] === true}
                  onChange={(e) => onChange(f.key, e.target.checked)}
                />
                <span>
                  {f.label}
                  {f.required && <span className="text-destructive"> *</span>}
                </span>
              </label>
            ) : (
              <>
                <label htmlFor={`tf-${f.key}`} className="mb-1 block text-sm font-medium">
                  {f.label}
                  {f.required && <span className="text-destructive"> *</span>}
                </label>
                {f.type === 'textarea' && (
                  <textarea
                    {...common}
                    className={inputCls}
                    rows={3}
                    placeholder={f.placeholder}
                    value={(values[f.key] as string) ?? ''}
                    onChange={(e) => onChange(f.key, e.target.value)}
                  />
                )}
                {(f.type === 'text' || f.type === 'date' || f.type === 'number') && (
                  <input
                    {...common}
                    className={inputCls}
                    type={f.type === 'text' ? 'text' : f.type}
                    placeholder={f.placeholder}
                    value={(values[f.key] as string | number) ?? ''}
                    onChange={(e) => onChange(f.key, e.target.value)}
                  />
                )}
                {f.type === 'select' && (
                  <select
                    {...common}
                    className={inputCls}
                    value={(values[f.key] as string) ?? ''}
                    onChange={(e) => onChange(f.key, e.target.value)}
                  >
                    <option value="">Select…</option>
                    {(f.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                )}
              </>
            )}
            {f.helpText && <p className="mt-1 text-xs text-muted-foreground">{f.helpText}</p>}
            {err && (
              <p className="mt-1 text-xs text-destructive" data-testid={`ticket-form-field-error-${f.key}`}>
                {err}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
