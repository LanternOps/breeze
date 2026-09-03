import { useMemo, useState, useEffect, useId, useRef, useCallback, type ComponentType } from 'react';
import { useForm, useFieldArray, Controller, type UseFormRegisterReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, Sparkles, AlertTriangle, Braces } from 'lucide-react';
import type { EditorProps } from '@monaco-editor/react';

// Statically import Monaco's editor stylesheet so Astro bundles it into the
// route's <head> as a hashed <link>. @monaco-editor/loader otherwise injects
// this CSS into <head> at runtime, and Astro's View-Transition document swap
// rebuilds <head> from the new page's server markup — dropping that runtime
// injection and leaving the editor's hidden `.inputarea` <textarea> rendered as
// a bare unstyled white box on SPA navigation (issue #1186). A build-time <link>
// is part of every editor route's server markup, so it survives the swap. The
// stylesheet is self-contained (all its url() assets — the codicon font and a
// few images — are inline data: URIs), so Vite processes it without external
// asset resolution. CSS-only — does not pull the Monaco JS wrapper into the
// static bundle (see lib/monacoLoader.ts).
import 'monaco-editor/min/vs/editor/editor.main.css';

import { SCRIPT_BUILTIN_PARAMETER_KEYS, SCRIPT_PARAMETER_SOURCES, scriptSecretEnvName } from '@breeze/shared';
import ScriptAiPanel from './ScriptAiPanel';
import ScriptTestRunner from './ScriptTestRunner';
import CollapsibleSection from './CollapsibleSection';
import ScriptVariablePicker from './ScriptVariablePicker';
import TenantVariableMenu from './TenantVariableMenu';
import { findUnknownVariableKeys, useTenantVariables, type TenantVariableEntry } from '@/lib/tenantVariableTokens';
import HelpTooltip from '../shared/HelpTooltip';
import { cn } from '@/lib/utils';
import { configureMonacoLoader } from '@/lib/monacoLoader';
import { useScriptAiStore } from '@/stores/scriptAiStore';
import type { ScriptFormBridge } from '@/stores/scriptAiStore';
import type { OSType } from './ScriptList';
import { useOrgStore } from '@/stores/orgStore';
import { useAuthStore } from '@/stores/auth';
import { getJwtClaims } from '@/lib/authScope';
import {
  scriptSchema, languageOptions, categoryOptions,
  runAsOptions, parameterTypeOptions, severityOptions,
  rowsToMapping, parameterBindingKey, parameterSource, stripSecretParameterValueFields,
  type ScriptFormDefaults, type ScriptFormValues, type ScriptSubmitValues,
} from './ScriptFormSchema';

export type { ScriptFormValues, ScriptParameter, ScriptSubmitValues } from './ScriptFormSchema';

/**
 * The variable-binding cell: a free-text key plus the shared picker.
 *
 * Serves BOTH variable-backed arms, and the two are exact mirrors of each other
 * (#3409 PR4c-2):
 *
 * - `mode="plain"` (`source: 'tenantVariable'`) wants a NON-secret; picking a
 *   secret is refused by the API at save.
 * - `mode="secret"` (`source: 'tenantSecret'`) wants a SECRET; the value is
 *   never substituted into the script, it reaches the agent only as
 *   `BREEZE_VAR_<UPPER(name)>`, so a plain variable there is the error.
 *
 * One component rather than two so the picker predicate, the typed-key warning
 * and the field chrome cannot drift apart between the arms.
 *
 * Its own component purely so the warning can own a `useId` — the row lives
 * inside a `.map`, where a hook cannot be called, and a single shared id would
 * mean two parameters bound to two different secrets announce only one of them
 * (the same rule `VariableInput` follows for its two warning paragraphs).
 *
 * The warning is deliberately advisory rather than a submit gate: the API
 * rejects a mismatched binding with a 400 at save, so the point here is to say
 * so BEFORE the round trip, not to re-implement the rule. Typing a key by hand
 * is still allowed — the picker disables the wrong rows, but a key can also be
 * re-classified after the script was authored.
 */
