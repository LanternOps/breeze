import { useState, useEffect, useCallback } from 'react';
import { Plus } from 'lucide-react';
import AlertRuleList, { type AlertRule } from './AlertRuleList';

type ModalMode = 'closed' | 'delete' | 'test';

export default function AlertRulesPage() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedRule, setSelectedRule] = useState<AlertRule | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const fetchRules = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch('/api/alerts/rules');
      if (!response.ok) {
        throw new Error('Failed to fetch alert rules');
      }
      const data = await response.json();
      setRules(data.rules ?? data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const handleEdit = (rule: AlertRule) => {
    window.location.href = `/alerts/rules/${rule.id}`;
  };

  const handleDelete = (rule: AlertRule) => {
    setSelectedRule(rule);
    setModalMode('delete');
  };

  const handleTest = async (rule: AlertRule) => {
    setSelectedRule(rule);
    setTestResult(null);
    setModalMode('test');
    setSubmitting(true);

    try {
      const response = await fetch(`/api/alerts/rules/${rule.id}/test`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error('Failed to test rule');
      }

      const data = await response.json();
      setTestResult({
        success: data.success ?? true,
        message: data.message ?? 'Test completed successfully'
      });
    } catch (err) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : 'An error occurred'
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (rule: AlertRule, enabled: boolean) => {
    try {
      const response = await fetch(`/api/alerts/rules/${rule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });

      if (!response.ok) {
        throw new Error(`Failed to ${enabled ? 'enable' : 'disable'} rule`);
      }

      setRules(prev =>
        prev.map(r => (r.id === rule.id ? { ...r, enabled } : r))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedRule(null);
    setTestResult(null);
  };

  const handleConfirmDelete = async () => {
    if (!selectedRule) return;

    setSubmitting(true);
    try {
      const response = await fetch(`/api/alerts/rules/${selectedRule.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete rule');
      }

      await fetchRules();
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
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading alert rules...</p>
        </div>
      </div>
    );
  }

  if (error && rules.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchRules}
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
          <h1 className="text-2xl font-bold">Alert Rules</h1>
          <p className="text-muted-foreground">Configure when and how alerts are triggered.</p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/alerts/channels"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            Notification Channels
          </a>
          <a
            href="/alerts/rules/new"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            New Rule
          </a>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <AlertRuleList
        rules={rules}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onTest={handleTest}
        onToggle={handleToggle}
      />

      {/* Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedRule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete Alert Rule</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete <span className="font-medium">{selectedRule.name}</span>?
              This action cannot be undone.
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

      {/* Test Result Modal */}
      {modalMode === 'test' && selectedRule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Test Alert Rule</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Testing <span className="font-medium">{selectedRule.name}</span>
            </p>
            {submitting ? (
              <div className="mt-4 flex items-center gap-2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                <span className="text-sm">Running test...</span>
              </div>
            ) : testResult ? (
              <div
                className={`mt-4 rounded-md border p-3 ${
                  testResult.success
                    ? 'border-green-500/40 bg-green-500/10 text-green-700'
                    : 'border-red-500/40 bg-red-500/10 text-red-700'
                }`}
              >
                <p className="text-sm font-medium">
                  {testResult.success ? 'Test Passed' : 'Test Failed'}
                </p>
                <p className="text-sm mt-1">{testResult.message}</p>
              </div>
            ) : null}
            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium transition hover:bg-muted"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
