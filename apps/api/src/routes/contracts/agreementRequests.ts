import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { recordSignedAgreementFromForm, recordSignedAgreementSchema } from '@breeze/shared';
import { requireScope, requirePermission, withAuthDbAccessContext, type AuthContext } from '../../middleware/auth';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { loadTemplateVersionRenderData } from '../../services/contractTemplateRender';
import { assertTemplateVersionUsable, ContractTemplateServiceError } from '../../services/contractTemplateService';
import {
  AgreementRequestServiceError,
  loadOrgOwnerPartnerId,
  recordSignedAgreement,
} from '../../services/agreementRequestService';
import { recordedOnBehalfAuditEvent } from '../../services/agreementRecordedOnBehalfAudit';
import { QUOTE_ACCEPTANCE_EVIDENCE_MAX_BYTES } from '../../services/quoteAcceptanceEvidence';
import { QuoteServiceError } from '../../services/quoteTypes';
import type { AgreementRequestRow } from '../../db/schema/contractDocuments';

// Standalone agreement requests (#8865), mounted at
// /contracts/agreement-requests. W1c ships only record-signed; W2 adds
// create/send/void and the portal/public accept.
export const agreementRequestRoutes = new Hono();

const scopes = requireScope('partner', 'organization', 'system');
// W1: gated on agreements:write. W2 moves record-signed to agreements:send.
const writePerm = requirePermission(PERMISSIONS.AGREEMENTS_WRITE.resource, PERMISSIONS.AGREEMENTS_WRITE.action);

/** Never put the link-token or public-response bookkeeping on the wire. */
function serializeRequest(row: AgreementRequestRow) {
  const {
    acceptTokenJti: _jti,
    acceptTokenIssuedAt: _iat,
    acceptTokenExpiresAt: _exp,
    acceptTokenKid: _kid,
    publicResponseJti: _pjti,
    publicResponseConsumedAt: _pcon,
    publicResponseOutcome: _pout,
    ...rest
  } = row;
  return rest;
}

function handleError(c: Context, err: unknown): Response {
  if (
    err instanceof AgreementRequestServiceError ||
    err instanceof ContractTemplateServiceError ||
    err instanceof QuoteServiceError
  ) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

// POST /record-signed — multipart. An MSP tech files an agreement the client
// signed elsewhere (spec §3.4): a request is created and signed in ONE system
// transaction, with an optional externally signed copy (PDF/PNG/JPEG ≤ 10 MB).
//
// Context discipline: org access is checked from the token; the org's owning
// partner, the pinned template version and the template guard are read in the
// request's OWN auth context (staff path — partner-wide templates are visible
// through the partner-wide SELECT branch); only the request insert + freeze run
// system-scoped, exactly like the quote accept-on-behalf. Registered in
// SELF_MANAGED_DB_CONTEXT_ROUTES so the middleware's ambient transaction is
// not held alongside the system one.
agreementRequestRoutes.post(
  '/record-signed',
  scopes,
  writePerm,
  // Multipart overhead headroom; the exact 10 MB cap is enforced on the bytes.
  bodyLimit({
    maxSize: QUOTE_ACCEPTANCE_EVIDENCE_MAX_BYTES + 64 * 1024,
    onError: (c) => c.json({ error: 'Signed copy too large (max 10 MB)', code: 'FILE_TOO_LARGE' }, 413),
  }),
  async (c) => {
    const auth = c.get('auth') as AuthContext;

    const contentType = c.req.header('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      return c.json({ error: 'Expected a multipart/form-data body', code: 'INVALID_MULTIPART' }, 400);
    }
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody({ all: true });
    } catch {
      return c.json({ error: 'Invalid multipart body', code: 'INVALID_MULTIPART' }, 400);
    }

    const rawFile = form.file;
    if (rawFile !== undefined && !(rawFile instanceof File)) {
      return c.json({ error: 'The "file" part must be a single uploaded file', code: 'INVALID_FILE' }, 400);
    }

    const parsed = recordSignedAgreementSchema.safeParse(recordSignedAgreementFromForm(form));
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
    }
    const input = parsed.data;

    // Never 403: do not reveal that an org outside the caller's access exists.
    if (!auth.canAccessOrg(input.orgId)) {
      return c.json({ error: 'Organization not found', code: 'ORG_NOT_FOUND' }, 404);
    }

    try {
      const file = rawFile
        ? { buffer: Buffer.from(await rawFile.arrayBuffer()), filename: rawFile.name ?? '' }
        : null;

      const renderData = await withAuthDbAccessContext(auth, async () => {
        const partnerId = await loadOrgOwnerPartnerId(input.orgId);
        // The template's own bytes are only frozen when no signed copy was
        // uploaded (an uploaded-type template rendered as itself).
        const data = await loadTemplateVersionRenderData(input.templateVersionId, { includeFileData: file === null });
        await assertTemplateVersionUsable(
          { templateId: data.templateId, templateVersionId: input.templateVersionId },
          { orgId: input.orgId, partnerId },
        );
        return data;
      });

      const res = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          recordSignedAgreement({
            input,
            renderData,
            callerPartnerId: auth.partnerId ?? null,
            actorUserId: auth.user?.id ?? null,
            // Never the raw header: the trusted-proxy policy applies. Clamped to
            // the column width. The TECH's IP/UA, as on the quote on-behalf path.
            actorIp: getTrustedClientIpOrUndefined(c)?.slice(0, 64) ?? null,
            actorUserAgent: c.req.header('user-agent') ?? null,
            file,
            now: new Date(),
          }),
        ),
      );

      writeRouteAudit(
        c,
        recordedOnBehalfAuditEvent({
          requestId: res.request.id,
          orgId: input.orgId,
          signedAgreementId: res.signedAgreementId,
          method: input.method,
          reference: input.reference,
          signerName: input.signerName,
          signerEmail: input.signerEmail ?? null,
          templateVersionId: input.templateVersionId,
          contractId: input.contractId ?? null,
          contentSha256: res.contentSha256,
          external: file !== null,
        }),
      );

      return c.json(
        { data: { request: serializeRequest(res.request), signedAgreementId: res.signedAgreementId, contentSha256: res.contentSha256 } },
        201,
      );
    } catch (err) {
      return handleError(c, err);
    }
  },
);
