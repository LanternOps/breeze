import { useState, useEffect, useCallback } from 'react';
import { Plus } from 'lucide-react';
import WebhookList, { type Webhook } from './WebhookList';
import WebhookForm, { type WebhookFormValues } from './WebhookForm';

type ModalMode = 'closed' | 'create' | 'edit' | 'delete';

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedWebhook, setSelectedWebhook] = useState<Webhook | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchWebhooks = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch('/api/webhooks');
      if (!response.ok) {
        throw new Error('Failed to fetch webhooks');
      }
      const data = await response.json();
      setWebhooks(data.webhooks ?? data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWebhooks();
  }, [fetchWebhooks]);

  const handleCreate = () => {
    setSelectedWebhook(null);
    setModalMode('create');
  };

  const handleEdit = (webhook: Webhook) => {
    setSelectedWebhook(webhook);
    setModalMode('edit');
  };

  const handleDelete = (webhook: Webhook) => {
    setSelectedWebhook(webhook);
    setModalMode('delete');
  };

  const handleTest = async (webhook: Webhook) => {
    try {
      const response = await fetch(`/api/webhooks/${webhook.id}/test`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error('Test failed');
      }

      await fetchWebhooks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test failed');
    }
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedWebhook(null);
  };

  const transformFormToPayload = (values: WebhookFormValues) => {
    return {
      name: values.name,
      url: values.url,
      secret: values.secret,
      events: values.events,
      headers: values.headers?.filter(header => header.key) ?? []
    };
  };

  const transformWebhookToForm = (webhook: Webhook): Partial<WebhookFormValues> => {
    return {
      name: webhook.name,
      url: webhook.url,
      secret: webhook.secret ?? '',
      events: webhook.events ?? [],
      headers: webhook.headers ?? []
    };
  };

  const handleSubmit = async (values: WebhookFormValues) => {
    setSubmitting(true);
    setError(undefined);

    try {
      const payload = transformFormToPayload(values);
      const url =
        modalMode === 'create' ? '/api/webhooks' : `/api/webhooks/${selectedWebhook?.id}`;
      const method = modalMode === 'create' ? 'POST' : 'PUT';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save webhook');
      }

      await fetchWebhooks();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedWebhook) return;

    setSubmitting(true);
    try {
      const response = await fetch(`/api/webhooks/${selectedWebhook.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete webhook');
      }

      await fetchWebhooks();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading webhooks...</p>
        </div>
      </div>
    );
  }

  if (error && webhooks.length === 0 && modalMode === 'closed') {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchWebhooks}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Webhooks</h1>
          <p className="text-muted-foreground">Deliver events to external systems.</p>
        </div>
        <button
          type="button"
          onClick={handleCreate}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New Webhook
        </button>
      </div>

      {error && modalMode === 'closed' && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <WebhookList
        webhooks={webhooks}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onTest={handleTest}
      />

      {(modalMode === 'create' || modalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 px-4 py-8">
          <div className="w-full max-w-3xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-bold">
                {modalMode === 'create' ? 'Create Webhook' : 'Edit Webhook'}
              </h2>
            </div>
            {error && (
              <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            <WebhookForm
              onSubmit={handleSubmit}
              onCancel={handleCloseModal}
              defaultValues={
                modalMode === 'edit' && selectedWebhook
                  ? transformWebhookToForm(selectedWebhook)
                  : undefined
              }
              submitLabel={modalMode === 'create' ? 'Create Webhook' : 'Save Changes'}
              loading={submitting}
            />
          </div>
        </div>
      )}

      {modalMode === 'delete' && selectedWebhook && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete Webhook</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete{' '}
              <span className="font-medium">{selectedWebhook.name}</span>? This action cannot be
              undone.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
