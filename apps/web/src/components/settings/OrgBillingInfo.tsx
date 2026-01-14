import {
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  CreditCard,
  HardDrive,
  Receipt,
  Server,
  Users
} from 'lucide-react';

const mockBilling = {
  organizationName: 'Breeze Labs',
  plan: 'Growth',
  price: '$249',
  billingCycle: 'per month',
  renewalDate: 'Oct 4, 2024',
  usage: {
    devices: 842,
    deviceLimit: 1000,
    users: 58,
    userLimit: 75,
    storage: 2.8,
    storageLimit: 5
  },
  billingContact: {
    name: 'Jordan Lee',
    email: 'billing@breeze.io',
    phone: '+1 (555) 013-9981'
  },
  paymentMethod: {
    brand: 'Visa',
    last4: '4242',
    expiry: '08/26'
  },
  invoices: [
    { id: 'INV-2024-1004', date: 'Sep 4, 2024', amount: '$249.00', status: 'Paid' },
    { id: 'INV-2024-0904', date: 'Aug 4, 2024', amount: '$249.00', status: 'Paid' },
    { id: 'INV-2024-0804', date: 'Jul 4, 2024', amount: '$249.00', status: 'Paid' },
    { id: 'INV-2024-0704', date: 'Jun 4, 2024', amount: '$249.00', status: 'Paid' }
  ]
};

export default function OrgBillingInfo() {
  return (
    <section className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Billing</h2>
          <p className="text-sm text-muted-foreground">
            Plan details and invoices for {mockBilling.organizationName}.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <ArrowUpRight className="h-4 w-4" />
          Upgrade plan
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6">
          <div className="rounded-lg border bg-muted/40 p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs uppercase text-muted-foreground">Current plan</p>
                <h3 className="text-xl font-semibold">{mockBilling.plan}</h3>
                <p className="text-sm text-muted-foreground">
                  {mockBilling.price} {mockBilling.billingCycle}
                </p>
              </div>
              <div className="flex items-center gap-2 text-sm text-emerald-600">
                <CheckCircle2 className="h-4 w-4" />
                Active
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" />
              Next renewal on {mockBilling.renewalDate}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-xs uppercase text-muted-foreground">
                <Server className="h-3.5 w-3.5" />
                Devices
              </div>
              <p className="mt-2 text-lg font-semibold">
                {mockBilling.usage.devices} / {mockBilling.usage.deviceLimit}
              </p>
              <p className="text-xs text-muted-foreground">Managed endpoints</p>
            </div>
            <div className="rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-xs uppercase text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                Users
              </div>
              <p className="mt-2 text-lg font-semibold">
                {mockBilling.usage.users} / {mockBilling.usage.userLimit}
              </p>
              <p className="text-xs text-muted-foreground">Licensed seats</p>
            </div>
            <div className="rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-xs uppercase text-muted-foreground">
                <HardDrive className="h-3.5 w-3.5" />
                Storage
              </div>
              <p className="mt-2 text-lg font-semibold">
                {mockBilling.usage.storage}TB / {mockBilling.usage.storageLimit}TB
              </p>
              <p className="text-xs text-muted-foreground">Retention storage</p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Receipt className="h-4 w-4" />
                Billing contact
              </div>
              <p className="mt-3 text-sm font-semibold">{mockBilling.billingContact.name}</p>
              <p className="text-xs text-muted-foreground">{mockBilling.billingContact.email}</p>
              <p className="text-xs text-muted-foreground">{mockBilling.billingContact.phone}</p>
            </div>
            <div className="rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <CreditCard className="h-4 w-4" />
                Payment method
              </div>
              <p className="mt-3 text-sm font-semibold">
                {mockBilling.paymentMethod.brand} ending in {mockBilling.paymentMethod.last4}
              </p>
              <p className="text-xs text-muted-foreground">Expires {mockBilling.paymentMethod.expiry}</p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Receipt className="h-4 w-4" />
            Invoice history
          </div>
          <div className="mt-4 overflow-auto">
            <table className="w-full min-w-[260px] text-left text-xs">
              <thead className="text-[11px] uppercase text-muted-foreground">
                <tr>
                  <th className="px-2 py-2">Invoice</th>
                  <th className="px-2 py-2">Date</th>
                  <th className="px-2 py-2">Amount</th>
                  <th className="px-2 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {mockBilling.invoices.map(invoice => (
                  <tr key={invoice.id} className="border-t">
                    <td className="px-2 py-2 font-medium">{invoice.id}</td>
                    <td className="px-2 py-2">{invoice.date}</td>
                    <td className="px-2 py-2">{invoice.amount}</td>
                    <td className="px-2 py-2">
                      <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                        {invoice.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
