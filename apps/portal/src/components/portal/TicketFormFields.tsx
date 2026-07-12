import type { TicketFormField } from '@breeze/shared';

// Deliberate duplicate of apps/web/src/components/tickets/TicketFormFields.tsx
// (the portal cannot share web React components — no runtime package spans
// api/web/portal; only pure `@breeze/shared` Zod logic is shared). Keep in sync
// with that source file. Convention documented at
// apps/web/src/components/billing/invoiceTypes.ts:5.

interface Props {
  fields: TicketFormField[];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  onChange: (key: string, value: unknown) => void;
}

// Controlled, stateless renderer for a ticket form's fields. Styling mirrors the
// portal's NewTicketForm inputs so intake fields match the rest of the portal.
const inputCls =
  'mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm shadow-xs focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary';

export default function TicketFormFields({ fields, values, errors, onChange }: Props) {
  return (
    <div className="space-y-4">
      {fields.map((f) => {
        const err = errors[f.key];
        const common = {
          id: `tf-${f.key}`,
          'data-testid': `ticket-form-field-${f.key}`
        } as const;
        return (
          <div key={f.key}>
            {f.type === 'checkbox' ? (
              <label htmlFor={`tf-${f.key}`} className="flex items-center gap-2 text-sm font-medium text-foreground">
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
                <label htmlFor={`tf-${f.key}`} className="block text-sm font-medium text-foreground">
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
