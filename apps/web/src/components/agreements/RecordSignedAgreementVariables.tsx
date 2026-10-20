import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

export interface VariableField {
  name: string;
  label: string;
}

interface Props {
  fields: VariableField[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  disabled?: boolean;
}

/** The manual-variable inputs for the chosen template version. Every field is
 *  required: the server refuses to freeze a rendered agreement with a hole in
 *  it (422 AGREEMENT_VARIABLES_UNRESOLVED). Rendered only when no signed copy
 *  is attached — an uploaded file is frozen as-is and needs no variables. */
export default function RecordSignedAgreementVariables({ fields, values, onChange, disabled }: Props) {
  const { t } = useTranslation('billing');
  if (fields.length === 0) return null;
  return (
    <fieldset className="space-y-2" data-testid="agreements-record-variables">
      <legend className="mb-1 text-sm font-medium text-foreground">{t('agreements.recordSigned.variables')}</legend>
      {fields.map((f) => (
        <label key={f.name} className="block">
          <span className="mb-1 block text-xs text-muted-foreground">{f.label}</span>
          <input
            type="text"
            required
            value={values[f.name] ?? ''}
            onChange={(e) => onChange(f.name, e.target.value)}
            disabled={disabled}
            data-testid={`agreements-record-var-${f.name}`}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
        </label>
      ))}
    </fieldset>
  );
}
