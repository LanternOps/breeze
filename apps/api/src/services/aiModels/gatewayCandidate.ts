/**
 * W06 (#7604): the resolver branch for gateway connection kinds
 * (openai_compatible; W07 adds the cloud kinds). Three rules carry the
 * security weight:
 *  1. Capabilities come ONLY from a current verification bound to the
 *     endpoint fingerprint (D4) — never from a linked platform row or a
 *     hand-written tree.
 *  2. Price comes ONLY from the offering (spec §8 precedence 1): no
 *     linked-platform inheritance for gateway kinds.
 *  3. A keyless ACTIVE connection is usable (local Ollama); a stored key that
 *     fails to decrypt, or any connection that is not active (a disconnected
 *     row has a NULL key too), is not.
 * Never residency-eligible (D7: inferenceGeo null); funding always partner_key.
 *
 * The decrypted secret is placed only on the returned connection's
 * `credential` and is never logged or put in error text.
 */
import { emptyOptionSupport, type OfferingOptions } from '@breeze/shared';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { SecretKeyMaterialError } from '../secretCrypto';
import { captureException } from '../sentry';
import type { AllowedOptions, LoadedCandidate } from './candidateLoader';
import type { DerivedCapabilities } from './capabilities';
import { decryptConnectionKey, getConnectionKeyMaterial, type PartnerAiConnection } from './connections';
import type { ConnectionKind } from './eligibility';
import type { GatewayConnectionConfig, GatewayCredential } from './gateway/types';
import { endpointFingerprint, verifiedGatewayCapabilities } from './gatewayCapabilities';
import type { Offering } from './offerings';
import type { RateSnapshot } from './pricing';
import { safeErrorMessage } from './safeDbError';

function systemRead<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

function offeringRate(o: Offering): RateSnapshot | null {
  const v = [o.priceInputCentsPerM, o.priceOutputCentsPerM, o.priceCacheReadCentsPerM, o.priceCacheWriteCentsPerM];
  if (v.some((x) => x == null)) return null;
  return {
    source: 'offering',
    standard: {
      inputCentsPerM: Number(v[0]),
      outputCentsPerM: Number(v[1]),
      cacheReadCentsPerM: Number(v[2]),
      cacheWriteCentsPerM: Number(v[3]),
    },
  };
}

/** Builds the per-kind GatewayConnectionConfig. W07 adds cloud arms. Null when the row cannot route. */
export function gatewayConfigFor(conn: PartnerAiConnection): GatewayConnectionConfig | null {
  switch (conn.kind) {
    case 'openai_compatible':
      return conn.baseUrl
        ? {
            source: 'gateway', kind: 'openai_compatible', partnerId: conn.partnerId,
            connectionId: conn.id, configVersion: conn.configVersion, baseUrl: conn.baseUrl,
          }
        : null;
    default:
      return null;
  }
}

/**
 * Whether the kind's gateway adapter can carry Anthropic thinking/effort. The
 * openai_compatible adapter drops thinking blocks (OpenAI-dialect reasoning is
 * out of scope for W06), so its verified offerings are always thinking 'none'.
 */
function adapterCarriesThinking(kind: string): boolean {
  return kind !== 'openai_compatible';
}

/**
 * The credential, or null when the connection is unusable. Reads the key row
 * itself (status in the same read as the key), so a disconnect that lands
 * between the connection read and this read can never surface as "keyless".
 * A LOOKUP failure is infrastructure (DB), not a dead key: it throws, scrubbed,
 * like every other read in the candidate loader (review S6).
 */
async function readCredential(conn: PartnerAiConnection): Promise<GatewayCredential | null> {
  if (conn.status !== 'active') return null;
  let material: Awaited<ReturnType<typeof getConnectionKeyMaterial>>;
  try {
    material = await systemRead(() => getConnectionKeyMaterial(conn.id));
  } catch (error) {
    const scrubbed = new Error(`AI connection key lookup failed: ${safeErrorMessage(error)}`);
    captureException(scrubbed, undefined, { service: 'gatewayCandidate', partner_id: conn.partnerId });
    throw scrubbed;
  }
  if (!material || material.partnerId !== conn.partnerId || material.status !== 'active') return null;
  if (material.apiKeyEncrypted === null) return { secret: null };
  try {
    return { secret: decryptConnectionKey(material) };
  } catch (error) {
    if (error instanceof SecretKeyMaterialError) {
      captureException(error, undefined, { service: 'gatewayCandidate', partner_id: conn.partnerId });
    } else {
      console.warn('[gatewayCandidate] connection key could not be decrypted; treated as unusable', {
        connectionId: conn.id, error: safeErrorMessage(error),
      });
    }
    return null;
  }
}

export async function gatewayCandidate(input: { offering: Offering; conn: PartnerAiConnection }): Promise<LoadedCandidate> {
  const { offering, conn } = input;
  const credential = await readCredential(conn);
  const keyUsable = credential !== null;

  const verified = verifiedGatewayCapabilities(
    offering.capabilities,
    endpointFingerprint({ kind: conn.kind, baseUrl: conn.baseUrl, providerConfig: conn.providerConfig ?? null }),
  ).capabilities;
  const capabilities: DerivedCapabilities = adapterCarriesThinking(conn.kind) || verified.thinkingMode === 'unknown'
    ? verified
    : { ...verified, thinkingMode: 'none', effortLevels: [] };

  const rate = offeringRate(offering);
  const config = gatewayConfigFor(conn);
  const wireModel = offering.modelId ?? '';
  return {
    facts: {
      ownerPartnerId: offering.partnerId,
      enabled: offering.enabled,
      lifecycle: offering.lifecycle,
      requiredPermission: offering.requiredPermission,
      platform: null,
      connection: { kind: conn.kind as ConnectionKind, status: conn.status, keyUsable: keyUsable && config !== null },
      catalog: null,
      rate,
      supportsTools: capabilities.supportsTools,
      inferenceGeo: null,
      supportedInferenceGeos: [],
    },
    offeringId: offering.id,
    connectionId: conn.id,
    displayName: offering.displayName ?? wireModel,
    logicalModel: wireModel,
    wireModel,
    connection: config && credential ? { id: conn.id, kind: config.kind, config, credential } : null,
    funding: 'partner_key',
    capabilities,
    optionSupport: { ...emptyOptionSupport(), effort: [...capabilities.effortLevels] },
    optionRates: null,
    defaultOptions: offering.defaultOptions as Partial<OfferingOptions> | null,
    allowedOptions: offering.allowedOptions as AllowedOptions | null,
    refusalFallbackOfferingId: offering.refusalFallbackOfferingId,
    promptProfile: 'generic',
    limits: { maxInputTokens: null, maxOutputTokens: null },
    configVersion: conn.configVersion,
  };
}
