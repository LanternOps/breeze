-- AI model registry W03 (#7601), W02 handoff #5 / spec §5.6: every session is
-- created on a resolved offering, which names its model (chat, script
-- builder, helper and Office write the resolved model; agent runs and the
-- external-MCP ledger write theirs explicitly). The stale default named a
-- retired model id, so a row inserted without a model must fail loudly.
-- DDL only: DROP DEFAULT is idempotent and writes no rows.
ALTER TABLE public.ai_sessions ALTER COLUMN model DROP DEFAULT;
