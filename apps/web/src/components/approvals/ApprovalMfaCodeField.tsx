import { useTranslation } from 'react-i18next';

interface ApprovalMfaCodeFieldProps {
  approvalId: string;
  value: string;
  /** The last approve spent a code the server accepted, then refused for
   *  another reason: the next approve needs the next code. */
  spent: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}

/**
 * The field an approval card shows once the server has refused its approve
 * for want of a second factor. The code is sent with the next approve of this
 * card only and verified by the server there. The inbox holds it in memory
 * until that approve and clears it as it is sent; nothing here stores it.
 */
export function ApprovalMfaCodeField({ approvalId, value, spent, disabled, onChange }: ApprovalMfaCodeFieldProps) {
  const { t } = useTranslation('approvals');
  const inputId = `approval-mfa-code-input-${approvalId}`;
  const hintId = `approval-mfa-code-hint-${approvalId}`;
  return (
    <div className="mt-3 space-y-1" data-testid={`approval-mfa-code-field-${approvalId}`}>
      <label htmlFor={inputId} className="block text-sm font-medium">
        {t('mfaCode.label')}
      </label>
      <input
        id={inputId}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        spellCheck={false}
        maxLength={16}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={hintId}
        className="h-10 w-44 rounded-lg border bg-background px-3 font-mono text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
        data-testid={`approval-mfa-code-${approvalId}`}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        {t('mfaCode.hint')}
      </p>
      {spent && (
        <p className="text-xs text-muted-foreground" data-testid={`approval-mfa-code-spent-${approvalId}`}>
          {t('mfaCode.spent')}
        </p>
      )}
    </div>
  );
}
