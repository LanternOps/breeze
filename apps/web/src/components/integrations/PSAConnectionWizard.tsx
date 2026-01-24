import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  KeyRound,
  Server,
  Settings2,
  ShieldCheck,
  Wand2
} from 'lucide-react';

type StepId = 1 | 2 | 3 | 4 | 5;

type Provider = {
  id: string;
  name: string;
  description: string;
  focus: string;
};

const providers: Provider[] = [
  {
    id: 'connectwise',
    name: 'ConnectWise',
    description: 'Sync service boards, companies, and configurations.',
    focus: 'Service desk and project operations'
  },
  {
    id: 'autotask',
    name: 'Datto Autotask',
    description: 'Sync tickets, contracts, and time entries.',
    focus: 'Billing and contract automation'
  },
  {
    id: 'halo',
    name: 'HaloPSA',
    description: 'Link assets and SLAs into your workflows.',
    focus: 'Modern PSA and ITSM'
  },
  {
    id: 'bms',
    name: 'Kaseya BMS',
    description: 'Bridge projects and service level agreements.',
    focus: 'Customer lifecycle visibility'
  }
];

const steps = [
  { id: 1, label: 'Provider' },
  { id: 2, label: 'Credentials' },
  { id: 3, label: 'Test' },
  { id: 4, label: 'Sync options' },
  { id: 5, label: 'Mapping' }
] as const;

export default function PSAConnectionWizard() {
  const [step, setStep] = useState<StepId>(1);
  const [selectedProvider, setSelectedProvider] = useState<Provider>(providers[0]!);
  const [apiUrl, setApiUrl] = useState('https://api.connectwise.com/v1');
  const [apiKey, setApiKey] = useState('cw_key_live_123');
  const [clientId, setClientId] = useState('cw-client-001');
  const [region, setRegion] = useState('US');
  const [testStatus, setTestStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [syncTickets, setSyncTickets] = useState(true);
  const [syncAssets, setSyncAssets] = useState(true);
  const [syncTimeEntries, setSyncTimeEntries] = useState(false);
  const [syncContacts, setSyncContacts] = useState(true);

  const canNext = useMemo(() => {
    if (step === 1) return !!selectedProvider;
    if (step === 2) return apiUrl.length > 4 && apiKey.length > 4;
    if (step === 3) return testStatus === 'success';
    return true;
  }, [apiKey, apiUrl, selectedProvider, step, testStatus]);

  const goNext = () => setStep(prev => (prev < 5 ? ((prev + 1) as StepId) : prev));
  const goBack = () => setStep(prev => (prev > 1 ? ((prev - 1) as StepId) : prev));

  const handleTestConnection = () => {
    const success = apiKey.startsWith('cw') || apiKey.startsWith('auto');
    setTestStatus(success ? 'success' : 'error');
  };

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">PSA connection wizard</h2>
          <p className="text-sm text-muted-foreground">
            Complete the steps to sync tickets, assets, and workflows.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {steps.map(item => (
            <span
              key={item.id}
              className={`rounded-full border px-3 py-1 text-xs ${
                step === item.id
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground'
              }`}
            >
              {item.id}. {item.label}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-6 rounded-lg border bg-background p-6">
        {step === 1 && (
          <div>
            <div className="flex items-center gap-3 text-sm font-semibold text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Select PSA provider
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {providers.map(provider => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => setSelectedProvider(provider)}
                  className={`rounded-lg border p-4 text-left transition ${
                    selectedProvider.id === provider.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/40'
                  }`}
                >
                  <h3 className="text-base font-semibold">{provider.name}</h3>
                  <p className="text-sm text-muted-foreground">{provider.description}</p>
                  <p className="mt-2 text-xs text-muted-foreground">{provider.focus}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-sm font-semibold text-muted-foreground">
              <KeyRound className="h-4 w-4 text-primary" />
              Enter credentials
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="text-sm font-medium">API URL</label>
                <input
                  type="url"
                  value={apiUrl}
                  onChange={event => setApiUrl(event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-sm font-medium">API key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={event => setApiKey(event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Client ID</label>
                <input
                  type="text"
                  value={clientId}
                  onChange={event => setClientId(event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Region</label>
                <select
                  value={region}
                  onChange={event => setRegion(event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="US">United States</option>
                  <option value="EU">Europe</option>
                  <option value="APAC">APAC</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-sm font-semibold text-muted-foreground">
              <Server className="h-4 w-4 text-primary" />
              Test connection
            </div>
            <div className="rounded-lg border bg-muted/30 p-4 text-sm">
              <p className="font-medium">Provider</p>
              <p className="text-muted-foreground">{selectedProvider.name}</p>
              <p className="mt-3 font-medium">Endpoint</p>
              <p className="text-muted-foreground">{apiUrl}</p>
            </div>
            <button
              type="button"
              onClick={handleTestConnection}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted"
            >
              <Wand2 className="h-4 w-4" />
              Run test
            </button>
            {testStatus !== 'idle' && (
              <div
                className={`rounded-lg border px-4 py-3 text-sm ${
                  testStatus === 'success'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-rose-200 bg-rose-50 text-rose-700'
                }`}
              >
                {testStatus === 'success'
                  ? 'Connection successful. Permissions validated.'
                  : 'Connection failed. Verify the API key and URL.'}
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-sm font-semibold text-muted-foreground">
              <Settings2 className="h-4 w-4 text-primary" />
              Configure sync options
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex items-center justify-between rounded-lg border bg-background p-4 text-sm">
                <span>Sync tickets and status updates</span>
                <input
                  type="checkbox"
                  checked={syncTickets}
                  onChange={event => setSyncTickets(event.target.checked)}
                  className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border bg-background p-4 text-sm">
                <span>Sync assets and configurations</span>
                <input
                  type="checkbox"
                  checked={syncAssets}
                  onChange={event => setSyncAssets(event.target.checked)}
                  className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border bg-background p-4 text-sm">
                <span>Sync time entries</span>
                <input
                  type="checkbox"
                  checked={syncTimeEntries}
                  onChange={event => setSyncTimeEntries(event.target.checked)}
                  className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border bg-background p-4 text-sm">
                <span>Sync contacts and orgs</span>
                <input
                  type="checkbox"
                  checked={syncContacts}
                  onChange={event => setSyncContacts(event.target.checked)}
                  className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                />
              </label>
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-sm font-semibold text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              Field mapping preview
            </div>
            <div className="overflow-hidden rounded-lg border">
              <table className="min-w-full divide-y text-sm">
                <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold">Breeze field</th>
                    <th className="px-4 py-3 text-left font-semibold">PSA field</th>
                    <th className="px-4 py-3 text-left font-semibold">Default</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  <tr>
                    <td className="px-4 py-3">Account name</td>
                    <td className="px-4 py-3">{selectedProvider.name} Company</td>
                    <td className="px-4 py-3 text-muted-foreground">-</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3">Ticket priority</td>
                    <td className="px-4 py-3">Priority</td>
                    <td className="px-4 py-3 text-muted-foreground">P3</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3">Assigned team</td>
                    <td className="px-4 py-3">Service board</td>
                    <td className="px-4 py-3 text-muted-foreground">NOC</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3">Asset type</td>
                    <td className="px-4 py-3">Configuration type</td>
                    <td className="px-4 py-3 text-muted-foreground">Endpoint</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={goBack}
          disabled={step === 1}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {step < 5 ? (
            <button
              type="button"
              onClick={goNext}
              disabled={!canNext}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Continue
              <ArrowRight className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Save connection
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
