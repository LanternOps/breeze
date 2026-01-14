import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, AlertCircle, ArrowLeft } from 'lucide-react';
import { portalApi } from '@/lib/api';
import { cn } from '@/lib/utils';

const ticketSchema = z.object({
  title: z.string().min(5, 'Title must be at least 5 characters'),
  description: z.string().min(20, 'Please provide a detailed description (at least 20 characters)'),
  priority: z.enum(['low', 'medium', 'high', 'critical'])
});

type TicketFormData = z.infer<typeof ticketSchema>;

export function NewTicketForm() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors }
  } = useForm<TicketFormData>({
    resolver: zodResolver(ticketSchema),
    defaultValues: {
      priority: 'medium'
    }
  });

  const onSubmit = async (data: TicketFormData) => {
    setIsLoading(true);
    setError(null);

    const result = await portalApi.createTicket({
      ...data,
      status: 'open'
    });

    if (result.data) {
      window.location.href = `/tickets/${result.data.id}`;
    } else {
      setError(result.error || 'Failed to create ticket');
    }

    setIsLoading(false);
  };

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <a
          href="/tickets"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to tickets
        </a>
      </div>

      <div className="rounded-lg border bg-card p-6">
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
            <label
              htmlFor="title"
              className="block text-sm font-medium text-foreground"
            >
              Title
            </label>
            <input
              id="title"
              type="text"
              placeholder="Brief summary of your issue"
              {...register('title')}
              className={cn(
                'mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm',
                'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
                errors.title && 'border-destructive'
              )}
            />
            {errors.title && (
              <p className="mt-1 text-sm text-destructive">
                {errors.title.message}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="priority"
              className="block text-sm font-medium text-foreground"
            >
              Priority
            </label>
            <select
              id="priority"
              {...register('priority')}
              className={cn(
                'mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm',
                'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary'
              )}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              Select the urgency level of your issue
            </p>
          </div>

          <div>
            <label
              htmlFor="description"
              className="block text-sm font-medium text-foreground"
            >
              Description
            </label>
            <textarea
              id="description"
              rows={6}
              placeholder="Please provide detailed information about your issue..."
              {...register('description')}
              className={cn(
                'mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm',
                'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
                errors.description && 'border-destructive'
              )}
            />
            {errors.description && (
              <p className="mt-1 text-sm text-destructive">
                {errors.description.message}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-3">
            <a
              href="/tickets"
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </a>
            <button
              type="submit"
              disabled={isLoading}
              className={cn(
                'flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground',
                'hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
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
      </div>
    </div>
  );
}

export default NewTicketForm;
