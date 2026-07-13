import { withBase } from '@/lib/basePath';
import React, { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, AlertCircle, ArrowLeft, FileText, MessageSquarePlus } from 'lucide-react';
import { buildResponseValidator, coerceFormResponses } from '@breeze/shared';
import { portalApi, type PortalTicketForm, type TicketPriority } from '@/lib/api';
import { cn } from '@/lib/utils';
import { navigateTo } from '@/lib/navigation';
import TicketFormFields from './TicketFormFields';

const ticketSchema = z.object({
  subject: z.string().min(5, 'Title must be at least 5 characters'),
  description: z.string().min(20, 'Please provide a detailed description (at least 20 characters)'),
  priority: z.enum(['low', 'normal', 'high', 'urgent'])
});

type TicketFormData = z.infer<typeof ticketSchema>;

const inputCls = cn(
  'mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm shadow-xs',
  'focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary'
);

export function NewTicketForm() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Intake forms (Phase 2). Purely additive: a fetch failure silently degrades to
  // the legacy free-text form (no grid, no toast — just a console breadcrumb).
  const [forms, setForms] = useState<PortalTicketForm[]>([]);
  const [selectedForm, setSelectedForm] = useState<PortalTicketForm | null>(null);
  // True once the user picks "Something else" from the grid → legacy free-text form.
  const [showLegacy, setShowLegacy] = useState(false);

  // Controlled state for the intake-form path.
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [formDescription, setFormDescription] = useState('');
  const [formPriority, setFormPriority] = useState<TicketPriority>('normal');

  const {
    register,
    handleSubmit,
    formState: { errors }
  } = useForm<TicketFormData>({
    resolver: zodResolver(ticketSchema),
    defaultValues: {
      priority: 'normal'
    }
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await portalApi.getTicketForms();
      if (cancelled) return;
      if (result.data) {
        setForms(result.data);
      } else {
        // Forms are additive — degrade to the legacy free-text form, but leave a
        // breadcrumb so a broken picker isn't invisible in the console.
        console.warn('[portal/new-ticket] forms fetch failed', result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Legacy free-text path — unchanged behaviour from before intake forms.
  const onSubmit = async (data: TicketFormData) => {
    setIsLoading(true);
    setError(null);

    const result = await portalApi.createTicket(data);

    if (result.data) {
      await navigateTo(`/tickets/${result.data.id}`);
    } else {
      setError(result.error || 'Failed to create ticket');
    }

    setIsLoading(false);
  };

  const selectForm = (form: PortalTicketForm) => {
    setSelectedForm(form);
    setShowLegacy(false);
    setError(null);
    setFormErrors({});
    setFormDescription('');
    setFormPriority(form.defaultPriority ?? 'normal');
    const defaults: Record<string, unknown> = {};
    for (const f of form.fields) if (f.defaultValue !== undefined) defaults[f.key] = f.defaultValue;
    setFormValues(defaults);
  };

  // Back affordance → return to the card grid and clear all intake-form state.
  const backToGrid = () => {
    setSelectedForm(null);
    setShowLegacy(false);
    setFormValues({});
    setFormErrors({});
    setFormDescription('');
    setError(null);
  };

  const submitForm = async () => {
    if (!selectedForm) return;

    // Validate client-side for inline errors before POSTing. The API re-validates
    // authoritatively — this is a UX fast-path, not the gate.
    const coerced = coerceFormResponses(selectedForm.fields, formValues);
    const parsed = buildResponseValidator(selectedForm.fields).safeParse(coerced);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        // 'invalid_type: received undefined' on a missing required field reads badly — normalize.
        if (key && !errs[key]) {
          errs[key] =
            issue.code === 'invalid_type' && coerced[key] === undefined
              ? 'This field is required'
              : issue.message;
        }
      }
      // Guard against a silent no-op: if no issue mapped to a field key, surface a
      // generic form-level error so validation failure is never invisible.
      if (Object.keys(errs).length === 0) {
        errs.__form = 'Some responses are invalid. Please review the form and try again.';
      }
      setFormErrors(errs);
      return;
    }

    setFormErrors({});
    setIsLoading(true);
    setError(null);

    const result = await portalApi.createTicket({
      formId: selectedForm.id,
      formResponses: parsed.data as Record<string, unknown>,
      description: formDescription.trim() || undefined,
      priority: formPriority
    });

    if (result.data) {
      await navigateTo(`/tickets/${result.data.id}`);
    } else {
      setError(result.error || 'Failed to create ticket');
    }

    setIsLoading(false);
  };

  const showGrid = forms.length > 0 && !selectedForm && !showLegacy;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <a
          href={withBase('/tickets')}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to tickets
        </a>
      </div>

      <div className="rounded-lg border bg-card p-6">
        {showGrid ? (
          <>
            <h2 className="text-lg font-semibold">Create New Ticket</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose what you need help with to get started.
            </p>
            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {forms.map((form) => (
                <button
                  key={form.id}
                  type="button"
                  onClick={() => selectForm(form)}
                  data-testid={`portal-ticket-form-card-${form.id}`}
                  className={cn(
                    'flex flex-col items-start gap-1 rounded-lg border bg-background p-4 text-left',
                    'hover:border-primary hover:bg-muted focus:outline-hidden focus:ring-2 focus:ring-primary'
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    {form.name}
                  </span>
                  {form.description && (
                    <span className="text-xs text-muted-foreground">{form.description}</span>
                  )}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setShowLegacy(true)}
                data-testid="portal-ticket-form-card-blank"
                className={cn(
                  'flex flex-col items-start gap-1 rounded-lg border border-dashed bg-background p-4 text-left',
                  'hover:border-primary hover:bg-muted focus:outline-hidden focus:ring-2 focus:ring-primary'
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <MessageSquarePlus className="h-4 w-4 text-muted-foreground" />
                  Something else
                </span>
                <span className="text-xs text-muted-foreground">
                  Describe your issue in your own words.
                </span>
              </button>
            </div>
          </>
        ) : selectedForm ? (
          <>
            {forms.length > 0 && (
              <button
                type="button"
                onClick={backToGrid}
                data-testid="portal-ticket-form-back"
                className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to options
              </button>
            )}
            <h2 className="text-lg font-semibold">{selectedForm.name}</h2>
            {selectedForm.description && (
              <p className="mt-1 text-sm text-muted-foreground">{selectedForm.description}</p>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submitForm();
              }}
              className="mt-6 space-y-6"
            >
              {error && (
                <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {error}
                </div>
              )}
              {formErrors.__form && (
                <p className="text-sm text-destructive" data-testid="portal-ticket-form-error">
                  {formErrors.__form}
                </p>
              )}

              <TicketFormFields
                fields={selectedForm.fields}
                values={formValues}
                errors={formErrors}
                onChange={(key, value) => setFormValues((v) => ({ ...v, [key]: value }))}
              />

              <div>
                <label htmlFor="form-description" className="block text-sm font-medium text-foreground">
                  Additional details <span className="text-muted-foreground">(optional)</span>
                </label>
                <textarea
                  id="form-description"
                  rows={4}
                  placeholder="Anything else we should know?"
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  data-testid="portal-ticket-form-description"
                  className={inputCls}
                />
              </div>

              <div>
                <label htmlFor="form-priority" className="block text-sm font-medium text-foreground">
                  Priority
                </label>
                <select
                  id="form-priority"
                  value={formPriority}
                  onChange={(e) => setFormPriority(e.target.value as TicketPriority)}
                  data-testid="portal-ticket-form-priority"
                  className={inputCls}
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>

              <div className="flex justify-end gap-3">
                <a
                  href={withBase('/tickets')}
                  className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
                >
                  Cancel
                </a>
                <button
                  type="submit"
                  disabled={isLoading}
                  data-testid="portal-ticket-form-submit"
                  className={cn(
                    'flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground',
                    'hover:bg-primary/90 focus:outline-hidden focus:ring-2 focus:ring-primary focus:ring-offset-2',
                    'disabled:cursor-not-allowed disabled:opacity-50'
                  )}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    'Submit Ticket'
                  )}
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            {forms.length > 0 && (
              <button
                type="button"
                onClick={backToGrid}
                data-testid="portal-ticket-form-back"
                className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to options
              </button>
            )}
            <h2 className="text-lg font-semibold">Create New Ticket</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Describe your issue and we'll get back to you as soon as possible.
            </p>

            <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-6">
              {error && (
                <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {error}
                </div>
              )}

              <div>
                <label htmlFor="subject" className="block text-sm font-medium text-foreground">
                  Title
                </label>
                <input
                  id="subject"
                  type="text"
                  placeholder="Brief summary of your issue"
                  {...register('subject')}
                  className={cn(inputCls, errors.subject && 'border-destructive')}
                />
                {errors.subject && (
                  <p className="mt-1 text-sm text-destructive">{errors.subject.message}</p>
                )}
              </div>

              <div>
                <label htmlFor="priority" className="block text-sm font-medium text-foreground">
                  Priority
                </label>
                <select id="priority" {...register('priority')} className={inputCls}>
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Select the urgency level of your issue
                </p>
              </div>

              <div>
                <label htmlFor="description" className="block text-sm font-medium text-foreground">
                  Description
                </label>
                <textarea
                  id="description"
                  rows={6}
                  placeholder="Please provide detailed information about your issue..."
                  {...register('description')}
                  className={cn(inputCls, errors.description && 'border-destructive')}
                />
                {errors.description && (
                  <p className="mt-1 text-sm text-destructive">{errors.description.message}</p>
                )}
              </div>

              <div className="flex justify-end gap-3">
                <a
                  href={withBase('/tickets')}
                  className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
                >
                  Cancel
                </a>
                <button
                  type="submit"
                  disabled={isLoading}
                  className={cn(
                    'flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground',
                    'hover:bg-primary/90 focus:outline-hidden focus:ring-2 focus:ring-primary focus:ring-offset-2',
                    'disabled:cursor-not-allowed disabled:opacity-50'
                  )}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    'Create Ticket'
                  )}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

export default NewTicketForm;
