import { randomBytes, createHash } from 'crypto';

// ============================================
// Types
// ============================================

export interface OIDCConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  jwksUrl?: string;
  scopes: string;
}

export interface OIDCTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export interface OIDCUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  [key: string]: unknown;
}

export interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

// ============================================
// PKCE Support
// ============================================

export function generatePKCEChallenge(): PKCEChallenge {
  const codeVerifier = randomBytes(64).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256'
  };
}

// ============================================
// State & Nonce Generation
// ============================================

export function generateState(): string {
  return randomBytes(32).toString('hex');
}

export function generateNonce(): string {
  return randomBytes(32).toString('hex');
}

// ============================================
// Authorization URL Builder
// ============================================

export interface AuthorizationUrlParams {
  config: OIDCConfig;
  state: string;
  nonce: string;
  redirectUri: string;
  pkce?: PKCEChallenge;
}

export function buildAuthorizationUrl(params: AuthorizationUrlParams): string {
  const { config, state, nonce, redirectUri, pkce } = params;

  const url = new URL(config.authorizationUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);

  if (pkce) {
    url.searchParams.set('code_challenge', pkce.codeChallenge);
    url.searchParams.set('code_challenge_method', pkce.codeChallengeMethod);
  }

  return url.toString();
}

// ============================================
// Token Exchange
// ============================================

export interface TokenExchangeParams {
  config: OIDCConfig;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}

export async function exchangeCodeForTokens(params: TokenExchangeParams): Promise<OIDCTokenResponse> {
  const { config, code, redirectUri, codeVerifier } = params;

  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', config.clientId);
  body.set('client_secret', config.clientSecret);
  body.set('code', code);
  body.set('redirect_uri', redirectUri);

  if (codeVerifier) {
    body.set('code_verifier', codeVerifier);
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: body.toString()
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${error}`);
  }

  return response.json() as Promise<OIDCTokenResponse>;
}

// ============================================
// User Info Retrieval
// ============================================

export async function getUserInfo(config: OIDCConfig, accessToken: string): Promise<OIDCUserInfo> {
  const response = await fetch(config.userInfoUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`User info fetch failed: ${response.status} ${error}`);
  }

  return response.json() as Promise<OIDCUserInfo>;
}

// ============================================
// Token Refresh
// ============================================

export async function refreshAccessToken(config: OIDCConfig, refreshToken: string): Promise<OIDCTokenResponse> {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('client_id', config.clientId);
  body.set('client_secret', config.clientSecret);
  body.set('refresh_token', refreshToken);

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: body.toString()
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${error}`);
  }

  return response.json() as Promise<OIDCTokenResponse>;
}

// ============================================
// ID Token Verification (Basic)
// ============================================

export interface IDTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  name?: string;
  [key: string]: unknown;
}

export function decodeIdToken(idToken: string): IDTokenClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw new Error('Invalid ID token format');
  }

  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return JSON.parse(payload) as IDTokenClaims;
}

export function verifyIdTokenClaims(claims: IDTokenClaims, config: OIDCConfig, nonce: string): void {
  // Verify issuer
  if (claims.iss !== config.issuer) {
    throw new Error(`Invalid issuer: expected ${config.issuer}, got ${claims.iss}`);
  }

  // Verify audience
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(config.clientId)) {
    throw new Error(`Invalid audience: ${config.clientId} not in ${audience}`);
  }

  // Verify expiration
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) {
    throw new Error('ID token has expired');
  }

  // Verify nonce
  if (claims.nonce !== nonce) {
    throw new Error('Invalid nonce');
  }
}

// ============================================
// Well-Known Discovery
// ============================================

export interface OIDCDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
}

