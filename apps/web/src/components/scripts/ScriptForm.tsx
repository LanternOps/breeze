import { useMemo, useState, useEffect, useRef, type ComponentType } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, Sparkles, ChevronDown } from 'lucide-react';
import type { EditorProps } from '@monaco-editor/react';

import ScriptAiPanel from './ScriptAiPanel';
import { cn } from '@/lib/utils';
import { useScriptAiStore } from '@/stores/scriptAiStore';
import type { ScriptFormBridge } from '@/stores/scriptAiStore';
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
  const editorInstanceRef = useRef<Parameters<NonNullable<EditorProps['onMount']>>[0] | null>(null);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Dynamic import for Monaco Editor — avoids React.lazy/Suspense which
  // can cause hydration issues during Astro View Transition DOM swaps.
  const [MonacoEditor, setMonacoEditor] = useState<ComponentType<EditorProps> | null>(null);
  useEffect(() => {
    let cancelled = false;
    import('@monaco-editor/react').then((mod) => {
      if (!cancelled) setMonacoEditor(() => mod.default);
    });
    return () => { cancelled = true; };
  }, []);

  // Force editor relayout after View Transition navigation completes
  useEffect(() => {
    const forceLayout = () => {
      requestAnimationFrame(() => editorInstanceRef.current?.layout());
    };
    document.addEventListener('astro:page-load', forceLayout);
    return () => document.removeEventListener('astro:page-load', forceLayout);
  }, []);

  const {
    register,
    handleSubmit,
    control,
    watch,
    getValues,
    setValue,
    formState: { errors, isSubmitting, isDirty }
  } = useForm<ScriptFormValues>({
    resolver: zodResolver(scriptSchema) as never,
    mode: 'onTouched',
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

  // Auto-expand sections when editing a script that has existing data
  useEffect(() => {
    if (defaultValues?.parameters && defaultValues.parameters.length > 0) setParamsOpen(true);
    if (defaultValues?.timeoutSeconds !== undefined && defaultValues.timeoutSeconds !== 300) setSettingsOpen(true);
    if (defaultValues?.runAs !== undefined && defaultValues.runAs !== 'system') setSettingsOpen(true);
  }, [defaultValues]);

  const { panelOpen, togglePanel } = useScriptAiStore();

  const bridge: ScriptFormBridge = useMemo(() => ({
    getFormValues: () => getValues() as ScriptFormValues,
    setFormValues: (partial) => {
      Object.entries(partial).forEach(([key, value]) => {
        if (value !== undefined) {
          setValue(key as keyof ScriptFormValues, value as never, { shouldDirty: true });
        }
      });
    },
    takeSnapshot: () => {
      return structuredClone(getValues() as ScriptFormValues);
    },
    restoreSnapshot: (snapshot) => {
      if (snapshot) {
        Object.entries(snapshot).forEach(([key, value]) => {
          setValue(key as keyof ScriptFormValues, value as never, { shouldDirty: true });
        });
      }
    },
  }), [getValues, setValue]);

  // Warn before leaving with unsaved changes (browser close/refresh + Astro SPA nav)
  const isDirtyRef = useRef(false);
  const skipGuardRef = useRef(false);
  isDirtyRef.current = isDirty;

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirtyRef.current) e.preventDefault();
    };
    const onAstroNav = (e: Event) => {
      if (skipGuardRef.current) { skipGuardRef.current = false; return; }
      if (isDirtyRef.current && !window.confirm('You have unsaved changes. Leave this page?')) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('astro:before-preparation', onAstroNav);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('astro:before-preparation', onAstroNav);
    };
  }, []);

  const formRef = useRef<HTMLFormElement>(null);

  // Keyboard shortcuts: Cmd+S to save, Cmd+Shift+I to toggle AI panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'i') {
        e.preventDefault();
        togglePanel();
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 's') {
        e.preventDefault();
        formRef.current?.requestSubmit();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [togglePanel]);

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
      ref={formRef}
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
        // Save succeeded — allow the post-save navigation without guard
        skipGuardRef.current = true;
      })}
      className="space-y-8 rounded-lg border bg-card p-6 shadow-sm"
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

      {/* Script Content + AI Panel */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold tracking-tight">Script Content</h3>
          <button
            type="button"
            onClick={togglePanel}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition',
              panelOpen
                ? 'bg-primary text-primary-foreground'
                : 'border hover:bg-muted'
            )}
            title="Toggle AI Script Assistant (⌘⇧I)"
          >
            <Sparkles className="h-3.5 w-3.5" />
            AI Assistant
          </button>
        </div>
        <div className="flex rounded-md border">
          <div className="min-w-0 flex-1">
            <Controller
              name="content"
              control={control}
              render={({ field }) =>
                MonacoEditor ? (
                  <MonacoEditor
                    height="600px"
                    language={monacoLanguage}
                    value={field.value}
                    onChange={(value) => field.onChange(value || '')}
                    onMount={(editor) => {
                      editorInstanceRef.current = editor;
                      setEditorMounted(true);
                      requestAnimationFrame(() => editor.layout());
                    }}
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
                ) : (
                  <div className="flex items-center justify-center h-[600px] bg-[#1e1e1e]">
                    <div className="text-center text-white/60">
                      <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/40 border-t-white mx-auto" />
                      <p className="mt-2 text-sm">Loading editor...</p>
                    </div>
                  </div>
                )
              }
            />
          </div>
          {panelOpen && <ScriptAiPanel bridge={bridge} />}
        </div>
        {errors.content && <p className="text-sm text-destructive">{errors.content.message}</p>}
      </div>

      {/* Parameters — collapsible */}
      <div className="rounded-md border">
        <button
          type="button"
          onClick={() => setParamsOpen(prev => !prev)}
          className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/50 transition"
        >
          <div className="flex items-center gap-2">
            <h3 className="text-base font-bold tracking-tight">Parameters</h3>
            {fields.length > 0 && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{fields.length}</span>
            )}
          </div>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', paramsOpen && 'rotate-180')} />
        </button>

        <div
          className="grid transition-[grid-template-rows] duration-200 ease-out"
          style={{ gridTemplateRows: paramsOpen ? '1fr' : '0fr' }}
          aria-hidden={!paramsOpen}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="border-t px-4 pb-4 pt-3 space-y-3">
              {fields.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No parameters yet. Parameters let users supply values at runtime &mdash; reference them
                  in your script as <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">$paramName</code> (PowerShell/Bash)
                  or <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">sys.argv</code> (Python).
                </p>
              )}
              {fields.map((field, index) => (
                <div
                  key={field.id}
                  className="rounded-md border bg-muted/20 p-4"
                >
                  <div className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground mt-2">{index + 1}</span>
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
                            className="h-4 w-4 rounded border-border"
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

              <button
                type="button"
                onClick={() => { addParameter(); }}
                className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition"
              >
                <Plus className="h-4 w-4" />
                Add parameter
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Execution Settings — collapsible */}
      <div className="rounded-md border">
        <button
          type="button"
          onClick={() => setSettingsOpen(prev => !prev)}
          className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/50 transition"
        >
          <div className="flex items-center gap-2">
            <h3 className="text-base font-bold tracking-tight">Execution Settings</h3>
            {!settingsOpen && (
              <span className="text-xs text-muted-foreground">
                {watch('timeoutSeconds')}s &middot; {runAsOptions.find(o => o.value === watch('runAs'))?.label}
              </span>
            )}
          </div>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', settingsOpen && 'rotate-180')} />
        </button>

        <div
          className="grid transition-[grid-template-rows] duration-200 ease-out"
          style={{ gridTemplateRows: settingsOpen ? '1fr' : '0fr' }}
          aria-hidden={!settingsOpen}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="border-t px-4 pb-4 pt-3">
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
                  <p className="text-xs text-muted-foreground">Script is killed after this duration. Default 300s (5 min) is suitable for most tasks.</p>
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
                    {runAsOptions.find(o => o.value === watch('runAs'))?.description}.
                    {watch('runAs') === 'elevated' && ' Uses sudo on macOS/Linux, runas on Windows.'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Form Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="hidden text-xs text-muted-foreground sm:block">
          {typeof navigator !== 'undefined' && navigator.platform?.includes('Mac') ? '⌘S' : 'Ctrl+S'} to save
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
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
            className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
          >
            {isLoading ? 'Saving...' : submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}
