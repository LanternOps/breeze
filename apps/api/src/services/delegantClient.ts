import { SignJWT, importPKCS8 } from 'jose';
import { randomUUID } from 'node:crypto';

interface MintArgs {
  signingKeyPem: string;
  kid: string;
  agentPrincipalId: string;
  breezeOrgId: string; // accepted but not placed in token; delegantOrgId is authoritative
  delegantOrgId: string;
  actingUserBreezeId: string;
  actingUserDelegantId: string;
  sessionId: string;
  nowSeconds: number;
}

async function mintPrincipalJwt(args: MintArgs): Promise<string> {
  const key = await importPKCS8(args.signingKeyPem, 'EdDSA');
  return new SignJWT({
    breeze_org_id: args.delegantOrgId,
    principal_type: 'breeze_ai_agent',
    breeze_user_id: args.actingUserBreezeId,
    breeze_acting_user_id: args.actingUserDelegantId,
    breeze_session_id: args.sessionId,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: args.kid })
    .setSubject(args.agentPrincipalId)
    .setIssuer('breeze-api')
    .setAudience('delegant')
    .setIssuedAt(args.nowSeconds)
    .setExpirationTime(args.nowSeconds + 60)
    .setJti(randomUUID())
    .sign(key);
}

export const __mintPrincipalJwtForTest = mintPrincipalJwt;
