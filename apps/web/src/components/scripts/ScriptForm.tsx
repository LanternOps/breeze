import { useMemo, useState, lazy, Suspense } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, GripVertical } from 'lucide-react';

// Dynamic import for Monaco Editor to avoid SSR issues
const Editor = lazy(() => import('@monaco-editor/react'));
import { cn } from '@/lib/utils';
import type { ScriptLanguage, OSType } from './ScriptList';

const parameterSchema = z.object({
  name: z.string().min(1, 'Parameter name is required'),
  type: z.enum(['string', 'number', 'boolean', 'select']),
  defaultValue: z.string().optional(),
  required: z.boolean().optional().default(false),
  options: z.string().optional() // comma-separated for select type
});

const scriptSchema = z.object({
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
  runAs: z.enum(['system', 'user', 'elevated'])
});

export type ScriptFormValues = z.infer<typeof scriptSchema>;
export type ScriptParameter = z.infer<typeof parameterSchema>;

type ScriptFormProps = {
  onSubmit?: (values: ScriptFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<ScriptFormValues>;
  submitLabel?: string;
  loading?: boolean;
};

const languageOptions: { value: ScriptLanguage; label: string; monacoLang: string }[] = [
  { value: 'powershell', label: 'PowerShell', monacoLang: 'powershell' },
  { value: 'bash', label: 'Bash', monacoLang: 'shell' },
  { value: 'python', label: 'Python', monacoLang: 'python' },
  { value: 'cmd', label: 'CMD (Batch)', monacoLang: 'bat' }
];

const categoryOptions = [
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

const runAsOptions: { value: 'system' | 'user' | 'elevated'; label: string; description: string }[] = [
  { value: 'system', label: 'System', description: 'Run as the system/root account' },
  { value: 'user', label: 'Current User', description: 'Run as the logged-in user' },
  { value: 'elevated', label: 'Elevated', description: 'Run with administrator privileges' }
];

const parameterTypeOptions: { value: 'string' | 'number' | 'boolean' | 'select'; label: string }[] = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'select', label: 'Select' }
];

