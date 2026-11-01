import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  agreementRequestDefaultsQuerySchema,
  createAgreementRequestSchema,
  listAgreementRequestsQuerySchema,
  recordSignedAgreementFromForm,
  recordSignedAgreementSchema,
  updateAgreementRequestSchema,
  voidAgreementRequestSchema,
} from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission, withAuthDbAccessContext, type AuthContext } from '../../middleware/auth';
import { runAfterDbContextCommit, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
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
import {
  createAgreementRequest,
  deleteAgreementRequest,
  getAgreementRequestDefaults,
  getAgreementRequestDetail,
  getAgreementRequestLink,
  listAgreementRequests,
  previewAgreementRequest,
  remindAgreementRequest,
  sendAgreementRequest,
  toAgreementRequestDto,
  updateAgreementRequest,
  voidAgreementRequest,
} from '../../services/agreementRequestLifecycle';
import { revokeAgreementAcceptJti } from '../../services/agreementAcceptToken';
import { captureException } from '../../services/sentry';
import { emitAgreementEventForOrg } from '../../services/agreementEvents';

// Standalone agreement requests (#8865), mounted at
// /contracts/agreement-requests. W1c: record-signed. #9075 W2a: the staff
// lifecycle (list / detail / draft create-patch-delete / preview / send / copy
// link / void). The public accept routes are routes/agreementsPublic.ts (W2b);
// portal is W3a; remind + the agreement.* bus events are W3b.
//
// DB context: the lifecycle routes run in the ordinary request context (RLS on
// breeze_has_org_access). Two are registered in SELF_MANAGED_DB_CONTEXT_ROUTES:
// record-signed (opens a system transaction) and send / remind (a short auth
// transaction, then the email after it commits).
export const agreementRequestRoutes = new Hono();

const scopes = requireScope('partner', 'organization', 'system');
// Spec §5 / OD7 B (#9075 W2a): reads = agreements:read; draft create / patch /
// delete = agreements:write; send, copy link, void and record-signed =
// agreements:send (record-signed moved off agreements:write here; the
// 2027-01-05-110000 migration back-fills send to every role holding write).
const sendPerm = requirePermission(PERMISSIONS.AGREEMENTS_SEND.resource, PERMISSIONS.AGREEMENTS_SEND.action);
const readPerm = requirePermission(PERMISSIONS.AGREEMENTS_READ.resource, PERMISSIONS.AGREEMENTS_READ.action);
const writePerm = requirePermission(PERMISSIONS.AGREEMENTS_WRITE.resource, PERMISSIONS.AGREEMENTS_WRITE.action);

const idParam = z.object({ id: z.string().guid() });

/** Never put the link-token or public-response bookkeeping on the wire. */
const serializeRequest = toAgreementRequestDto;

function authFrom(c: Context): AuthContext {
  return c.get('auth') as AuthContext;
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
  sendPerm,
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

      // Post-commit bus event (before the audit write, which could throw): an integration must see an MSP-recorded
      // signature too, tagged on_behalf (the customer path emits from
      // notifyAgreementOutcome). Never rejects.
      await emitAgreementEventForOrg({
        type: 'agreement.signed', requestId: res.request.id, orgId: input.orgId, origin: 'on_behalf', actorUserId: auth.user?.id ?? null,
      });

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

// ---------------------------------------------------------------------------
// Lifecycle (#9075 W2a, spec §5). Every mutation is audited
// (billing.agreement.*); a link is a bearer credential and is never written to
// the audit log.
// ---------------------------------------------------------------------------

agreementRequestRoutes.get('/', scopes, readPerm, zValidator('query', listAgreementRequestsQuerySchema), async (c) => {
  try {
    return c.json({ data: await listAgreementRequests(authFrom(c), c.req.valid('query')) });
  } catch (err) {
    return handleError(c, err);
  }
});

// GET /defaults?orgId= — the partner's resolved agreement defaults for that org
// (#9075 W4a): the Send dialog pre-fills its expiry from them and says whether
// automatic reminders will go out. Registered BEFORE /:id so "defaults" is
// never parsed as an id.
agreementRequestRoutes.get('/defaults', scopes, readPerm, zValidator('query', agreementRequestDefaultsQuerySchema), async (c) => {
  try {
    return c.json({ data: await getAgreementRequestDefaults(authFrom(c), c.req.valid('query').orgId) });
  } catch (err) {
    return handleError(c, err);
  }
});

agreementRequestRoutes.post('/', scopes, writePerm, zValidator('json', createAgreementRequestSchema), async (c) => {
  try {
    const input = c.req.valid('json');
    const detail = await createAgreementRequest(authFrom(c), input, new Date());
    writeRouteAudit(c, {
      orgId: detail.orgId,
      action: 'billing.agreement.request_created',
      resourceType: 'agreement_request',
      resourceId: detail.id,
      result: 'success',
      details: {
        templateId: detail.templateId,
        templateVersionId: detail.templateVersionId,
        contractId: detail.contractId,
        recipientCount: detail.recipients.length,
        expiresAt: detail.expiresAt,
      },
    });
    return c.json({ data: detail }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

agreementRequestRoutes.get('/:id', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try {
    return c.json({ data: await getAgreementRequestDetail(authFrom(c), c.req.valid('param').id) });
  } catch (err) {
    return handleError(c, err);
  }
});

agreementRequestRoutes.patch(
  '/:id',
  scopes,
  writePerm,
  zValidator('param', idParam),
  zValidator('json', updateAgreementRequestSchema),
  async (c) => {
    try {
      const { id } = c.req.valid('param');
      const input = c.req.valid('json');
      const detail = await updateAgreementRequest(authFrom(c), id, input, new Date());
      writeRouteAudit(c, {
        orgId: detail.orgId,
        action: 'billing.agreement.request_updated',
        resourceType: 'agreement_request',
        resourceId: id,
        result: 'success',
        details: { fields: Object.keys(input).sort() },
      });
      return c.json({ data: detail });
    } catch (err) {
      return handleError(c, err);
    }
  },
);

agreementRequestRoutes.delete('/:id', scopes, writePerm, zValidator('param', idParam), async (c) => {
  try {
    const { id } = c.req.valid('param');
    const deleted = await deleteAgreementRequest(authFrom(c), id);
    writeRouteAudit(c, {
      orgId: deleted.orgId,
      action: 'billing.agreement.request_deleted',
      resourceType: 'agreement_request',
      resourceId: id,
      result: 'success',
    });
    return c.json({ data: { id } });
  } catch (err) {
    return handleError(c, err);
  }
});

agreementRequestRoutes.get('/:id/preview', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try {
    return c.json({ data: await previewAgreementRequest(authFrom(c), c.req.valid('param').id, new Date()) });
  } catch (err) {
    return handleError(c, err);
  }
});

// POST /:id/send — draft → sent, then email the recipients (#9075 W2b).
//
// Two transactions' worth of work, not one (the quotes/:id/send #3905 shape):
// this route is registered in SELF_MANAGED_DB_CONTEXT_ROUTES, so the auth
// middleware opens NO ambient request transaction. withAuthDbAccessContext
// opens a short one (RLS as the caller) that COMMITS when the transition
// resolves; only then does the deferred delivery run the mail round-trip, so no
// request-row lock or pooled connection is held across SMTP. Do NOT collapse
// the two awaits into one context. A committed send whose mail failed is a 200
// with emailed:false + emailReason, never a 500 the sender would retry into a 409.
agreementRequestRoutes.post('/:id/send', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  try {
    const { id } = c.req.valid('param');
    const auth = authFrom(c);
    const res = await withAuthDbAccessContext(auth, () => sendAgreementRequest(auth, id, new Date()));
    // Announce right after the commit, before the audit/mail steps that could
    // throw (a lost event cannot be replayed: a retry hits a 409). Never rejects.
    await emitAgreementEventForOrg({ type: 'agreement.sent', requestId: id, orgId: res.request.orgId, actorUserId: auth.user?.id ?? null });
    // Post-commit. Never rejects (every failure is an emailReason).
    const delivery = await res.deliverEmail();
    writeRouteAudit(c, {
      orgId: res.request.orgId,
      action: 'billing.agreement.sent',
      resourceType: 'agreement_request',
      resourceId: id,
      result: 'success',
      details: {
        templateVersionId: res.request.templateVersionId,
        recipientCount: res.recipients.length,
        expiresAt: res.request.expiresAt,
        emailed: delivery.emailed,
        ...(delivery.emailReason ? { emailReason: delivery.emailReason } : {}),
      },
    });
    return c.json({ data: {
      request: res.request,
      emailed: delivery.emailed,
      emailReason: delivery.emailReason,
      link: res.link,
      recipients: res.recipients,
    } });
  } catch (err) {
    return handleError(c, err);
  }
});

// POST /:id/remind — re-send the SAME link to the recipients (#9075 W3b, spec
// §3.5). Same two-step shape as send (registered in
// SELF_MANAGED_DB_CONTEXT_ROUTES): the status gate + counter bump commit in a
// short auth transaction, THEN the mail round-trip runs. 409 unless
// sent/viewed; a committed bump whose mail failed is a 200 with emailed:false.
// Not a lifecycle transition, so no bus event. The link is not echoed back —
// copy-link is the (audited) dispenser of the credential.
agreementRequestRoutes.post('/:id/remind', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  try {
    const { id } = c.req.valid('param');
    const auth = authFrom(c);
    const res = await withAuthDbAccessContext(auth, () => remindAgreementRequest(auth, id, new Date()));
    const delivery = await res.deliverEmail();
    writeRouteAudit(c, {
      orgId: res.request.orgId,
      action: 'billing.agreement.reminded',
      resourceType: 'agreement_request',
      resourceId: id,
      result: 'success',
      details: {
        recipientCount: res.recipients.length,
        reminderCount: res.request.reminderCount,
        reissued: res.reissued,
        emailed: delivery.emailed,
        ...(delivery.emailReason ? { emailReason: delivery.emailReason } : {}),
      },
    });
    return c.json({ data: {
      request: res.request,
      emailed: delivery.emailed,
      emailReason: delivery.emailReason,
      recipients: res.recipients,
    } });
  } catch (err) {
    return handleError(c, err);
  }
});

// GET /:id/link — copy link. Dispenses a live signing credential, so it is
// send-gated and audited (the link itself is never logged).
agreementRequestRoutes.get('/:id/link', scopes, sendPerm, zValidator('param', idParam), async (c) => {
  try {
    const { id } = c.req.valid('param');
    const res = await getAgreementRequestLink(authFrom(c), id, new Date());
    writeRouteAudit(c, {
      orgId: res.orgId,
      action: 'billing.agreement.link_copied',
      resourceType: 'agreement_request',
      resourceId: id,
      result: 'success',
      details: { reissued: res.reissued },
    });
    return c.json({ data: { link: res.link, reissued: res.reissued } });
  } catch (err) {
    return handleError(c, err);
  }
});

// POST /:id/void — kills the link durably (public_link_revoked_at) in the
// transaction; the Redis jti marker is armed only AFTER commit (spec §3.3
// step 8), so a rolled-back void never touches the hot path.
agreementRequestRoutes.post(
  '/:id/void',
  scopes,
  sendPerm,
  zValidator('param', idParam),
  zValidator('json', voidAgreementRequestSchema),
  async (c) => {
    try {
      const { id } = c.req.valid('param');
      const input = c.req.valid('json');
      const res = await voidAgreementRequest(authFrom(c), id, input, new Date());
      const revoke = res.revoke;
      if (revoke) {
        runAfterDbContextCommit('agreement-request.void.revoke-jti', async () => {
          try {
            await revokeAgreementAcceptJti(revoke.jti, revoke.tokenExpiresAt);
          } catch (err) {
            // The durable kill (public_link_revoked_at) already holds; a lost
            // hot-path marker only costs a DB read on the next public hit.
            console.error('[agreementRequests] post-commit jti revoke failed', err);
            captureException(err instanceof Error ? err : new Error(String(err)));
          }
        });
      }
      // Announce the committed void; a rolled-back one is dropped (commitOnly).
      const voidedOrgId = res.request.orgId;
      const actorUserId = authFrom(c).user?.id ?? null;
      runAfterDbContextCommit('agreement-request.void.emit', () =>
        emitAgreementEventForOrg({ type: 'agreement.voided', requestId: id, orgId: voidedOrgId, actorUserId }));
      writeRouteAudit(c, {
        orgId: res.request.orgId,
        action: 'billing.agreement.voided',
        resourceType: 'agreement_request',
        resourceId: id,
        result: 'success',
        details: { reason: res.request.voidReason },
      });
      return c.json({ data: res.request });
    } catch (err) {
      return handleError(c, err);
    }
  },
);
