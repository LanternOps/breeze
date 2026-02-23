import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const inviteSchema = z
  .object({
    email: z.string().email('Enter a valid email address'),
    name: z.string().min(1, 'Name is required').max(255),
    roleId: z.string().min(1, 'Select a role'),
    orgAccess: z.enum(['all', 'selected', 'none']).optional(),
    orgIds: z.string().optional()
  })
  .superRefine((data, ctx) => {
    if (data.orgAccess === 'selected' && !data.orgIds?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orgIds'],
        message: 'Provide at least one organization'
      });
    }
  });

type InviteFormValues = z.infer<typeof inviteSchema>;

export type RoleOption = {
  id: string;
  name: string;
  scope: string;
};

type UserInviteFormProps = {
  isOpen?: boolean;
  roles?: RoleOption[];
  onSubmit?: (values: InviteFormValues) => void | Promise<void>;
  onCancel?: () => void;
  errorMessage?: string;
  submitLabel?: string;
  loading?: boolean;
  title?: string;
  description?: string;
  showOrgAccess?: boolean;
};

export default function UserInviteForm({
  isOpen = true,
  roles = [],
  onSubmit,
  onCancel,
  errorMessage,
  submitLabel = 'Send invite',
  loading,
  title = 'Invite user',
  description = 'Send an invitation with the right access for their role.',
  showOrgAccess = false
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
      name: '',
      roleId: roles[0]?.id ?? '',
      orgAccess: 'all',
      orgIds: ''
    }
  });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const orgAccessValue = watch('orgAccess');
  const showOrgSettings = showOrgAccess && orgAccessValue !== undefined;

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
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="invite-name" className="text-sm font-medium">
                Name
              </label>
              <input
                id="invite-name"
                type="text"
                autoComplete="name"
                placeholder="Jane Smith"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                {...register('name')}
              />
              {errors.name && (
                <p className="text-sm text-destructive">{errors.name.message}</p>
              )}
            </div>

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
          </div>

          <div className="space-y-2">
            <label htmlFor="invite-role" className="text-sm font-medium">
              Role
            </label>
            <select
              id="invite-role"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('roleId')}
            >
              {roles.map(role => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
            {errors.roleId && <p className="text-sm text-destructive">{errors.roleId.message}</p>}
          </div>

          {showOrgSettings && (
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
                  {...register('orgAccess')}
                >
                  <option value="all">All organizations</option>
                  <option value="selected">Specific organizations</option>
                  <option value="none">No organization access</option>
                </select>
                {errors.orgAccess && (
                  <p className="text-sm text-destructive">{errors.orgAccess.message}</p>
                )}
              </div>
              {orgAccessValue === 'selected' && (
                <div className="space-y-2">
                  <label htmlFor="invite-orgs" className="text-sm font-medium">
                    Organization IDs
                  </label>
                  <input
                    id="invite-orgs"
                    type="text"
                    placeholder="Organization IDs (comma separated)"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    {...register('orgIds')}
                  />
                  {errors.orgIds && (
                    <p className="text-sm text-destructive">{errors.orgIds.message}</p>
                  )}
                </div>
              )}
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