export async function discoverOIDCConfig(issuer: string): Promise<OIDCDiscoveryDocument> {
  const wellKnownUrl = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;

  const response = await fetch(wellKnownUrl, {
    method: 'GET',
    headers: { 'Accept': 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`OIDC discovery failed: ${response.status}`);
  }

  return response.json() as Promise<OIDCDiscoveryDocument>;
}

// ============================================
// Attribute Mapping
// ============================================

export interface AttributeMapping {
  email: string;
  name: string;
  firstName?: string;
  lastName?: string;
  groups?: string;
}

export interface MappedUserAttributes {
  email: string;
  name: string;
  firstName?: string;
  lastName?: string;
  groups?: string[];
}

export function mapUserAttributes(userInfo: OIDCUserInfo, mapping: AttributeMapping): MappedUserAttributes {
  const getValue = (key: string): string | undefined => {
    const value = userInfo[key];
    return typeof value === 'string' ? value : undefined;
  };

  const email = getValue(mapping.email);
  if (!email) {
    throw new Error(`Required attribute '${mapping.email}' not found in user info`);
  }

  let name = getValue(mapping.name);
  if (!name && mapping.firstName && mapping.lastName) {
    const firstName = getValue(mapping.firstName);
    const lastName = getValue(mapping.lastName);
    if (firstName && lastName) {
      name = `${firstName} ${lastName}`;
    }
  }
  if (!name) {
    name = email.split('@')[0] || email; // fallback to email prefix or full email
  }

  const result: MappedUserAttributes = { email, name: name as string };

  if (mapping.firstName) {
    result.firstName = getValue(mapping.firstName);
  }
  if (mapping.lastName) {
    result.lastName = getValue(mapping.lastName);
  }
  if (mapping.groups) {
    const groups = userInfo[mapping.groups];
    if (Array.isArray(groups)) {
      result.groups = groups.filter(g => typeof g === 'string') as string[];
    }
  }

  return result;
}

// ============================================
// Common Provider Presets
// ============================================

export interface ProviderPreset {
  name: string;
  type: 'oidc' | 'saml';
  issuerTemplate?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scopes: string;
  attributeMapping: AttributeMapping;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  'azure-ad': {
    name: 'Microsoft Azure AD',
    type: 'oidc',
    issuerTemplate: 'https://login.microsoftonline.com/{tenant}/v2.0',
    scopes: 'openid profile email',
    attributeMapping: {
      email: 'email',
      name: 'name',
      firstName: 'given_name',
      lastName: 'family_name'
    }
  },
  'okta': {
    name: 'Okta',
    type: 'oidc',
    issuerTemplate: 'https://{domain}.okta.com',
    scopes: 'openid profile email groups',
    attributeMapping: {
      email: 'email',
      name: 'name',
      firstName: 'given_name',
      lastName: 'family_name',
      groups: 'groups'
    }
  },
  'google': {
    name: 'Google Workspace',
    type: 'oidc',
    issuerTemplate: 'https://accounts.google.com',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scopes: 'openid profile email',
    attributeMapping: {
      email: 'email',
      name: 'name',
      firstName: 'given_name',
      lastName: 'family_name'
    }
  },
  'auth0': {
    name: 'Auth0',
    type: 'oidc',
    issuerTemplate: 'https://{domain}.auth0.com',
    scopes: 'openid profile email',
    attributeMapping: {
      email: 'email',
      name: 'name',
      firstName: 'given_name',
      lastName: 'family_name'
    }
  }
};

// ============================================
// SAML 2.0 Types
// ============================================

export interface SAMLConfig {
  entityId: string;
  ssoUrl: string;
  sloUrl?: string;
  certificate: string;
  signatureAlgorithm?: 'sha256' | 'sha512';
  digestAlgorithm?: 'sha256' | 'sha512';
  wantAssertionsSigned?: boolean;
  wantResponseSigned?: boolean;
}

export interface SAMLServiceProviderConfig {
  entityId: string;
  acsUrl: string;
  sloUrl?: string;
  nameIdFormat: 'emailAddress' | 'persistent' | 'transient' | 'unspecified';
  signRequests?: boolean;
  privateKey?: string;
  certificate?: string;
}

export interface SAMLAssertion {
  nameId: string;
  nameIdFormat: string;
  sessionIndex?: string;
  attributes: Record<string, string | string[]>;
  conditions?: {
    notBefore?: string;
    notOnOrAfter?: string;
    audience?: string;
  };
}

export interface SAMLResponse {
  id: string;
  inResponseTo?: string;
  issuer: string;
  status: 'success' | 'error';
  statusCode?: string;
  statusMessage?: string;
  assertion?: SAMLAssertion;
}

// ============================================
// SAML Service Provider Metadata
// ============================================

export interface SPMetadataParams {
  entityId: string;
  acsUrl: string;
  sloUrl?: string;
  certificate?: string;
  nameIdFormat?: string;
  orgName?: string;
  orgDisplayName?: string;
  orgUrl?: string;
  contactEmail?: string;
}

export function generateSPMetadata(params: SPMetadataParams): string {
  const {
    entityId,
    acsUrl,
    sloUrl,
    certificate,
    nameIdFormat = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    orgName = 'Breeze RMM',
    orgDisplayName = 'Breeze RMM',
    orgUrl = 'https://breeze.io',
    contactEmail = 'support@breeze.io'
  } = params;

  const cleanCert = certificate
    ? certificate.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\n/g, '')
    : '';

  const keyDescriptor = certificate
    ? `
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data>
          <ds:X509Certificate>${cleanCert}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:KeyDescriptor use="encryption">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data>
          <ds:X509Certificate>${cleanCert}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>`
    : '';

  const sloService = sloUrl
    ? `
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${sloUrl}"/>
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${sloUrl}"/>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    ${keyDescriptor}${sloService}
    <md:NameIDFormat>${nameIdFormat}</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acsUrl}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
  <md:Organization>
    <md:OrganizationName xml:lang="en">${orgName}</md:OrganizationName>
    <md:OrganizationDisplayName xml:lang="en">${orgDisplayName}</md:OrganizationDisplayName>
    <md:OrganizationURL xml:lang="en">${orgUrl}</md:OrganizationURL>
  </md:Organization>
  <md:ContactPerson contactType="technical">
    <md:EmailAddress>${contactEmail}</md:EmailAddress>
  </md:ContactPerson>
</md:EntityDescriptor>`;
}

