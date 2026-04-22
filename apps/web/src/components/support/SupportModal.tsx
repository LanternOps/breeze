import { useState } from 'react';
import { X } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { showToast } from '../shared/Toast';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SupportModal({ open, onClose }: Props) {
  const { user } = useAuthStore();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const submit = async () => {
    if (!subject.trim() || !message.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetchWithAuth('/support', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject: subject.trim(), message: message.trim() }),
      });
      if (res.ok) {
        showToast({ type: 'success', message: 'Support request sent' });
        setSubject('');
        setMessage('');
        onClose();
      } else {
        const body = await res.json().catch(() => ({}));
        console.error('[support] send failed', { status: res.status, body });
        const code = typeof body.error === 'string' ? body.error : '';
        const messages: Record<string, string> = {
          not_configured: 'Support is not available on this deployment.',
          upstream_unavailable: 'Support service is temporarily unavailable. Please try again in a moment.',
          upstream_invalid_response: 'Support service returned an unexpected response. Please try again.',
          rate_limited: 'Too many requests. Please wait a few minutes and try again.',
          invalid_body: 'Please fill in subject and message.',
        };
        const message = messages[code] ?? 'Failed to send support request. Please try again.';
        showToast({ type: 'error', message });
      }
    } catch (err) {
      console.error('[support] request threw', err);
      showToast({ type: 'error', message: 'Support request failed' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg border bg-background p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Contact support</h2>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Sending as <span className="font-medium">{user?.name}</span> &lt;{user?.email}&gt;
        </p>
        <div className="space-y-3">
          <div>
            <label htmlFor="support-subject" className="mb-1 block text-sm font-medium">
              Subject
            </label>
            <input
              id="support-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={300}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="Brief description"
            />
          </div>
          <div>
            <label htmlFor="support-message" className="mb-1 block text-sm font-medium">
              Message
            </label>
            <textarea
              id="support-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={10_000}
              rows={8}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="What can we help with?"
            />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !subject.trim() || !message.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
