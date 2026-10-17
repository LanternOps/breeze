// Owner: W02b (declared controls) — Trust Center W2 (#8770).
import { z } from 'zod';
import { DECLARED_CONTROL_IDS } from '../trustCenter/declaredCatalog';

export const TRUST_DECLARATION_STATEMENT_MIN_CHARS = 10;
export const TRUST_DECLARATION_STATEMENT_MAX_CHARS = 1000;

/** Declare (or re-declare, which supersedes the active row) one declared catalog control (spec §18.2). */
export const trustDeclarationCreateSchema = z.strictObject({
  controlId: z.enum(DECLARED_CONTROL_IDS),
  statement: z.string().trim().min(TRUST_DECLARATION_STATEMENT_MIN_CHARS).max(TRUST_DECLARATION_STATEMENT_MAX_CHARS),
  evidenceDocumentId: z.string().guid().nullable(),
  expectedRevision: z.number().int().min(0),
});
export type TrustDeclarationCreateInput = z.infer<typeof trustDeclarationCreateSchema>;

export const trustDeclarationWithdrawSchema = z.strictObject({ expectedRevision: z.number().int().min(0) });
export type TrustDeclarationWithdrawInput = z.infer<typeof trustDeclarationWithdrawSchema>;
