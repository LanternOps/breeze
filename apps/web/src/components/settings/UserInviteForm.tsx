import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const inviteSchema = z
  .object({
    email: z.string().email('Enter a valid email address'),
    role: z.string().min(1, 'Select a role'),
    accessLevel: z.enum(['all', 'specific']).optional(),
    orgs: z.string().optional()
  })
  .superRefine((data, ctx) => {
    if (data.role.toLowerCase() !== 'partner') {
      return;
    }

    if (!data.accessLevel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accessLevel'],
        message: 'Select an access level for partner users'
      });
    }

    if (data.accessLevel === 'specific' && !data.orgs?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orgs'],
        message: 'Provide at least one organization'
      });
    }
  });

type InviteFormValues = z.infer<typeof inviteSchema>;

type UserInviteFormProps = {
  isOpen?: boolean;
  roles?: string[];
  onSubmit?: (values: InviteFormValues) => void | Promise<void>;
  onCancel?: () => void;
  errorMessage?: string;
  submitLabel?: string;
  loading?: boolean;
  title?: string;
  description?: string;
};

const defaultRoles = ['Admin', 'Member', 'Partner', 'Viewer'];

export default function UserInviteForm({
  isOpen = true,
  roles = defaultRoles,
  onSubmit,
  onCancel,
  errorMessage,
  submitLabel = 'Send invite',
  loading,
  title = 'Invite user',
  description = 'Send an invitation with the right access for their role.'
}: UserInviteFormProps) {
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting }
  } = useForm<InviteFormValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: {
      email: '',
      role: roles[0] ?? '',
      accessLevel: 'all',
      orgs: ''
    }
  });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const roleValue = watch('role');
  const showPartnerSettings = roleValue?.toLowerCase() === 'partner';

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>

        <form
          onSubmit={handleSubmit(async values => {
            await onSubmit?.(values);
          })}
          className="mt-6 space-y-5"
        >
          <div className="space-y-2">
            <label htmlFor="invite-email" className="text-sm font-medium">
              Email
            </label>
            <input
              id="invite-email"
              type="email"
              autoComplete="email"
              placeholder="name@company.com"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('email')}
            />
            {errors.email && (
              <p className="text-sm text-destructive">{errors.email.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="invite-role" className="text-sm font-medium">
              Role
            </label>
            <select
              id="invite-role"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('role')}
            >
              {roles.map(role => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            {errors.role && <p className="text-sm text-destructive">{errors.role.message}</p>}
          </div>

          {showPartnerSettings && (
            <div className="space-y-3 rounded-md border bg-muted/30 p-4">
              <div>
                <h3 className="text-sm font-semibold">Organization access</h3>
                <p className="text-xs text-muted-foreground">
                  Choose which organizations a partner can access.
                </p>
              </div>
              <div className="space-y-2">
                <label htmlFor="invite-access" className="text-sm font-medium">
                  Access level
                </label>
                <select
                  id="invite-access"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  {...register('accessLevel')}
                >
                  <option value="all">All organizations</option>
                  <option value="specific">Specific organizations</option>
                </select>
                {errors.accessLevel && (
                  <p className="text-sm text-destructive">{errors.accessLevel.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <label htmlFor="invite-orgs" className="text-sm font-medium">
                  Organizations
                </label>
                <input
                  id="invite-orgs"
                  type="text"
                  placeholder="Org names or IDs (comma separated)"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  {...register('orgs')}
                />
                <p className="text-xs text-muted-foreground">
                  Leave blank for full access or list the allowed organizations.
                </p>
                {errors.orgs && (
                  <p className="text-sm text-destructive">{errors.orgs.message}</p>
                )}
              </div>
            </div>
          )}

          {errorMessage && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => onCancel?.()}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? 'Sending...' : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
