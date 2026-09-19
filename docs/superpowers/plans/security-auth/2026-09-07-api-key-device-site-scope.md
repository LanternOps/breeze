# API-key device site authorization (RMM-QA-162)

The live-creator design shipped in #2514 requires delegated keys to retain the
creator's current site restriction. Two consumers still discard it: device
custom-field values and dev-push. #2071's earlier org-only exception predates that
design. Current #5044 normalized custom-field storage does not resolve this gap.

Use a narrow site-permissions view for both credentials, without fabricating user
roles or granting key scopes. Missing context denies; undefined allowedSiteIds
means unrestricted within the already-authorized org; an empty list denies all.
Keep session-compatible 403 responses. Service-principal keys remain org-wide as
specified by #2527; their lifecycle and scope ceiling remain enforced upstream.

Dev-push's agentId is a multipart field, so device authorization follows parsing
and input validation. It must precede copying the parsed binary into a buffer, filesystem writes, ephemeral
download registration and WebSocket dispatch. No parser or upload redesign.

Implementation and acceptance:

1. Share the narrow site view and fail-closed device gate across the two routes.
2. Exercise route denials, empty/allowed lists, missing session context and zero
   dev-push side effects with inert fixtures and mocked external I/O.
3. Use a private PostgreSQL/Redis stack with unprivileged breeze_app requests to
   verify session/key read parity, denied normalized writes and audits, successful
   allowed writes, post-mint restriction after production cache invalidation, and
   intentionally org-wide service-principal behavior.
4. Run affected unit/integration checks, full bounded API, typecheck and existing
   RLS/site contracts; independently review the exact head and finish CI.

No migrations or candidate/production verification. Refs #4060; merge and formal
QA closure remain separate from implementation evidence.