function TenantVariableBindingField({
  registration,
  value,
  variables,
  onPick,
  error,
  mode = 'plain',
  parameterName = '',
}: {
  registration: UseFormRegisterReturn;
  value: string;
  variables: TenantVariableEntry[];
  onPick: (key: string) => void;
  error?: string;
  mode?: 'plain' | 'secret';
  parameterName?: string;
}) {
  const { t } = useTranslation('scripts');
  const warnId = useId();
  const secretMode = mode === 'secret';
  const matched = variables.find(v => v.key === value);
  // Only a KNOWN variable can be judged: an unknown key is a legitimate
  // mid-typing state (and, for partner-wide scripts, a key that exists in
  // another org), so it warns about nothing.
  const mismatch = secretMode ? !!value && matched !== undefined && !matched.isSecret : !!matched?.isSecret;
  const warningTestId = secretMode
    ? 'script-parameter-not-secret-warning'
    : 'script-parameter-secret-warning';

  return (
    <div className="space-y-1 sm:col-span-2">
      <label className="text-xs font-medium text-muted-foreground">
        {t('scriptForm.parameterBinding.variableLabel')}
      </label>
      <div className="flex items-stretch gap-2">
        <input
          {...registration}
          placeholder={t('scriptForm.parameterBinding.variablePlaceholder')}
          aria-invalid={mismatch || undefined}
          aria-describedby={mismatch ? warnId : undefined}
          className={cn(
            'h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring',
            mismatch && 'border-destructive/60 focus:ring-destructive/40'
          )}
        />
        <TenantVariableMenu
          variables={variables}
          onSelect={onPick}
          // The parameter stores the bare KEY, so the row's secondary line is
          // the key itself — showing `{{var.key}}` here would advertise a shape
          // this field must not contain.
          formatDetail={key => key}
          selectable={secretMode ? v => v.isSecret : undefined}
          disabledReason={
            secretMode
              ? v => (v.isSecret ? undefined : t('scriptForm.parameterBinding.notSecretRow'))
              : undefined
          }
          trigger={<Braces className="h-3.5 w-3.5" />}
          triggerTitle={t('scriptForm.parameterBinding.chooseTitle')}
          triggerClassName="h-9 shrink-0 bg-background px-3"
        />
      </div>
      {mismatch && (
        <p
          id={warnId}
          data-testid={warningTestId}
          className="flex items-start gap-1.5 text-xs text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {secretMode
              ? t('scriptForm.parameterBinding.notSecret', { key: value })
              : t('scriptForm.parameterBinding.secretRejected', { key: value })}
          </span>
        </p>
      )}
      {secretMode && (
        <p
          data-testid="script-parameter-secret-hint"
          className="text-xs text-muted-foreground"
        >
          {t('scriptForm.parameterBinding.secretHint', {
            // `name` is the env-var key, so the hint is only accurate once the
            // row is named; until then it shows the shape, not a real name.
            env: scriptSecretEnvName(parameterName || 'name'),
          })}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

type ScriptFormProps = {
  onSubmit?: (values: ScriptSubmitValues, options?: { navigate?: boolean }) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: ScriptFormDefaults;
  submitLabel?: string;
  loading?: boolean;
  isNew?: boolean;
  // System scripts can't be re-scoped through this form (they're read-only for
  // non-system users and stay system-scope-seed-only). Hides the picker on edit.
  isSystemScript?: boolean;
  // Saved script id — enables the test runner and lets the AI panel know which
  // script it is editing. Absent for never-saved scripts.
  scriptId?: string;
};

export default function ScriptForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel,
  loading,
  isNew = false,
  isSystemScript = false,
  scriptId,
}: ScriptFormProps) {
  const { t } = useTranslation('scripts');
  // Resolved after mount, never during render. Reading `navigator` inline made
  // SSR emit "Ctrl+S" while the client's first render produced "⌘S" on macOS,
  // which React reports as a hydration mismatch on every Mac visit. Starting
  // from the server's value and correcting in an effect keeps the first client
  // render byte-identical to the SSR output.
  const [saveShortcut, setSaveShortcut] = useState('Ctrl+S');
  useEffect(() => {
    if (navigator.platform?.includes('Mac')) setSaveShortcut('⌘S');
  }, []);
  const [editorMounted, setEditorMounted] = useState(false);
  const editorInstanceRef = useRef<Parameters<NonNullable<EditorProps['onMount']>>[0] | null>(null);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Dynamic import for Monaco Editor — avoids React.lazy/Suspense which
  // can cause hydration issues during Astro View Transition DOM swaps.
  // Re-triggers after View Transition swaps the DOM so the editor reloads
  // on SPA back-navigation (e.g. scripts list → edit → list → edit).
  const [MonacoEditor, setMonacoEditor] = useState<ComponentType<EditorProps> | null>(null);
  const [editorLoadError, setEditorLoadError] = useState<string | null>(null);

  // Tear down the current Monaco instance, tolerating a throw from dispose()
  // (double-dispose, or a Monaco-internal edge case). A swallowed-but-logged
  // failure here must not abort the editor reload below or leave a stale ref
  // that the astro:page-load layout() handler would then call into. See #1186.
  const disposeEditor = useCallback(() => {
    try {
      editorInstanceRef.current?.dispose();
    } catch (err) {
      console.error('Failed to dispose previous Monaco editor:', err);
    } finally {
      editorInstanceRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadEditor = () => {
      // Dispose the previous instance before reloading. On a View-Transition
      // swap Astro replaces the document without unmounting this React tree, so
      // the wrapper's own dispose never fires — without this the orphaned editor
      // (and its listeners/DOM) leaks on every SPA back-nav (issue #1186).
      disposeEditor();
      setEditorLoadError(null);
      // Point Monaco's loader at our self-hosted /monaco/vs assets before the
      // editor module initialises it, so it never reaches cdn.jsdelivr.net
      // (which the CSP no longer allows). Chained so config() always lands
      // before the editor first inits the loader. See #1023.
      configureMonacoLoader()
        .then(() => import('@monaco-editor/react'))
        .then((mod) => {
          if (!cancelled) setMonacoEditor(() => mod.default);
        })
        .catch((err) => {
          if (!cancelled) {
            console.error('Failed to load script editor:', err);
            setEditorLoadError(t('scriptForm.editor.loadError'));
          }
        });
    };
    loadEditor();
    document.addEventListener('astro:after-swap', loadEditor);
    return () => {
      cancelled = true;
      document.removeEventListener('astro:after-swap', loadEditor);
      disposeEditor();
    };
  }, [disposeEditor, t]);

  // Force editor relayout after View Transition navigation completes
  useEffect(() => {
    const forceLayout = () => {
      requestAnimationFrame(() => editorInstanceRef.current?.layout());
    };
    document.addEventListener('astro:page-load', forceLayout);
    return () => document.removeEventListener('astro:page-load', forceLayout);
  }, []);

  // Monaco's runtime theme colors (issue #1589) are preserved across View
  // Transition swaps by the always-present global handler in
  // public/monaco-theme-persist.js (wired into Layout.astro), NOT here. The
  // earlier in-component listener (#1593) could not fire on the failing
  // navigation — scripts-list -> editor — because this component is unmounted
  // on the list page. See that file for the full rationale.

  // #3262: partner users with org_access = 'selected' cannot create or modify
  // partner-wide scripts — the server 403s them — so don't default the form to
  // an option they can't save. Absent (sessions persisted before /users/me
  // carried the field) is treated as capable: UX only, the server enforces.
  const canManagePartnerWide = useAuthStore(s => s.user?.canManagePartnerWide ?? true);

  const {
    register,
    handleSubmit,
    control,
    watch,
    getValues,
    setValue,
    reset,
    formState: { errors, isSubmitting, isDirty }
  } = useForm<ScriptFormValues>({
    // Sanitized on the way in: a row switched to `tenantSecret` still carries
    // the runtime seed's `defaultValue: ''` / `options: ''` in form state (RHF
    // keeps values of unmounted inputs), and the secret arm rejects a PRESENT
    // default outright. The sanitized object is also what `handleSubmit`
    // forwards, so nothing empty reaches the API.
    resolver: ((values: ScriptFormValues, context: unknown, options: unknown) =>
      (zodResolver(scriptSchema) as never as (
        v: ScriptFormValues,
        c: unknown,
        o: unknown
      ) => unknown)(stripSecretParameterValueFields(values), context, options)) as never,
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
      exitCodeSeverityMapping: [],
      availability: canManagePartnerWide ? 'partner' : 'org',
      ...defaultValues
    }
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'parameters'
  });

  const {
    fields: severityFields,
    append: appendSeverity,
    remove: removeSeverity,
  } = useFieldArray({ control, name: 'exitCodeSeverityMapping' });

  const [severityOpen, setSeverityOpen] = useState(false);

  // Auto-expand sections when editing a script that has existing data
  useEffect(() => {
    if (defaultValues?.parameters && defaultValues.parameters.length > 0) setParamsOpen(true);
    if (defaultValues?.timeoutSeconds !== undefined && defaultValues.timeoutSeconds !== 300) setSettingsOpen(true);
    if (defaultValues?.runAs !== undefined && defaultValues.runAs !== 'system') setSettingsOpen(true);
    if (defaultValues?.exitCodeSeverityMapping && defaultValues.exitCodeSeverityMapping.length > 0) setSeverityOpen(true);
  }, [defaultValues]);

  const { panelOpen, togglePanel } = useScriptAiStore();

  // Test-runner state the AI panel context reads through the bridge. Refs (not
  // state) because the bridge is memoized once and reads lazily.
  const testDeviceIdRef = useRef<string | null>(null);
  const lastTestExecutionIdRef = useRef<string | null>(null);

  const bridge: ScriptFormBridge = useMemo(() => ({
    getScriptId: () => scriptId ?? null,
    getTestDeviceId: () => testDeviceIdRef.current,
    getLastTestExecutionId: () => lastTestExecutionIdRef.current,
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
  }), [getValues, setValue, scriptId]);

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
      if (isDirtyRef.current && !window.confirm(t('scriptForm.unsavedConfirm'))) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('astro:before-preparation', onAstroNav);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('astro:before-preparation', onAstroNav);
    };
  }, [t]);

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
  const watchAvailability = watch('availability');
  const watchContent = watch('content');

  // Tenant variables (#3409). The unknown-key notice is derived from the
  // watched content and rendered beside the content error — deliberately NOT
  // part of `scriptSchema`/zodResolver, which would block the save: a key may
  // legitimately be created after the script that references it, and dispatch
  // already fails those devices loudly.
  const tenantVariables = useTenantVariables();
  const knownVariableKeys = useMemo(
    () => new Set(tenantVariables.map(v => v.key)),
    [tenantVariables]
  );
  const unknownVariableKeys = useMemo(
    () =>
      findUnknownVariableKeys(watchContent ?? '', knownVariableKeys, {
        // An empty set means the list hasn't arrived (or the fetch failed) —
        // never "every token is unknown".
        requireKnownKeys: knownVariableKeys.size > 0,
      }),
    [watchContent, knownVariableKeys]
  );

  // Partner-scope detection comes from the JWT scope claim — NOT
  // `useOrgStore().partners`, which is populated only from the system-scope-only
  // `GET /orgs/partners` endpoint and so is always empty for a real partner-scope
  // user (the picker would never render for its own audience). `organizations` IS
  // populated for partner users, so it still drives the >1-org check.
  // The "Available to" picker shows for partner-scope users with >1 accessible
  // org — on create (choose initial scope) AND on edit (re-scope a script:
  // move org→org or promote to All Orgs, issue #1734). Single-org partner users
  // don't need to pick; org-scope users always write to their own org and can't
  // re-scope (the backend 403s a non-partner re-scope and forces org on create).
  const { organizations } = useOrgStore();
  const { scope: jwtScope, partnerId: jwtPartnerId } = getJwtClaims();
  const isPartnerScope = jwtScope === 'partner' && !!jwtPartnerId;
  const showAvailabilityPicker = isPartnerScope && organizations.length > 1 && !isSystemScript;

  const monacoLanguage = useMemo(() => {
    return languageOptions.find(l => l.value === watchLanguage)?.monacoLang || 'plaintext';
  }, [watchLanguage]);

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const resolvedSubmitLabel = submitLabel ?? t('scriptForm.actions.saveScript');

  const languageLabel = (value: string) => t(/* i18n-dynamic */ `scriptForm.languages.${value}`);
  const runAsLabel = (value: string) => t(/* i18n-dynamic */ `scriptForm.runAs.${value}.label`);
  const runAsDescription = (value: string) => t(/* i18n-dynamic */ `scriptForm.runAs.${value}.description`);
  const parameterTypeLabel = (value: string) => t(/* i18n-dynamic */ `scriptForm.parameterTypes.${value}`);
  const parameterSourceLabel = (value: string) => t(/* i18n-dynamic */ `scriptForm.parameterSources.${value}`);
  const severityLabel = (value: string) => t(/* i18n-dynamic */ `scriptForm.severity.${value}`);
  const osLabel = (os: OSType) => t(/* i18n-dynamic */ `scriptForm.os.${os}`);

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

  // Save the form without navigating away — used by the test runner before a
  // run when the buffer is dirty, so the run always executes what's on screen.
  // Resolves false on validation or save failure. Marks the form pristine on
  // success so the unsaved-changes guard doesn't warn about saved work.
  const saveForTestRun = useCallback(() => new Promise<boolean>((resolve) => {
    void handleSubmit(
      async values => {
        try {
          const { exitCodeSeverityMapping, ...rest } = values;
          await onSubmit?.(
            { ...rest, exitCodeSeverityMapping: rowsToMapping(exitCodeSeverityMapping) },
            { navigate: false }
          );
          // Baseline on the SAVED snapshot, keeping the live buffer: edits
          // typed while the PUT was in flight stay dirty (so the next run
          // re-saves them and the nav guard still protects them).
          reset(values, { keepValues: true });
          resolve(true);
        } catch {
          resolve(false);
        }
      },
      () => resolve(false)
    )();
  }), [handleSubmit, onSubmit, reset, getValues]);

  const addParameter = () => {
    append({
      name: '',
      type: 'string',
      defaultValue: '',
      required: false,
      options: '',
      // Seeded explicitly (#3409 PR3): a new row must start on the same
      // invoker-supplied binding every parameter had before sourced
      // parameters existed.
      source: 'runtime'
    });
  };

  /**
   * Switch a row's source, clearing the other arms' binding keys.
   *
   * zodResolver strips them from the submitted values anyway (each union arm
   * only declares its own key), but leaving them in form state makes a row that
   * is switched back look bound to a key the user already abandoned — and the
   * secret warning below would then fire off a key this row no longer uses.
   * `builtin` is seeded with the first vocabulary entry so its `<select>` starts
   * on the value it visually displays rather than on an empty non-option.
   */
  const handleParameterSourceChange = (index: number, next: string) => {
    const set = (field: string, value: unknown) => {
      setValue(
        `parameters.${index}.${field}` as unknown as keyof ScriptFormValues,
        value as never,
        { shouldDirty: true }
      );
    };
    set('source', next);
    // Both variable-backed arms store the key under `variableKey`, so switching
    // between them must clear it too — a secret key left behind on the plain arm
    // (or the reverse) is exactly the mismatch the API 400s.
    set('variableKey', '');
    set('fieldKey', '');
    set('builtinKey', next === 'builtin' ? SCRIPT_BUILTIN_PARAMETER_KEYS[0] : '');
    if (next === 'tenantSecret') {
      // The secret arm is `{type:'string', required:true}` with NO defaultValue
      // and NO options — the inputs are cleared here so switching back does not
      // resurrect an abandoned value; `stripSecretParameterValueFields` is what
      // keeps the resulting `''` out of the schema and off the wire. `required` is not reset when switching away: `true`
      // is a legitimate value on every other arm, and clobbering it would throw
      // away an intentional choice.
      set('type', 'string');
      set('required', true);
      set('defaultValue', '');
      set('options', '');
    }
  };

  /**
   * Per-row field errors. The definitions schema is a discriminated union, so
   * `errors.parameters[i]` is a union of per-arm error shapes and TS cannot see
   * `variableKey` on the runtime arm — the error object itself is a plain
   * record at runtime.
   */
  const parameterFieldError = (index: number, field: string): string | undefined => {
    const row = errors.parameters?.[index] as Record<string, { message?: string }> | undefined;
    return row?.[field]?.message;
  };

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit(async values => {
        // Allow the post-save navigation through the guard. Set BEFORE
        // onSubmit so it's true before navigateTo dispatches the event.
        skipGuardRef.current = true;
        try {
          const { exitCodeSeverityMapping, ...rest } = values;
          const submitValues: ScriptSubmitValues = {
            ...rest,
            exitCodeSeverityMapping: rowsToMapping(exitCodeSeverityMapping),
          };
          await onSubmit?.(submitValues);
        } catch {
          // Save failed — re-arm the nav guard so user doesn't lose work
          skipGuardRef.current = false;
        }
      })}
      className="space-y-8 rounded-lg border bg-card p-6 shadow-xs"
    >
      {/* Availability picker — partner-scope users with >1 org. On create it
          sets the initial scope; on edit it re-scopes the script (move org→org
          or promote to All Orgs, issue #1734). The checked radio is driven by
          react-hook-form's `availability` default (seeded from the current
          scope on edit), so no hardcoded defaultChecked. */}
      {showAvailabilityPicker && (
        <fieldset className="space-y-2 rounded-md border p-4">
          <legend className="px-1 text-sm font-medium">{t('scriptForm.availability.title')}</legend>
          {!isNew && (
            <p className="text-xs text-muted-foreground">
              {t('scriptForm.availability.description')}
            </p>
          )}
          {/* #3262: an edit of a partner-wide script (any field, not just
              re-scope) is server-rejected without the capability — say so up
              front instead of letting the save 403 and discard the edits. */}
          {!canManagePartnerWide && !isNew && defaultValues?.availability === 'partner' && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {t('scriptForm.availability.partnerWideReadOnly')}
            </p>
          )}
          <label className={cn(
            'flex items-center gap-2 text-sm',
            !canManagePartnerWide && 'text-muted-foreground'
          )}>
            <input
              type="radio"
              value="partner"
              disabled={!canManagePartnerWide}
              {...register('availability')}
            />
            {t('scriptForm.availability.partner')}
          </label>
          {!canManagePartnerWide && (
            <p className="pl-6 text-xs text-muted-foreground">
              {t('scriptForm.availability.requiresFullPartnerAccess')}
            </p>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              value="org"
              {...register('availability')}
            />
            {t('scriptForm.availability.organization')}
          </label>
          {watchAvailability === 'org' && (
            <div className="mt-2 space-y-1 pl-6">
              <label htmlFor="script-org" className="text-xs font-medium text-muted-foreground">
                {t('common:labels.organization')}
              </label>
              <select
                id="script-org"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('orgId')}
              >
                <option value="">{t('scriptForm.availability.selectOrganization')}</option>
                {organizations.map(org => (
                  <option key={org.id} value={org.id}>{org.name}</option>
                ))}
              </select>
            </div>
          )}
        </fieldset>
      )}

      {/* Basic Information */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="script-name" className="text-sm font-medium">
            {t('scriptForm.fields.name')}
          </label>
          <input
            id="script-name"
            placeholder={t('scriptForm.placeholders.name')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="script-category" className="text-sm font-medium">
            {t('scriptForm.fields.category')}
          </label>
          <select
            id="script-category"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
            {t('common:labels.description')}
          </label>
          <textarea
            id="script-description"
            placeholder={t('scriptForm.placeholders.description')}
            rows={2}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring resize-none"
            {...register('description')}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="script-language" className="text-sm font-medium">
            {t('scriptForm.fields.language')}
          </label>
          <select
            id="script-language"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('language')}
          >
            {languageOptions.map(lang => (
              <option key={lang.value} value={lang.value}>
                {languageLabel(lang.value)}
              </option>
            ))}
          </select>
          {errors.language && <p className="text-sm text-destructive">{errors.language.message}</p>}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('scriptForm.fields.targetOs')}</label>
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
                {osLabel(os)}
              </button>
            ))}
          </div>
          {errors.osTypes && <p className="text-sm text-destructive">{errors.osTypes.message}</p>}
        </div>
      </div>

      {/* Script Content + AI Panel */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold tracking-tight">{t('scriptForm.sections.content')}</h3>
          <div className="flex items-center gap-2">
            <ScriptVariablePicker
              variables={tenantVariables}
              editorRef={editorInstanceRef}
              content={watchContent ?? ''}
              // Content lives in react-hook-form, not component state — write it
              // back the same way ScriptFormBridge does so the AI panel and the
              // picker can't fight over it.
              onInsert={next => setValue('content', next, { shouldDirty: true })}
            />
            <button
              type="button"
              onClick={togglePanel}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition',
                panelOpen
                  ? 'bg-primary text-primary-foreground'
                  : 'border hover:bg-muted'
              )}
              title={t('scriptForm.ai.toggleTitle')}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {t('scriptForm.ai.button')}
            </button>
          </div>
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
                  <div className="flex items-center justify-center u-h-px-600 bg-[#1e1e1e]">
                    <div className="text-center text-white/60">
                      {editorLoadError ? (
                        <>
                          <p className="text-sm text-red-400">{editorLoadError}</p>
                          <button type="button" onClick={() => window.location.reload()} className="mt-2 text-xs underline hover:text-white">
                            {t('scriptForm.editor.refreshPage')}
                          </button>
                        </>
                      ) : (
                        <>
                          <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/40 border-t-white mx-auto" />
                          <p className="mt-2 text-sm">{t('scriptForm.editor.loading')}</p>
                        </>
                      )}
                    </div>
                  </div>
                )
              }
            />
          </div>
          {panelOpen && <ScriptAiPanel bridge={bridge} />}
        </div>
        {errors.content && <p className="text-sm text-destructive">{errors.content.message}</p>}
        {unknownVariableKeys.length > 0 && (
          <p
            data-testid="script-variable-warning"
            className="flex items-start gap-1.5 text-sm text-amber-600 dark:text-amber-500"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {t('scriptForm.variables.unknown', { keys: unknownVariableKeys.join(', ') })}
            </span>
          </p>
        )}
        <ScriptTestRunner
          scriptId={scriptId}
          osTypes={watchOsTypes ?? []}
          parameters={watchParameters}
          timeoutSeconds={watch('timeoutSeconds')}
          isDirty={isDirty}
          onSaveChanges={saveForTestRun}
          onTestDeviceChange={(deviceId) => { testDeviceIdRef.current = deviceId; }}
          onExecutionChange={(executionId) => { lastTestExecutionIdRef.current = executionId; }}
        />
      </div>

      {/* Parameters */}
      <CollapsibleSection
        title={t('scriptForm.sections.parameters')}
        open={paramsOpen}
        onToggle={() => setParamsOpen(prev => !prev)}
        badge={fields.length > 0 ? (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{fields.length}</span>
        ) : undefined}
      >
        <div className="space-y-3">
          {fields.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t('scriptForm.parameters.emptyPrefix')}{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">$paramName</code>{' '}
              {t('scriptForm.parameters.emptyMiddle')}{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">sys.argv</code>{' '}
              {t('scriptForm.parameters.emptySuffix')}
            </p>
          )}
          {fields.map((field, index) => {
            const row = watchParameters?.[index];
            const source = row ? parameterSource(row) : 'runtime';
            const isBound = source !== 'runtime';
            // A secret parameter's type/required/default are fixed by the
            // schema, so the inputs that would edit them are not rendered —
            // offering a control whose every non-default value is a 400 is
            // worse than not offering it.
            const isSecretParam = source === 'tenantSecret';
            return (
            <div key={field.id} className="rounded-md border bg-muted/20 p-4">
              <div className="flex items-start gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground mt-2">{index + 1}</span>
                <div className="flex-1 grid gap-4 sm:grid-cols-2 md:grid-cols-4">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">{t('common:labels.name')}</label>
                    <input placeholder={t('scriptForm.placeholders.parameterName')} className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring" {...register(`parameters.${index}.name`)} />
                    {parameterFieldError(index, 'name') && <p className="text-xs text-destructive">{parameterFieldError(index, 'name')}</p>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">{t('scriptForm.fields.source')}</label>
                    {/* Deliberately controlled rather than `register`ed: changing
                        the source must write the new arm AND clear the previous
                        arm's binding key in one pass, and a registered select
                        gives no ordering guarantee between RHF's own write and
                        a user `onChange` hook. */}
                    <select
                      aria-label={t('scriptForm.parameters.sourceAriaLabel', { index: index + 1 })}
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      value={source}
                      onChange={e => handleParameterSourceChange(index, e.target.value)}
                    >
                      {SCRIPT_PARAMETER_SOURCES.map(value => <option key={value} value={value}>{parameterSourceLabel(value)}</option>)}
                    </select>
                  </div>
                  {(source === 'tenantVariable' || isSecretParam) && (
                    <TenantVariableBindingField
                      registration={register(`parameters.${index}.variableKey` as unknown as keyof ScriptFormValues)}
                      value={(row && parameterBindingKey(row)) || ''}
                      variables={tenantVariables}
                      error={parameterFieldError(index, 'variableKey')}
                      mode={isSecretParam ? 'secret' : 'plain'}
                      parameterName={row?.name ?? ''}
                      onPick={key => setValue(
                        `parameters.${index}.variableKey` as unknown as keyof ScriptFormValues,
                        key as never,
                        { shouldDirty: true }
                      )}
                    />
                  )}
                  {source === 'deviceCustomField' && (
                    <div className="space-y-1 sm:col-span-2">
                      <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                        {t('scriptForm.parameterBinding.fieldLabel')}
                        <HelpTooltip
                          text={t('scriptForm.parameterBinding.fieldHelp')}
                          ariaLabel={t('scriptForm.parameterBinding.fieldHelpAriaLabel')}
                        />
                      </label>
                      <input
                        placeholder={t('scriptForm.parameterBinding.fieldPlaceholder')}
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                        {...register(`parameters.${index}.fieldKey` as unknown as keyof ScriptFormValues)}
                      />
                      {parameterFieldError(index, 'fieldKey') && <p className="text-xs text-destructive">{parameterFieldError(index, 'fieldKey')}</p>}
                    </div>
                  )}
                  {source === 'builtin' && (
                    <div className="space-y-1 sm:col-span-2">
                      <label className="text-xs font-medium text-muted-foreground">{t('scriptForm.parameterBinding.builtinLabel')}</label>
                      <select
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                        {...register(`parameters.${index}.builtinKey` as unknown as keyof ScriptFormValues)}
                      >
                        {SCRIPT_BUILTIN_PARAMETER_KEYS.map(key => <option key={key} value={key}>{key}</option>)}
                      </select>
                      {parameterFieldError(index, 'builtinKey') && <p className="text-xs text-destructive">{parameterFieldError(index, 'builtinKey')}</p>}
                    </div>
                  )}
                  {!isSecretParam && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">{t('common:labels.type')}</label>
                    <select className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring" {...register(`parameters.${index}.type`)}>
                      {parameterTypeOptions.map(opt => <option key={opt.value} value={opt.value}>{parameterTypeLabel(opt.value)}</option>)}
                    </select>
                  </div>
                  )}
                  {/* Bound parameters keep a default — resolution is
                      `resolved value -> definition default -> missing` — but it
                      is a fallback, not a prefilled answer, so it is labelled as
                      one. */}
                  {!isSecretParam && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">
                      {isBound ? t('scriptForm.fields.fallbackValue') : t('scriptForm.fields.defaultValue')}
                    </label>
                    <input placeholder={t('scriptForm.placeholders.defaultValue')} className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring" {...register(`parameters.${index}.defaultValue`)} />
                  </div>
                  )}
                  {!isSecretParam && (
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">{t('common:labels.required')}</label>
                    <div className="flex items-center h-9">
                      <input type="checkbox" className="h-4 w-4 rounded border-border" {...register(`parameters.${index}.required`)} />
                      <span className="ml-2 text-sm">{t('common:labels.yes')}</span>
                    </div>
                  </div>
                  )}
                  {/* `options` renders the run-time `<select>`. A bound parameter
                      is never prompted for, so a choice list has nothing to
                      drive and is hidden rather than silently ignored. */}
                  {!isBound && !isSecretParam && row?.type === 'select' && (
                    <div className="space-y-1 sm:col-span-2 md:col-span-4">
                      <label className="text-xs font-medium text-muted-foreground">{t('scriptForm.fields.options')}</label>
                      <input placeholder={t('scriptForm.placeholders.options')} className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring" {...register(`parameters.${index}.options`)} />
                    </div>
                  )}
                  {isBound && (
                    <p className="text-xs text-muted-foreground sm:col-span-2 md:col-span-4">
                      {t('scriptForm.parameterBinding.hint')}
                    </p>
                  )}
                </div>
                <button type="button" onClick={() => remove(index)} className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted text-destructive" title={t('scriptForm.actions.removeParameter')}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
            );
          })}
          <button type="button" onClick={addParameter} className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition">
            <Plus className="h-4 w-4" />
            {t('scriptForm.actions.addParameter')}
          </button>
        </div>
      </CollapsibleSection>

      {/* Execution Settings */}
      <CollapsibleSection
        title={t('scriptForm.sections.executionSettings')}
        open={settingsOpen}
        onToggle={() => setSettingsOpen(prev => !prev)}
        summary={<span className="text-xs text-muted-foreground">{watch('timeoutSeconds')}s &middot; {runAsLabel(watch('runAs'))}</span>}
      >
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="timeout-seconds" className="text-sm font-medium">{t('scriptForm.fields.timeoutSeconds')}</label>
            <input id="timeout-seconds" type="number" min={1} max={3600} className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring" {...register('timeoutSeconds')} />
            {errors.timeoutSeconds && <p className="text-sm text-destructive">{errors.timeoutSeconds.message}</p>}
            <p className="text-xs text-muted-foreground">{t('scriptForm.execution.timeoutHint')}</p>
          </div>
          <div className="space-y-2">
            <label htmlFor="run-as" className="text-sm font-medium">{t('scriptForm.fields.runAs')}</label>
            <select id="run-as" className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring" {...register('runAs')}>
              {runAsOptions.map(opt => <option key={opt.value} value={opt.value}>{runAsLabel(opt.value)}</option>)}
            </select>
            {errors.runAs && <p className="text-sm text-destructive">{errors.runAs.message}</p>}
            <p className="text-xs text-muted-foreground">
              {runAsDescription(watch('runAs'))}
              {watch('runAs') === 'elevated' && ` ${t('scriptForm.execution.elevatedHint')}`}
            </p>
          </div>
        </div>
      </CollapsibleSection>

      {/* Exit-code severity mapping */}
      <CollapsibleSection
        title={t('scriptForm.sections.exitCodeSeverity')}
        open={severityOpen}
        onToggle={() => setSeverityOpen(prev => !prev)}
        badge={severityFields.length > 0 ? (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{severityFields.length}</span>
        ) : undefined}
      >
        <div className="space-y-3">
          {severityFields.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t('scriptForm.exitCodeSeverity.emptyPrefix')}{' '}
              <em>{t('scriptForm.exitCodeSeverity.suppressAlert')}</em>{' '}
              {t('scriptForm.exitCodeSeverity.emptySuffix')}
            </p>
          )}
          {severityFields.map((field, index) => (
            <div key={field.id} className="flex items-start gap-3 rounded-md border bg-muted/20 p-3">
              <div className="grid flex-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{t('scriptForm.fields.exitCode')}</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder={t('scriptForm.placeholders.exitCode')}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    {...register(`exitCodeSeverityMapping.${index}.exitCode`)}
                  />
                  {errors.exitCodeSeverityMapping?.[index]?.exitCode && (
                    <p className="text-xs text-destructive">
                      {errors.exitCodeSeverityMapping[index]?.exitCode?.message}
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{t('scriptForm.fields.severity')}</label>
                  <select
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    {...register(`exitCodeSeverityMapping.${index}.severity`)}
                  >
                    {severityOptions.map(opt => (
                      <option key={opt.value} value={opt.value}>{severityLabel(opt.value)}</option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    {t('scriptForm.exitCodeSeverity.suppressHint')}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeSeverity(index)}
                className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted text-destructive"
                title={t('scriptForm.actions.removeMapping')}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => appendSeverity({ exitCode: '', severity: 'medium' })}
            className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition"
          >
            <Plus className="h-4 w-4" />
            {t('scriptForm.actions.addExitCode')}
          </button>
        </div>
      </CollapsibleSection>

      {/* Form Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="hidden text-xs text-muted-foreground sm:block">
          {t('scriptForm.keyboardSave', { shortcut: saveShortcut })}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={onCancel}
            className="h-11 w-full rounded-md border bg-background text-sm font-medium text-foreground transition hover:bg-muted sm:w-auto sm:px-6"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="submit"
            disabled={isLoading}
            className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
          >
            {isLoading ? t('common:states.saving') : resolvedSubmitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}
