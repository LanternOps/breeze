/**
 * Tool Catalog W05 (#5220), plan Task B3 / Decision 14 — send a short notice
 * (not an alert) to a notification channel. Used by the flow `notify` step and
 * by a flow document's `notices.channelId`.
 *
 * Adapts the message to the per-type senders the alert dispatcher already uses
 * (same transports, same config decryption, the channel's own throttle) without
 * an alert row: no alert id, no device. Visibility is the flow owner's rule
 * (findOwnedNotificationChannel); a foreign and a missing channel read the same.
 *
 * DB discipline: the config is read in one short system context, never inside
 * an ambient context; the SEND runs outside any DB context. Never throws for a
 * send failure — the caller gets `{ ok: false, code: 'send_failed' }`.
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partners } from '../../db/schema';
import { findOwnedNotificationChannel } from '../flows/ownedReferences';
import { getNotificationChannelWithConfig } from '../notificationChannelConfig';
import { decryptNotificationChannelConfig } from '../notificationChannelSecrets';
import { checkNotificationThrottle } from '../notificationThrottle';
import { applyPartnerPushoverDefaults, readPartnerPushoverDefaults } from '../partnerPushoverDefaults';
import type { ToolOwnerRef } from '../toolSources/resolver';
import { isChannelMessageType } from './channelMessageTypes';
import { getEmailRecipients, sendEmailNotification } from './emailSender';
import { sendPushoverNotification, type PushoverConfig } from './pushoverSender';
import { sendSmsNotification } from './smsSender';
import { sendWebhookNotification } from './webhookSender';

export { CHANNEL_MESSAGE_TYPES } from './channelMessageTypes';

export interface ChannelMessage {
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical';
  /** App-relative path (`/flows/<id>`); prefixed with DASHBOARD_URL when set. */
  link?: string;
}

export type ChannelMessageResult =
  | { ok: true; channelId: string; channelType: string }
  | {
      ok: false;
      code: 'channel_not_found' | 'channel_disabled' | 'channel_type_not_supported' | 'throttled' | 'send_failed';
      message: string;
    };

type AlertSeverityVocab = 'info' | 'medium' | 'critical';

/** The alert senders' vocabulary: info / medium / critical (warning has no alert twin). */
function senderSeverity(s: ChannelMessage['severity']): AlertSeverityVocab {
  return s === 'critical' ? 'critical' : s === 'warning' ? 'medium' : 'info';
}

const FAIL_MESSAGE_MAX = 300;

/** Sender errors can echo the destination URL (slack/teams: the URL IS the credential). */
function scrub(text: string): string {
  const cleaned = text.replace(/https?:\/\/\S+/gi, '[url]').replace(/\s+/g, ' ').trim();
  return (cleaned || 'Delivery failed').slice(0, FAIL_MESSAGE_MAX);
}

function failed(message: string): ChannelMessageResult {
  return { ok: false, code: 'send_failed', message: scrub(message) };
}

function absoluteLink(link: string | undefined): string | undefined {
  if (!link) return undefined;
  const base = process.env.DASHBOARD_URL;
  return base ? `${base.replace(/\/+$/, '')}${link}` : undefined;
}

const NOT_FOUND = 'Notification channel not found.';

export async function sendChannelMessage(channelId: string, msg: ChannelMessage, owner: ToolOwnerRef): Promise<ChannelMessageResult> {
  const visible = await findOwnedNotificationChannel(owner, channelId);
  if (!visible) return { ok: false, code: 'channel_not_found', message: NOT_FOUND };
  if (!visible.enabled) return { ok: false, code: 'channel_disabled', message: 'Notification channel is disabled.' };
  if (!isChannelMessageType(visible.type)) {
    return {
      ok: false,
      code: 'channel_type_not_supported',
      message: `A ${visible.type} channel cannot receive flow notices (use email, slack, teams, sms or pushover).`,
    };
  }
  const type = visible.type;

  let channel: Awaited<ReturnType<typeof getNotificationChannelWithConfig>>;
  let config: Record<string, unknown>;
  let partnerSettings: unknown;
  try {
    ({ channel, config, partnerSettings } = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const row = await getNotificationChannelWithConfig(channelId);
      if (!row) return { channel: null, config: {}, partnerSettings: undefined };
      const decrypted = decryptNotificationChannelConfig(row.type, row.config) as Record<string, unknown> | null;
      let settings: unknown;
      if (type === 'pushover') {
        const [partner] = await db.select({ settings: partners.settings }).from(partners).where(eq(partners.id, owner.partnerId)).limit(1);
        settings = partner?.settings;
      }
      return { channel: row, config: decrypted ?? {}, partnerSettings: settings };
    }, 'channelMessage.load')));
  } catch (err) {
    return failed(err instanceof Error ? err.message : 'Could not load the channel configuration.');
  }
  if (!channel) return { ok: false, code: 'channel_not_found', message: NOT_FOUND };

  if (channel.throttleMaxPerWindow && channel.throttleMaxPerWindow > 0) {
    const windowSeconds = channel.throttleWindowSeconds ?? 3600;
    const throttle = await checkNotificationThrottle(channel.id, 'flow-notice', channel.throttleMaxPerWindow, windowSeconds);
    if (!throttle.allowed) {
      return { ok: false, code: 'throttled', message: `The channel's delivery cap was reached (${channel.throttleMaxPerWindow} per ${windowSeconds}s).` };
    }
  }

  // The send: outside any DB context.
  const severity = senderSeverity(msg.severity);
  const dashboardUrl = absoluteLink(msg.link);
  try {
    let result: { success: boolean; error?: string };
    switch (type) {
      case 'email': {
        const recipients = getEmailRecipients(config);
        if (recipients.length === 0) return failed('No email recipients configured');
        result = await sendEmailNotification({ to: recipients, alertName: msg.title, severity, summary: msg.body, dashboardUrl });
        break;
      }
      case 'sms':
        result = await sendSmsNotification(config, { alertName: msg.title, severity, summary: msg.body, dashboardUrl });
        break;
      case 'pushover': {
        const merged = applyPartnerPushoverDefaults(config as PushoverConfig, readPartnerPushoverDefaults(partnerSettings));
        result = await sendPushoverNotification(merged, {
          alertId: '', alertName: msg.title, severity, summary: msg.body,
          orgId: owner.orgId ?? '', triggeredAt: new Date().toISOString(), dashboardUrl,
        });
        break;
      }
      case 'slack':
      case 'teams': {
        const webhookUrl = typeof config.webhookUrl === 'string' ? config.webhookUrl.trim() : '';
        if (!webhookUrl) return failed(`${type} channel missing webhookUrl`);
        result = await sendWebhookNotification(
          {
            url: webhookUrl,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            payloadTemplate: '{"text":"[{{severity}}] {{alertName}}: {{summary}}{{link}}"}',
          },
          {
            alertId: '', alertName: msg.title, severity, summary: msg.body,
            orgId: owner.orgId ?? '', triggeredAt: new Date().toISOString(),
            context: { link: dashboardUrl ? ` ${dashboardUrl}` : '' },
          },
        );
        break;
      }
    }
    if (!result.success) return failed(result.error ?? 'Delivery failed');
    return { ok: true, channelId, channelType: type };
  } catch (err) {
    return failed(err instanceof Error ? err.message : 'Delivery failed');
  }
}
