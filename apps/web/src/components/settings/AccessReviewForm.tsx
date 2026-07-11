import { i18n } from '@/lib/i18n';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useMemo, useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const createAccessReviewSchema = (t: TFunction) => z.object({
  name: z.string().min(1, t('accessReviewForm.reviewNameIsRequired')).max(255),
  description: z.string().optional(),
  scope: z.enum(['current', 'organization', 'partner']),
  reviewerIds: z.array(z.string()).optional(),
  dueDate: z.string().optional(),
  notifyReviewers: z.boolean().optional()
});

type AccessReviewFormValues = z.infer<ReturnType<typeof createAccessReviewSchema>>;

type ReviewerOption = {
  id: string;
  name: string;
  email: string;
};

type AccessReviewFormProps = {
  isOpen: boolean;
  reviewers?: ReviewerOption[];
  onSubmit?: (values: AccessReviewFormValues) => void | Promise<void>;
  onCancel?: () => void;
  loading?: boolean;
};

export default function AccessReviewForm({
  isOpen,
  reviewers = [],
  onSubmit,
  onCancel,
  loading
}: AccessReviewFormProps) {
  const { t } = useTranslation('settings');
  const [step, setStep] = useState(0);
  const [reviewerQuery, setReviewerQuery] = useState('');
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
    setValue,
    watch,
    trigger
  } = useForm<AccessReviewFormValues>({
    resolver: zodResolver(createAccessReviewSchema(t)),
    defaultValues: {
      name: '',
      description: '',
      scope: 'current',
      reviewerIds: [],
      dueDate: '',
      notifyReviewers: true
    }
  });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const reviewerIds = watch('reviewerIds') ?? [];
  const notifyReviewers = watch('notifyReviewers') ?? false;
  const steps = [t('accessReviewForm.basics'), t('accessReviewForm.scopeReviewers'), t('accessReviewForm.deadline')];

  useEffect(() => {
    if (isOpen) {
      setStep(0);
      setReviewerQuery('');
    }
  }, [isOpen]);

  const filteredReviewers = useMemo(() => {
    const normalized = reviewerQuery.trim().toLowerCase();
    if (!normalized) return reviewers;
    return reviewers.filter((reviewer) => {
      return (
        reviewer.name.toLowerCase().includes(normalized) ||
        reviewer.email.toLowerCase().includes(normalized)
      );
    });
  }, [reviewerQuery, reviewers]);

  const handleClose = () => {
    reset();
    setStep(0);
    setReviewerQuery('');
    onCancel?.();
  };

  const toggleReviewer = (id: string) => {
    const next = new Set(reviewerIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setValue('reviewerIds', Array.from(next), { shouldDirty: true });
  };

  const handleNext = async () => {
    if (step === 0) {
      const isValid = await trigger(['name']);
      if (!isValid) return;
    }
    setStep((current) => Math.min(current + 1, steps.length - 1));
  };

  const handleBack = () => {
    setStep((current) => Math.max(current - 1, 0));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t('accessReviewForm.createAccessReview')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('accessReviewForm.startANewAccessReviewToAuditUserPermissionsThisWillGener')}</p>
        </div>

        <form
          onSubmit={handleSubmit(async (values) => {
            await onSubmit?.(values);
          })}
          className="mt-6 space-y-5"
        >
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {t('accessReviewForm.step')}{step + 1} {t('accessReviewForm.of')}{steps.length}
            </span>
            <div className="flex items-center gap-2">
              {steps.map((label, index) => (
                <span
                  key={label}
                  className={
                    index === step
                      ? 'rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary'
                      : 'rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground'
                  }
                >
                  {label}
                </span>
              ))}
            </div>
          </div>

          {step === 0 && (
            <>
              <div className="space-y-2">
                <label htmlFor="review-name" className="text-sm font-medium">
                  {t('accessReviewForm.reviewName')}</label>
                <input
                  id="review-name"
                  placeholder={t('accessReviewForm.q12024AccessReview')}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('name')}
                />
                {errors.name && (
                  <p className="text-sm text-destructive">{errors.name.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <label htmlFor="review-description" className="text-sm font-medium">
                  {t('accessReviewForm.descriptionOptional')}</label>
                <textarea
                  id="review-description"
                  placeholder={t('accessReviewForm.describeThePurposeOfThisAccessReview')}
                  rows={3}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring resize-none"
                  {...register('description')}
                />
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="space-y-2">
                <label htmlFor="review-scope" className="text-sm font-medium">
                  {t('accessReviewForm.scope')}</label>
                <select
                  id="review-scope"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('scope')}
                >
                  <option value="current">{t('accessReviewForm.currentWorkspace')}</option>
                  <option value="organization">{t('accessReviewForm.organization')}</option>
                  <option value="partner">{t('accessReviewForm.partner')}</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  {t('accessReviewForm.scopeIsDeterminedByYourCurrentOrganizationOrPartnerConte')}</p>
              </div>

              <div className="space-y-2">
                <label htmlFor="reviewer-search" className="text-sm font-medium">
                  {t('accessReviewForm.reviewers')}</label>
                <input
                  id="reviewer-search"
                  type="search"
                  placeholder={t('accessReviewForm.searchReviewers')}
                  value={reviewerQuery}
                  onChange={(event) => setReviewerQuery(event.target.value)}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border bg-muted/20 p-3">
                  {filteredReviewers.length === 0 && (
                    <p className="text-sm text-muted-foreground">{t('accessReviewForm.noReviewersFound')}</p>
                  )}
                  {filteredReviewers.map((reviewer) => (
                    <label key={reviewer.id} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={reviewerIds.includes(reviewer.id)}
                        onChange={() => toggleReviewer(reviewer.id)}
                        className="mt-1 h-4 w-4 rounded border-muted-foreground"
                      />
                      <span>
                        <span className="font-medium text-foreground">{reviewer.name}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{reviewer.email}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {reviewerIds.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t('accessReviewForm.reviewersSelectedCount', { count: reviewerIds.length })}</p>
                )}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="space-y-2">
                <label htmlFor="review-due-date" className="text-sm font-medium">
                  {t('accessReviewForm.deadline')}</label>
                <input
                  id="review-due-date"
                  type="date"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('dueDate')}
                />
                <p className="text-xs text-muted-foreground">
                  {t('accessReviewForm.setADeadlineToKeepReviewersOnSchedule')}</p>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={notifyReviewers}
                  {...register('notifyReviewers')}
                  className="h-4 w-4 rounded border-muted-foreground"
                />
                <span>{t('accessReviewForm.emailReviewersWhenTheCampaignStarts')}</span>
              </label>
            </>
          )}

          <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              {t('accessReviewForm.cancel')}</button>
            {step > 0 && (
              <button
                type="button"
                onClick={handleBack}
                disabled={isLoading}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('accessReviewForm.back')}</button>
            )}
            {step < steps.length - 1 && (
              <button
                type="button"
                onClick={handleNext}
                disabled={isLoading}
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('accessReviewForm.next')}</button>
            )}
            {step === steps.length - 1 && (
              <button
                type="submit"
                disabled={isLoading}
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isLoading ? t('accessReviewForm.creating') : t('accessReviewForm.createReview')}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