// ============================================
// SAML Authentication Request
// ============================================

export interface SAMLAuthnRequestParams {
  id: string;
  issuer: string;
  destination: string;
  acsUrl: string;
  nameIdFormat?: string;
  forceAuthn?: boolean;
}

export function buildSAMLAuthnRequest(params: SAMLAuthnRequestParams): string {
  const {
    id,
    issuer,
    destination,
    acsUrl,
    nameIdFormat = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    forceAuthn = false
  } = params;

  const issueInstant = new Date().toISOString();
  const forceAuthnAttr = forceAuthn ? ' ForceAuthn="true"' : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
                    xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
                    ID="${id}"
                    Version="2.0"
                    IssueInstant="${issueInstant}"
                    Destination="${destination}"
                    AssertionConsumerServiceURL="${acsUrl}"
                    ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"${forceAuthnAttr}>
  <saml:Issuer>${issuer}</saml:Issuer>
  <samlp:NameIDPolicy Format="${nameIdFormat}" AllowCreate="true"/>
</samlp:AuthnRequest>`;
}

export function generateSAMLRequestId(): string {
  return '_' + randomBytes(16).toString('hex');
}

export function encodeSAMLRequest(xml: string): string {
  return Buffer.from(xml, 'utf-8').toString('base64');
}

export function buildSAMLRedirectUrl(
  ssoUrl: string,
  samlRequest: string,
  relayState?: string
): string {
  const url = new URL(ssoUrl);
  url.searchParams.set('SAMLRequest', encodeSAMLRequest(samlRequest));
  if (relayState) {
    url.searchParams.set('RelayState', relayState);
  }
  return url.toString();
}

// ============================================
// SAML Response Parsing (Basic)
// ============================================

export function decodeSAMLResponse(encodedResponse: string): string {
  return Buffer.from(encodedResponse, 'base64').toString('utf-8');
}

export interface ParsedSAMLResponse {
  success: boolean;
  issuer?: string;
  nameId?: string;
  nameIdFormat?: string;
  sessionIndex?: string;
  attributes: Record<string, string>;
  error?: string;
}

export function parseSAMLResponse(xml: string): ParsedSAMLResponse {
  const result: ParsedSAMLResponse = {
    success: false,
    attributes: {}
  };

  // Check for success status
  const statusMatch = xml.match(/<samlp:StatusCode[^>]*Value="([^"]+)"/);
  if (statusMatch) {
    result.success = statusMatch[1] === 'urn:oasis:names:tc:SAML:2.0:status:Success';
  }

  if (!result.success) {
    const messageMatch = xml.match(/<samlp:StatusMessage>([^<]+)<\/samlp:StatusMessage>/);
    result.error = messageMatch ? messageMatch[1] : 'SAML authentication failed';
    return result;
  }

  // Extract Issuer
  const issuerMatch = xml.match(/<(?:saml:)?Issuer[^>]*>([^<]+)<\/(?:saml:)?Issuer>/);
  if (issuerMatch) {
    result.issuer = issuerMatch[1];
  }

  // Extract NameID
  const nameIdMatch = xml.match(/<(?:saml:)?NameID[^>]*Format="([^"]*)"[^>]*>([^<]+)<\/(?:saml:)?NameID>/);
  if (nameIdMatch) {
    result.nameIdFormat = nameIdMatch[1];
    result.nameId = nameIdMatch[2];
  } else {
    const simpleNameIdMatch = xml.match(/<(?:saml:)?NameID[^>]*>([^<]+)<\/(?:saml:)?NameID>/);
    if (simpleNameIdMatch) {
      result.nameId = simpleNameIdMatch[1];
    }
  }

  // Extract SessionIndex
  const sessionMatch = xml.match(/SessionIndex="([^"]+)"/);
  if (sessionMatch) {
    result.sessionIndex = sessionMatch[1];
  }

  // Extract Attributes
  const attributeRegex = /<(?:saml:)?Attribute[^>]*Name="([^"]+)"[^>]*>[\s\S]*?<(?:saml:)?AttributeValue[^>]*>([^<]*)<\/(?:saml:)?AttributeValue>/g;
  let match;
  while ((match = attributeRegex.exec(xml)) !== null) {
    const name = match[1];
    const value = match[2];
    if (name && value !== undefined) {
      const simpleName = mapSAMLAttributeName(name);
      result.attributes[simpleName] = value;
    }
  }

  return result;
}

function mapSAMLAttributeName(uri: string): string {
  const mappings: Record<string, string> = {
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'email',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name': 'name',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname': 'firstName',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname': 'lastName',
    'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups': 'groups',
    'http://schemas.xmlsoap.org/claims/Group': 'groups',
    'urn:oid:0.9.2342.19200300.100.1.3': 'email',
    'urn:oid:2.5.4.42': 'firstName',
    'urn:oid:2.5.4.4': 'lastName',
    'urn:oid:2.16.840.1.113730.3.1.241': 'name',
    'email': 'email',
    'firstName': 'firstName',
    'lastName': 'lastName',
    'displayName': 'name',
    'name': 'name'
  };

  return mappings[uri] || uri.split('/').pop() || uri;
}

// ============================================
// SAML User Extraction
// ============================================

export function extractSAMLUserInfo(
  response: ParsedSAMLResponse,
  mapping: AttributeMapping
): MappedUserAttributes {
  const getValue = (key: string): string | undefined => {
    return response.attributes[key] || response.attributes[mapping[key as keyof AttributeMapping] as string];
  };

  let email = getValue(mapping.email);
  if (!email && response.nameId && response.nameId.includes('@')) {
    email = response.nameId;
  }

  if (!email) {
    throw new Error('Email attribute not found in SAML response');
  }

  let name = getValue(mapping.name);
  if (!name && mapping.firstName && mapping.lastName) {
    const firstName = getValue(mapping.firstName);
    const lastName = getValue(mapping.lastName);
    if (firstName && lastName) {
      name = `${firstName} ${lastName}`;
    }
  }
  if (!name) {
    name = email.split('@')[0] || email;
  }

  const result: MappedUserAttributes = { email, name };

  if (mapping.firstName) {
    result.firstName = getValue(mapping.firstName);
  }
  if (mapping.lastName) {
    result.lastName = getValue(mapping.lastName);
  }
  if (mapping.groups) {
    const groups = response.attributes[mapping.groups];
    if (groups) {
      result.groups = Array.isArray(groups) ? groups : [groups];
    }
  }

  return result;
}

// ============================================
// SAML Provider Presets
// ============================================

export interface SAMLProviderPreset {
  name: string;
  type: 'saml';
  metadataUrlTemplate?: string;
  ssoUrlTemplate?: string;
  certificateInstructions: string;
  attributeMapping: AttributeMapping;
}

export const SAML_PROVIDER_PRESETS: Record<string, SAMLProviderPreset> = {
  'azure-ad-saml': {
    name: 'Microsoft Azure AD (SAML)',
    type: 'saml',
    metadataUrlTemplate: 'https://login.microsoftonline.com/{tenant}/federationmetadata/2007-06/federationmetadata.xml',
    ssoUrlTemplate: 'https://login.microsoftonline.com/{tenant}/saml2',
    certificateInstructions: 'Download from Azure Portal > Enterprise Applications > Your App > SAML Signing Certificate',
    attributeMapping: {
      email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
      name: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
      firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
      lastName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
      groups: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups'
    }
  },
  'okta-saml': {
    name: 'Okta (SAML)',
    type: 'saml',
    metadataUrlTemplate: 'https://{domain}.okta.com/app/{appId}/sso/saml/metadata',
    ssoUrlTemplate: 'https://{domain}.okta.com/app/{appId}/sso/saml',
    certificateInstructions: 'Download from Okta Admin > Applications > Your App > Sign On > SAML Signing Certificates',
    attributeMapping: {
      email: 'email',
      name: 'name',
      firstName: 'firstName',
      lastName: 'lastName',
      groups: 'groups'
    }
  },
  'onelogin-saml': {
    name: 'OneLogin (SAML)',
    type: 'saml',
    metadataUrlTemplate: 'https://{domain}.onelogin.com/saml/metadata/{appId}',
    ssoUrlTemplate: 'https://{domain}.onelogin.com/trust/saml2/http-post/sso/{appId}',
    certificateInstructions: 'Download from OneLogin Admin > Applications > Your App > SSO > X.509 Certificate',
    attributeMapping: {
      email: 'User.email',
      name: 'User.FirstName',
      firstName: 'User.FirstName',
      lastName: 'User.LastName'
    }
  },
  'adfs-saml': {
    name: 'Active Directory Federation Services (ADFS)',
    type: 'saml',
    metadataUrlTemplate: 'https://{adfs-server}/FederationMetadata/2007-06/FederationMetadata.xml',
    ssoUrlTemplate: 'https://{adfs-server}/adfs/ls',
    certificateInstructions: 'Export from ADFS Management Console > Service > Certificates > Token-signing',
    attributeMapping: {
      email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
      name: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
      firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
      lastName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
      groups: 'http://schemas.xmlsoap.org/claims/Group'
    }
  },
  'google-saml': {
    name: 'Google Workspace (SAML)',
    type: 'saml',
    ssoUrlTemplate: 'https://accounts.google.com/o/saml2/idp?idpid={idpId}',
    certificateInstructions: 'Download from Google Admin > Apps > Web and mobile apps > Your App > Download certificate',
    attributeMapping: {
      email: 'email',
      name: 'name',
      firstName: 'first_name',
      lastName: 'last_name'
    }
  }
};

// Combined presets for UI
export const ALL_SSO_PRESETS = {
  ...PROVIDER_PRESETS,
  ...SAML_PROVIDER_PRESETS
};
