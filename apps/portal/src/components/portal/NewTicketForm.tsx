import { withBase } from '@/lib/basePath';
import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, AlertCircle, ArrowLeft } from 'lucide-react';
import { buildResponseValidator, coerceFormResponses } from '@breeze/shared';
import { portalApi, type PortalTicketForm, type TicketPriority } from '@/lib/api';
import { cn } from '@/lib/utils';
import { navigateTo } from '@/lib/navigation';
import TicketFormFields from './TicketFormFields';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT } from './ui';

const ticketSchema = z.object({
  subject: z.string().min(5, 'Title must be at least 5 characters'),
  description: z.string().min(20, 'Tell us a little more — a couple of sentences helps us help you.'),
  priority: z.enum(['low', 'normal', 'high', 'urgent'])
});

type TicketFormData = z.infer<typeof ticketSchema>;

const inputCls = INPUT;

interface NewTicketFormProps {
  /** Intake forms from the page's server-side probe of /portal/tickets/forms —
   *  the same call that gates the page, so the picker never fetches a second
   *  time on the client. Empty when the MSP has published none (or the probe
   *  failed, which the page logs): the legacy free-text form shows. */
  forms: PortalTicketForm[];
}

export function NewTicketForm({ forms }: NewTicketFormProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Legacy free-text path — unchanged behaviour from before intake forms.
  const onSubmit = async (data: TicketFormData) => {
    setIsLoading(true);
    setError(null);

    const result = await portalApi.createTicket(data);

    if (result.data) {
      await navigateTo(`/tickets/${result.data.id}`);
    } else {
      setError(result.error || 'We couldn\'t send your request. Nothing you typed was lost — try again.');
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
      setError(result.error || 'We couldn\'t send your request. Nothing you typed was lost — try again.');
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

      <div>
        {showGrid ? (
          <>
            <h2 className="font-display text-xl font-semibold text-foreground">New ticket</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose what you need help with, and we'll get started.
            </p>
            {/* Request types as a ruled list, like every other register in the
                portal. (State/testids still say "grid"/"card" from the earlier
                layout; the e2e selectors depend on them.) The last entry is the
                open door. */}
            <div className="mt-6 divide-y divide-border/70 border-y border-border/70">
              {forms.map((form) => (
                <button
                  key={form.id}
                  type="button"
                  onClick={() => selectForm(form)}
                  data-testid={`portal-ticket-form-card-${form.id}`}
                  className="ledger-row block w-full px-1 py-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="block text-sm font-semibold text-foreground">{form.name}</span>
                  {form.description && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">{form.description}</span>
                  )}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setShowLegacy(true)}
                data-testid="portal-ticket-form-card-blank"
                className="ledger-row block w-full px-1 py-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="block text-sm font-semibold text-foreground">Something else</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
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
            <h2 className="font-display text-xl font-semibold text-foreground">{selectedForm.name}</h2>
            {selectedForm.description && (
              <p className="mt-1 text-sm text-muted-foreground">{selectedForm.description}</p>
            )}

            {/* method="post" is a pre-hydration safety net: if the island fails to
                hydrate, a native submit must never be a GET that puts what the
                customer typed in the URL / browser history / access logs (#2868).
                Once hydrated, onSubmit preventDefaults and fetch() takes over. */}
            <form
              method="post"
              onSubmit={(e) => {
                e.preventDefault();
                void submitForm();
              }}
              className="mt-6 space-y-6"
            >
              {error && (
                <div
                  role="alert"
                  className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive-on-tint"
                >
                  <AlertCircle className="h-4 w-4" />
                  {error}
                </div>
              )}
              {formErrors.__form && (
                <p
                  role="alert"
                  className="text-sm text-destructive-on-tint"
                  data-testid="portal-ticket-form-error"
                >
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
                  aria-describedby="form-priority-help"
                  className={inputCls}
                >
                  {/* Labels describe the customer's situation, not an abstract
                      severity an office manager cannot calibrate. Values stay
                      low/normal/high/urgent — the API contract depends on them. */}
                  <option value="low">Low: I can still work</option>
                  <option value="normal">Normal: it slows me down</option>
                  <option value="high">High: someone cannot work</option>
                  <option value="urgent">Urgent: the whole office is down</option>
                </select>
                <p id="form-priority-help" className="mt-1 max-w-[60ch] text-xs text-muted-foreground">
                  This sets how quickly we respond. If your situation changes, say so
                  in the ticket and we will update it.
                </p>
              </div>

              <div className="flex justify-end gap-3">
                <a href={withBase('/tickets')} className={BTN_SECONDARY}>
                  Cancel
                </a>
                <button
                  type="submit"
                  disabled={isLoading}
                  data-testid="portal-ticket-form-submit"
                  className={cn(BTN_PRIMARY)}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Creating
                    </>
                  ) : (
                    'Submit ticket'
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
            <h2 className="font-display text-xl font-semibold text-foreground">New ticket</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Describe what you need — it goes straight to your IT team.
            </p>

            {/* method="post" is a pre-hydration safety net: if the island fails to
                hydrate, a native submit must never be a GET that puts what the
                customer typed in the URL / browser history / access logs (#2868).
                Once hydrated, react-hook-form's handleSubmit preventDefaults and
                fetch() takes over. */}
            <form method="post" onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-6">
              {error && (
                <div
                  role="alert"
                  className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive-on-tint"
                >
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
                  aria-invalid={!!errors.subject}
                  aria-describedby={errors.subject ? 'subject-error' : undefined}
                  {...register('subject')}
                  className={cn(inputCls, errors.subject && 'border-destructive')}
                />
                {errors.subject && (
                  <p id="subject-error" role="alert" className="mt-1 text-sm text-destructive-on-tint">
                    {errors.subject.message}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="priority" className="block text-sm font-medium text-foreground">
                  Priority
                </label>
                {/* SSR renders the first option selected until hydration; the
                    explicit default keeps the pre-hydration HTML honest about
                    what will actually submit ('normal'). */}
                <select
                  id="priority"
                  aria-describedby="priority-help"
                  defaultValue="normal"
                  {...register('priority')}
                  className={inputCls}
                >
                  {/* Labels describe the customer's situation, not an abstract
                      severity an office manager cannot calibrate. Values stay
                      low/normal/high/urgent — the API contract depends on them. */}
                  <option value="low">Low: I can still work</option>
                  <option value="normal">Normal: it slows me down</option>
                  <option value="high">High: someone cannot work</option>
                  <option value="urgent">Urgent: the whole office is down</option>
                </select>
                <p id="priority-help" className="mt-1 max-w-[60ch] text-xs text-muted-foreground">
                  This sets how quickly we respond. If your situation changes, say so
                  in the ticket and we will update it.
                </p>
              </div>

              <div>
                <label htmlFor="description" className="block text-sm font-medium text-foreground">
                  Description
                </label>
                <textarea
                  id="description"
                  rows={6}
                  placeholder="What's happening, and since when? Anything you've tried helps."
                  aria-invalid={!!errors.description}
                  aria-describedby={errors.description ? 'description-error' : undefined}
                  {...register('description')}
                  className={cn(inputCls, errors.description && 'border-destructive')}
                />
                {errors.description && (
                  <p id="description-error" role="alert" className="mt-1 text-sm text-destructive-on-tint">
                    {errors.description.message}
                  </p>
                )}
              </div>

              <div className="flex justify-end gap-3">
                <a href={withBase('/tickets')} className={BTN_SECONDARY}>
                  Cancel
                </a>
                <button
                  type="submit"
                  disabled={isLoading}
                  className={cn(BTN_PRIMARY)}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Creating
                    </>
                  ) : (
                    'Create ticket'
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
