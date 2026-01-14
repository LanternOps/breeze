import { useState } from 'react';
import { Link2, MessageSquare, Save, Send, Users, Webhook } from 'lucide-react';

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

type StatusTone = 'success' | 'error' | 'info';

type StatusMessage = {
  tone: StatusTone;
  message: string;
};

type RoutingRule = {
  severity: Severity;
  slack: string;
  teams: string;
  discord: string;
};

type ProviderKey = 'slack' | 'teams' | 'discord';

const severityLabels: Record<Severity, { label: string; className: string }> = {
  critical: {
    label: 'Critical',
    className: 'border-red-500/40 bg-red-500/20 text-red-700'
  },
  high: {
    label: 'High',
    className: 'border-orange-500/40 bg-orange-500/20 text-orange-700'
  },
  medium: {
    label: 'Medium',
    className: 'border-yellow-500/40 bg-yellow-500/20 text-yellow-700'
  },
  low: {
    label: 'Low',
    className: 'border-blue-500/40 bg-blue-500/20 text-blue-700'
  },
  info: {
    label: 'Info',
    className: 'border-slate-400/40 bg-slate-400/20 text-slate-700'
  }
};

const statusToneStyles: Record<StatusTone, string> = {
  success: 'text-emerald-600',
  error: 'text-red-600',
  info: 'text-muted-foreground'
};

const mockDefaults = {
  slack: {
    enabled: true,
    workspaceName: 'Breeze Operations',
    workspaceId: 'T03BREEZE',
    defaultChannel: '#ops-alerts'
  },
  teams: {
    enabled: true,
    tenantId: '7dbf6e6b-50a2-44d7-9a7f-1d9a63baf411',
    clientId: 'd2f2c017-0b11-41c0-8b2e-21e0edbb1c93',
    clientSecret: '********'
  },
  discord: {
    enabled: false,
    webhookUrl: 'https://discord.com/api/webhooks/0000000000000/xxxxxxxxxxxxxxxx'
  },
  routingRules: [
    { severity: 'critical', slack: '#sev1', teams: 'Ops - Sev1', discord: '#critical' },
    { severity: 'high', slack: '#ops-alerts', teams: 'Ops - Alerts', discord: '#high' },
    { severity: 'medium', slack: '#ops-triage', teams: 'Ops - Triage', discord: '#medium' },
    { severity: 'low', slack: '#ops-info', teams: 'Ops - Info', discord: '#low' },
    { severity: 'info', slack: '#ops-feed', teams: 'Ops - Feed', discord: '#info' }
  ] as RoutingRule[],
  messageTemplate:
    '[{severity}] {alert}\nDevice: {device}\nSite: {site}\nTime: {timestamp}'
};

const templateVariables = ['{device}', '{alert}', '{severity}', '{site}', '{organization}', '{timestamp}'];

const buildRoutingPayload = (rules: RoutingRule[], provider: ProviderKey) =>
  rules.map(rule => ({
    severity: rule.severity,
    channel: rule[provider]
  }));

const saveIntegration = async (endpoint: string, payload: Record<string, unknown>) => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error('Unable to save integration settings.');
  }
};

const sendTest = async (endpoint: string, payload: Record<string, unknown>) => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, test: true })
  });

  if (!response.ok) {
    throw new Error('Unable to send test notification.');
  }
};