export default function ScriptForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel = 'Save script',
  loading
}: ScriptFormProps) {
  const [editorMounted, setEditorMounted] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm<ScriptFormValues>({
    resolver: zodResolver(scriptSchema) as never,
    defaultValues: {
      name: '',
      description: '',
      category: 'Custom',
      language: 'powershell',
      osTypes: ['windows'],
      content: '',
      parameters: [],
      timeoutSeconds: 300,
      runAs: 'system',
      ...defaultValues
    }
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'parameters'
  });

  const watchLanguage = watch('language');
  const watchOsTypes = watch('osTypes');
  const watchParameters = watch('parameters');

  const monacoLanguage = useMemo(() => {
    return languageOptions.find(l => l.value === watchLanguage)?.monacoLang || 'plaintext';
  }, [watchLanguage]);

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);

  const handleOsToggle = (os: OSType) => {
    const current = watchOsTypes || [];
    if (current.includes(os)) {
      if (current.length > 1) {
        setValue('osTypes', current.filter(o => o !== os));
      }
    } else {
      setValue('osTypes', [...current, os]);
    }
  };

  const addParameter = () => {
    append({
      name: '',
      type: 'string',
      defaultValue: '',
      required: false,
      options: ''
    });
  };

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-sm"
    >
      {/* Basic Information */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="script-name" className="text-sm font-medium">
            Script name
          </label>
          <input
            id="script-name"
            placeholder="Clear Temp Files"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="script-category" className="text-sm font-medium">
            Category
          </label>
          <select
            id="script-category"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('category')}
          >
            {categoryOptions.map(cat => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
          {errors.category && <p className="text-sm text-destructive">{errors.category.message}</p>}
        </div>

        <div className="space-y-2 md:col-span-2">
          <label htmlFor="script-description" className="text-sm font-medium">
            Description
          </label>
          <textarea
            id="script-description"
            placeholder="Describe what this script does..."
            rows={2}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
            {...register('description')}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="script-language" className="text-sm font-medium">
            Language
          </label>
          <select
            id="script-language"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('language')}
          >
            {languageOptions.map(lang => (
              <option key={lang.value} value={lang.value}>
                {lang.label}
              </option>
            ))}
          </select>
          {errors.language && <p className="text-sm text-destructive">{errors.language.message}</p>}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Target OS</label>
          <div className="flex flex-wrap gap-2">
            {(['windows', 'macos', 'linux'] as OSType[]).map(os => (
              <button
                key={os}
                type="button"
                onClick={() => handleOsToggle(os)}
                className={cn(
                  'rounded-md border px-3 py-2 text-sm font-medium transition',
                  watchOsTypes?.includes(os)
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input bg-background hover:bg-muted'
                )}
              >
                {os === 'windows' ? 'Windows' : os === 'macos' ? 'macOS' : 'Linux'}
              </button>
            ))}
          </div>
          {errors.osTypes && <p className="text-sm text-destructive">{errors.osTypes.message}</p>}
        </div>
      </div>

      {/* Script Content */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Script Content</label>
        <div className="rounded-md border overflow-hidden">
          <Controller
            name="content"
            control={control}
            render={({ field }) => (
              <Suspense fallback={
                <div className="flex items-center justify-center h-[400px] bg-[#1e1e1e]">
                  <div className="text-center text-white/60">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/40 border-t-white mx-auto" />
                    <p className="mt-2 text-sm">Loading editor...</p>
                  </div>
                </div>
              }>
                <Editor
                  height="400px"
                  language={monacoLanguage}
                  value={field.value}
                  onChange={(value) => field.onChange(value || '')}
                  onMount={() => setEditorMounted(true)}
                  theme="vs-dark"
                  options={{
                    minimap: { enabled: false },
                    fontSize: 14,
                    lineNumbers: 'on',
                    scrollBeyondLastLine: false,
                    wordWrap: 'on',
                    automaticLayout: true,
                    tabSize: 2,
                    padding: { top: 12, bottom: 12 }
                  }}
                />
              </Suspense>
            )}
          />
        </div>
        {errors.content && <p className="text-sm text-destructive">{errors.content.message}</p>}
      </div>

      {/* Parameters */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Parameters</h3>
            <p className="text-xs text-muted-foreground">Define input parameters for this script</p>
          </div>
          <button
            type="button"
            onClick={addParameter}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            Add Parameter
          </button>
        </div>

        {fields.length > 0 && (
          <div className="space-y-3">
            {fields.map((field, index) => (
              <div
                key={field.id}
                className="rounded-md border bg-muted/20 p-4"
              >
                <div className="flex items-start gap-3">
                  <GripVertical className="h-5 w-5 text-muted-foreground mt-2.5 cursor-move" />
                  <div className="flex-1 grid gap-4 sm:grid-cols-2 md:grid-cols-4">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Name</label>
                      <input
                        placeholder="paramName"
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        {...register(`parameters.${index}.name`)}
                      />
                      {errors.parameters?.[index]?.name && (
                        <p className="text-xs text-destructive">{errors.parameters[index]?.name?.message}</p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Type</label>
                      <select
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        {...register(`parameters.${index}.type`)}
                      >
                        {parameterTypeOptions.map(opt => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Default Value</label>
                      <input
                        placeholder="Default"
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        {...register(`parameters.${index}.defaultValue`)}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Required</label>
                      <div className="flex items-center h-9">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-gray-300"
                          {...register(`parameters.${index}.required`)}
                        />
                        <span className="ml-2 text-sm">Yes</span>
                      </div>
                    </div>
                    {watchParameters?.[index]?.type === 'select' && (
                      <div className="space-y-1 sm:col-span-2 md:col-span-4">
                        <label className="text-xs font-medium text-muted-foreground">
                          Options (comma-separated)
                        </label>
                        <input
                          placeholder="option1, option2, option3"
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          {...register(`parameters.${index}.options`)}
                        />
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted text-destructive"
                    title="Remove parameter"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {fields.length === 0 && (
          <div className="rounded-md border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No parameters defined. Click "Add Parameter" to create one.
            </p>
          </div>
        )}
      </div>

      {/* Execution Settings */}
      <div className="rounded-md border bg-muted/20 p-4">
        <h3 className="text-sm font-semibold mb-4">Execution Settings</h3>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="timeout-seconds" className="text-sm font-medium">
              Timeout (seconds)
            </label>
            <input
              id="timeout-seconds"
              type="number"
              min={1}
              max={86400}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('timeoutSeconds')}
            />
            {errors.timeoutSeconds && (
              <p className="text-sm text-destructive">{errors.timeoutSeconds.message}</p>
            )}
            <p className="text-xs text-muted-foreground">Maximum execution time (1-86400 seconds)</p>
          </div>

          <div className="space-y-2">
            <label htmlFor="run-as" className="text-sm font-medium">
              Run As
            </label>
            <select
              id="run-as"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('runAs')}
            >
              {runAsOptions.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            {errors.runAs && <p className="text-sm text-destructive">{errors.runAs.message}</p>}
            <p className="text-xs text-muted-foreground">
              {runAsOptions.find(o => o.value === watch('runAs'))?.description}
            </p>
          </div>
        </div>
      </div>

      {/* Form Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="h-11 w-full rounded-md border bg-background text-sm font-medium text-foreground transition hover:bg-muted sm:w-auto sm:px-6"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
        >
          {isLoading ? 'Saving...' : submitLabel}
        </button>
      </div>
    </form>
  );
}
