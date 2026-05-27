import { z } from 'zod';
import type { ScriptLanguage, OSType } from './ScriptList';

export const parameterSchema = z.object({
  name: z.string().min(1, 'Parameter name is required'),
  type: z.enum(['string', 'number', 'boolean', 'select']),
  defaultValue: z.string().optional(),
  required: z.boolean().optional().default(false),
  options: z.string().optional() // comma-separated for select type
});

export const severityValues = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof severityValues)[number];

// Sentinel used in form-row state to represent the wire-shape `null`
// (explicitly suppress the alert for this exit code). Kept as a string so
// `<select>` values and `register()` round-trip cleanly; converted to/from
// `null` at the form boundary by rowsToMapping / mappingToRows.
export const SUPPRESS_SEVERITY = '__suppress__' as const;
export type SeverityRowValue = Severity | typeof SUPPRESS_SEVERITY;

// Form-side representation of one exit-code → severity mapping row. Stored as
// a list during editing so order is stable and each row owns its own state;
// converted to/from the wire `Record<string, severity | null>` at form boundaries.
export const exitCodeSeverityRowSchema = z.object({
  exitCode: z.string().regex(/^\d+$/, 'Exit code must be a non-negative integer'),
  severity: z.enum([...severityValues, SUPPRESS_SEVERITY]),
});

export const scriptSchema = z.object({
  name: z.string().min(1, 'Script name is required'),
  description: z.string().optional(),
  category: z.string().min(1, 'Category is required'),
  language: z.enum(['powershell', 'bash', 'python', 'cmd']),
  osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).min(1, 'Select at least one OS'),
  content: z.string().min(1, 'Script content is required'),
  parameters: z.array(parameterSchema).optional(),
  timeoutSeconds: z.coerce
    .number({ invalid_type_error: 'Enter a timeout value' })
    .int('Timeout must be a whole number')
    .min(1, 'Timeout must be at least 1 second')
    .max(86400, 'Timeout cannot exceed 24 hours'),
  runAs: z.enum(['system', 'user', 'elevated']),
  exitCodeSeverityMapping: z
    .array(exitCodeSeverityRowSchema)
    .optional()
    .superRefine((rows, ctx) => {
      if (!rows) return;
      const seen = new Set<string>();
      rows.forEach((row, i) => {
        if (seen.has(row.exitCode)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'exitCode'],
            message: `Duplicate exit code ${row.exitCode}`,
          });
        }
        seen.add(row.exitCode);
      });
    }),
});

export type ScriptFormValues = z.infer<typeof scriptSchema>;
export type ScriptParameter = z.infer<typeof parameterSchema>;
export type ExitCodeSeverityRow = z.infer<typeof exitCodeSeverityRowSchema>;

// Wire shape sent to / received from the API. Form-side editing keeps an
// ordered list of rows for stable React keys + per-row error display; we
// convert at the form boundary. `null` = explicitly suppress the alert for
// that exit code (distinct from omitting the key, which falls back to
// script-level default handling).
export type ExitCodeSeverityMapping = Record<string, Severity | null>;

export type ScriptSubmitValues = Omit<ScriptFormValues, 'exitCodeSeverityMapping'> & {
  exitCodeSeverityMapping?: ExitCodeSeverityMapping;
};

export function rowsToMapping(rows: ExitCodeSeverityRow[] | undefined): ExitCodeSeverityMapping | undefined {
  if (!rows || rows.length === 0) return undefined;
  return rows.reduce<ExitCodeSeverityMapping>((acc, { exitCode, severity }) => {
    acc[exitCode] = severity === SUPPRESS_SEVERITY ? null : severity;
    return acc;
  }, {});
}

export function mappingToRows(mapping: ExitCodeSeverityMapping | null | undefined): ExitCodeSeverityRow[] {
  if (!mapping) return [];
  return Object.entries(mapping)
    .map<ExitCodeSeverityRow>(([exitCode, severity]) => ({
      exitCode,
      severity: severity === null ? SUPPRESS_SEVERITY : severity,
    }))
    .sort((a, b) => Number(a.exitCode) - Number(b.exitCode));
}

export const severityOptions: { value: SeverityRowValue; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'info', label: 'Info' },
  { value: SUPPRESS_SEVERITY, label: 'Suppress alert' },
];

export const languageOptions: { value: ScriptLanguage; label: string; monacoLang: string }[] = [
  { value: 'powershell', label: 'PowerShell', monacoLang: 'powershell' },
  { value: 'bash', label: 'Bash', monacoLang: 'shell' },
  { value: 'python', label: 'Python', monacoLang: 'python' },
  { value: 'cmd', label: 'CMD (Batch)', monacoLang: 'bat' }
];

export const categoryOptions = [
  'Maintenance',
  'Security',
  'Monitoring',
  'Deployment',
  'Backup',
  'Network',
  'User Management',
  'Software',
  'Custom'
];

export const runAsOptions: { value: 'system' | 'user' | 'elevated'; label: string; description: string }[] = [
  { value: 'system', label: 'System', description: 'Run as the system/root account' },
  { value: 'user', label: 'Current User', description: 'Run as the logged-in user' },
  { value: 'elevated', label: 'Elevated', description: 'Run with administrator privileges' }
];

export const parameterTypeOptions: { value: 'string' | 'number' | 'boolean' | 'select'; label: string }[] = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'select', label: 'Select' }
];
