-- Undo-send window: a scheduled (delayed) quote send is recorded on the quote
-- row so the UI can show "Sending in Ns — Undo" and the cancel endpoint can
-- verify there is something to cancel. The email dispatch itself lives in a
-- delayed BullMQ job (quote-send queue); these columns are the UI/cancel
-- bookkeeping, cleared when the job fires, fails, or is undone. Existing-table
-- columns only: quotes' RLS policies and cascade registrations are unchanged.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS send_scheduled_at timestamptz;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS send_job_id text;
-- Email outcome of the (delayed) dispatch: null = delivered (or not sent
-- yet); a reason code when the send committed but no email went out. The UI
-- surfaces this as the honest post-flip warning the synchronous path used to
-- toast directly.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS send_email_reason text;