export default function CommunicationIntegrations() {
  const [slackEnabled, setSlackEnabled] = useState(mockDefaults.slack.enabled);
  const [slackWorkspaceName] = useState(mockDefaults.slack.workspaceName);
  const [slackWorkspaceId] = useState(mockDefaults.slack.workspaceId);
  const [slackDefaultChannel, setSlackDefaultChannel] = useState(mockDefaults.slack.defaultChannel);
  const [slackStatus, setSlackStatus] = useState<StatusMessage | null>(null);
  const [slackSaving, setSlackSaving] = useState(false);
  const [slackTesting, setSlackTesting] = useState(false);

  const [teamsEnabled, setTeamsEnabled] = useState(mockDefaults.teams.enabled);
  const [teamsTenantId, setTeamsTenantId] = useState(mockDefaults.teams.tenantId);
  const [teamsClientId, setTeamsClientId] = useState(mockDefaults.teams.clientId);
  const [teamsClientSecret, setTeamsClientSecret] = useState(mockDefaults.teams.clientSecret);
  const [teamsStatus, setTeamsStatus] = useState<StatusMessage | null>(null);
  const [teamsSaving, setTeamsSaving] = useState(false);
  const [teamsTesting, setTeamsTesting] = useState(false);

  const [discordEnabled, setDiscordEnabled] = useState(mockDefaults.discord.enabled);
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState(mockDefaults.discord.webhookUrl);
  const [discordStatus, setDiscordStatus] = useState<StatusMessage | null>(null);
  const [discordSaving, setDiscordSaving] = useState(false);
  const [discordTesting, setDiscordTesting] = useState(false);

  const [routingRules, setRoutingRules] = useState<RoutingRule[]>(mockDefaults.routingRules);
  const [messageTemplate, setMessageTemplate] = useState(mockDefaults.messageTemplate);

  const handleRoutingChange = (severity: Severity, provider: ProviderKey, value: string) => {
    setRoutingRules(prev =>
      prev.map(rule => (rule.severity === severity ? { ...rule, [provider]: value } : rule))
    );
  };

  const handleSlackSave = async () => {
    setSlackSaving(true);
    setSlackStatus(null);
    try {
      await saveIntegration('/api/integrations/slack', {
        enabled: slackEnabled,
        workspaceName: slackWorkspaceName,
        workspaceId: slackWorkspaceId,
        defaultChannel: slackDefaultChannel,
        routing: buildRoutingPayload(routingRules, 'slack'),
        messageTemplate
      });
      setSlackStatus({ tone: 'success', message: 'Slack settings saved.' });
    } catch (err) {
      setSlackStatus({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to save Slack settings.'
      });
    } finally {
      setSlackSaving(false);
    }
  };

  const handleSlackTest = async () => {
    setSlackTesting(true);
    setSlackStatus(null);
    try {
      await sendTest('/api/integrations/slack', {
        enabled: slackEnabled,
        workspaceName: slackWorkspaceName,
        workspaceId: slackWorkspaceId,
        defaultChannel: slackDefaultChannel,
        routing: buildRoutingPayload(routingRules, 'slack'),
        messageTemplate
      });
      setSlackStatus({ tone: 'success', message: 'Slack test notification queued.' });
    } catch (err) {
      setSlackStatus({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Slack test notification failed.'
      });
    } finally {
      setSlackTesting(false);
    }
  };

  const handleTeamsSave = async () => {
    setTeamsSaving(true);
    setTeamsStatus(null);
    try {
      await saveIntegration('/api/integrations/teams', {
        enabled: teamsEnabled,
        tenantId: teamsTenantId,
        clientId: teamsClientId,
        clientSecret: teamsClientSecret,
        routing: buildRoutingPayload(routingRules, 'teams'),
        messageTemplate
      });
      setTeamsStatus({ tone: 'success', message: 'Teams settings saved.' });
    } catch (err) {
      setTeamsStatus({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to save Teams settings.'
      });
    } finally {
      setTeamsSaving(false);
    }
  };

  const handleTeamsTest = async () => {
    setTeamsTesting(true);
    setTeamsStatus(null);
    try {
      await sendTest('/api/integrations/teams', {
        enabled: teamsEnabled,
        tenantId: teamsTenantId,
        clientId: teamsClientId,
        clientSecret: teamsClientSecret,
        routing: buildRoutingPayload(routingRules, 'teams'),
        messageTemplate
      });
      setTeamsStatus({ tone: 'success', message: 'Teams test notification queued.' });
    } catch (err) {
      setTeamsStatus({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Teams test notification failed.'
      });
    } finally {
      setTeamsTesting(false);
    }
  };

  const handleDiscordSave = async () => {
    setDiscordSaving(true);
    setDiscordStatus(null);
    try {
      await saveIntegration('/api/integrations/discord', {
        enabled: discordEnabled,
        webhookUrl: discordWebhookUrl,
        routing: buildRoutingPayload(routingRules, 'discord'),
        messageTemplate
      });
      setDiscordStatus({ tone: 'success', message: 'Discord settings saved.' });
    } catch (err) {
      setDiscordStatus({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to save Discord settings.'
      });
    } finally {
      setDiscordSaving(false);
    }
  };

  const handleDiscordTest = async () => {
    setDiscordTesting(true);
    setDiscordStatus(null);
    try {
      await sendTest('/api/integrations/discord', {
        enabled: discordEnabled,
        webhookUrl: discordWebhookUrl,
        routing: buildRoutingPayload(routingRules, 'discord'),
        messageTemplate
      });
      setDiscordStatus({ tone: 'success', message: 'Discord test notification queued.' });
    } catch (err) {
      setDiscordStatus({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Discord test notification failed.'
      });
    } finally {
      setDiscordTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Communication integrations</h1>
        <p className="text-sm text-muted-foreground">
          Connect chat tools, route alerts by severity, and customize messaging templates.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <section className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-foreground">
                <MessageSquare className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-lg font-semibold">Slack</h2>
                <p className="text-sm text-muted-foreground">
                  Connect a workspace with OAuth and post alerts to channels.
                </p>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Enabled</span>
              <input
                type="checkbox"
                checked={slackEnabled}
                onChange={event => setSlackEnabled(event.target.checked)}
                className="h-4 w-4"
              />
            </label>
          </div>

          <div className="mt-5 space-y-4">
            <div className="rounded-lg border bg-muted/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase text-muted-foreground">Workspace</p>
                  <p className="text-sm font-medium">
                    {slackWorkspaceName ? slackWorkspaceName : 'Not connected'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Workspace ID: {slackWorkspaceId || 'Pending connection'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (slackEnabled) {
                      window.location.assign('/api/integrations/slack/oauth');
                    }
                  }}
                  disabled={!slackEnabled}
                  className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-xs font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Link2 className="h-4 w-4" />
                  Connect workspace
                </button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                OAuth redirect starts when you connect a Slack workspace.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Default channel</label>
              <input
                type="text"
                value={slackDefaultChannel}
                onChange={event => setSlackDefaultChannel(event.target.value)}
                disabled={!slackEnabled}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:bg-muted/40"
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleSlackTest}
                disabled={!slackEnabled || slackSaving || slackTesting}
                className="inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Send className="h-4 w-4" />
                {slackTesting ? 'Testing...' : 'Test notification'}
              </button>
              <button
                type="button"
                onClick={handleSlackSave}
                disabled={!slackEnabled || slackSaving || slackTesting}
                className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Save className="h-4 w-4" />
                {slackSaving ? 'Saving...' : 'Save settings'}
              </button>
            </div>
            {slackStatus ? (
              <p className={`text-xs ${statusToneStyles[slackStatus.tone]}`}>{slackStatus.message}</p>
            ) : null}
          </div>
        </section>

        <section className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-foreground">
                <Users className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-lg font-semibold">Microsoft Teams</h2>
                <p className="text-sm text-muted-foreground">
                  Configure tenant credentials for Teams alert delivery.
                </p>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Enabled</span>
              <input
                type="checkbox"
                checked={teamsEnabled}
                onChange={event => setTeamsEnabled(event.target.checked)}
                className="h-4 w-4"
              />
            </label>
          </div>

          <div className="mt-5 space-y-4">
            <div className="grid gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Tenant ID</label>
                <input
                  type="text"
                  value={teamsTenantId}
                  onChange={event => setTeamsTenantId(event.target.value)}
                  disabled={!teamsEnabled}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:bg-muted/40"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Client ID</label>
                <input
                  type="text"
                  value={teamsClientId}
                  onChange={event => setTeamsClientId(event.target.value)}
                  disabled={!teamsEnabled}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:bg-muted/40"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Client secret</label>
                <input
                  type="password"
                  value={teamsClientSecret}
                  onChange={event => setTeamsClientSecret(event.target.value)}
                  disabled={!teamsEnabled}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:bg-muted/40"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleTeamsTest}
                disabled={!teamsEnabled || teamsSaving || teamsTesting}
                className="inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Send className="h-4 w-4" />
                {teamsTesting ? 'Testing...' : 'Test notification'}
              </button>
              <button
                type="button"
                onClick={handleTeamsSave}
                disabled={!teamsEnabled || teamsSaving || teamsTesting}
                className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Save className="h-4 w-4" />
                {teamsSaving ? 'Saving...' : 'Save settings'}
              </button>
            </div>
            {teamsStatus ? (
              <p className={`text-xs ${statusToneStyles[teamsStatus.tone]}`}>{teamsStatus.message}</p>
            ) : null}
          </div>
        </section>

        <section className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-foreground">
                <Webhook className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-lg font-semibold">Discord</h2>
                <p className="text-sm text-muted-foreground">
                  Send alerts to a Discord channel via webhook.
                </p>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Enabled</span>
              <input
                type="checkbox"
                checked={discordEnabled}
                onChange={event => setDiscordEnabled(event.target.checked)}
                className="h-4 w-4"
              />
            </label>
          </div>

          <div className="mt-5 space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Webhook URL</label>
              <input
                type="text"
                value={discordWebhookUrl}
                onChange={event => setDiscordWebhookUrl(event.target.value)}
                disabled={!discordEnabled}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm disabled:cursor-not-allowed disabled:bg-muted/40"
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleDiscordTest}
                disabled={!discordEnabled || discordSaving || discordTesting}
                className="inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Send className="h-4 w-4" />
                {discordTesting ? 'Testing...' : 'Test notification'}
              </button>
              <button
                type="button"
                onClick={handleDiscordSave}
                disabled={!discordEnabled || discordSaving || discordTesting}
                className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Save className="h-4 w-4" />
                {discordSaving ? 'Saving...' : 'Save settings'}
              </button>
            </div>
            {discordStatus ? (
              <p className={`text-xs ${statusToneStyles[discordStatus.tone]}`}>{discordStatus.message}</p>
            ) : null}
          </div>
        </section>
      </div>

      <section className="rounded-xl border bg-card p-6 shadow-sm">
        <div>
          <h2 className="text-lg font-semibold">Channel routing rules</h2>
          <p className="text-sm text-muted-foreground">
            Map alert severity to the destination channels for each integration.
          </p>
        </div>

        <div className="mt-4 overflow-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-2 py-2">Severity</th>
                <th className="px-2 py-2">Slack channel</th>
                <th className="px-2 py-2">Teams channel</th>
                <th className="px-2 py-2">Discord channel</th>
              </tr>
            </thead>
            <tbody>
              {routingRules.map(rule => {
                const meta = severityLabels[rule.severity];
                return (
                  <tr key={rule.severity} className="border-t">
                    <td className="px-2 py-3">
                      <span className={`inline-flex items-center rounded-full border px-2 py-1 text-xs ${meta.className}`}>
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-2 py-3">
                      <input
                        type="text"
                        value={rule.slack}
                        onChange={event => handleRoutingChange(rule.severity, 'slack', event.target.value)}
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      />
                    </td>
                    <td className="px-2 py-3">
                      <input
                        type="text"
                        value={rule.teams}
                        onChange={event => handleRoutingChange(rule.severity, 'teams', event.target.value)}
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      />
                    </td>
                    <td className="px-2 py-3">
                      <input
                        type="text"
                        value={rule.discord}
                        onChange={event => handleRoutingChange(rule.severity, 'discord', event.target.value)}
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Update a provider settings card to save routing changes.
        </p>
      </section>

      <section className="rounded-xl border bg-card p-6 shadow-sm">
        <div>
          <h2 className="text-lg font-semibold">Message templates</h2>
          <p className="text-sm text-muted-foreground">
            Customize the message body that is sent to Slack, Teams, and Discord.
          </p>
        </div>

        <div className="mt-4 space-y-3">
          <textarea
            value={messageTemplate}
            onChange={event => setMessageTemplate(event.target.value)}
            rows={6}
            className="min-h-[140px] w-full rounded-md border bg-background p-3 text-sm"
          />
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {templateVariables.map(variable => (
              <span key={variable} className="rounded-full border bg-muted px-2 py-1">
                {variable}
              </span>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Variables are replaced at send time with alert metadata.
          </p>
        </div>
      </section>
    </div>
  );
}
