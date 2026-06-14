import TicketingSettingsTabs from './TicketingSettingsTabs';

export default function TicketingSettingsPage() {
  return (
    <div className="space-y-6" data-testid="ticketing-settings-page">
      <div>
        <h1 className="text-xl font-semibold">Ticketing Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure ticket statuses, priority SLA defaults, categories, and billing exports.
        </p>
      </div>

      <TicketingSettingsTabs />
    </div>
  );
}
