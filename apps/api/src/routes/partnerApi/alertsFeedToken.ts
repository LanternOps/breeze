import {
  createPartnerFeedTokens,
  type PartnerFeedBinding,
  type PartnerFeedCheckpoint,
  type PartnerFeedPage,
} from './feedToken';

/**
 * Signed tokens for the partner alerts feed (GET /partner-api/alerts): the
 * shared xid8 feed token machinery (feedToken.ts) bound to the alerts HMAC
 * domain, so an alerts token can never be replayed against another feed.
 */
export const PARTNER_ALERTS_FEED_HMAC_DOMAIN = 'breeze-partner-alerts-feed-v1';

const alertsFeedTokens = createPartnerFeedTokens({
  hmacDomain: PARTNER_ALERTS_FEED_HMAC_DOMAIN,
  tokenErrorCode: 'invalid_partner_alerts_token',
  tokenErrorMessage: 'The partner alerts cursor or checkpoint is invalid or expired.',
  resyncCode: 'partner_alerts_resync_required',
  resyncMessage: 'The alerts checkpoint no longer matches this feed. Start a full sync without `since`.',
});

export type PartnerAlertsFeedBinding = PartnerFeedBinding;
export type PartnerAlertsFeedPage = PartnerFeedPage;
export type PartnerAlertsFeedCheckpoint = PartnerFeedCheckpoint;

export const PartnerAlertsFeedTokenError = alertsFeedTokens.TokenError;
export const PartnerAlertsResyncRequiredError = alertsFeedTokens.ResyncRequiredError;
export const {
  encodePageToken,
  decodePageToken,
  encodeCheckpointToken,
  decodeCheckpointToken,
} = alertsFeedTokens;
export { compareXid8, orgSetHash, sha256Hex } from './feedToken';
