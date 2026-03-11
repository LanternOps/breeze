interface BillingEvent {
  type: 'device.enrolled' | 'device.decommissioned' | 'device.status_changed';
  partnerId: string;
  orgId: string;
  deviceId: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export async function notifyBilling(event: BillingEvent): Promise<void> {
  const url = process.env.BILLING_SERVICE_URL;
  if (!url) return;
  try {
    await fetch(`${url}/webhooks/breeze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BILLING_SERVICE_API_KEY}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Silent failure — billing is non-critical
  }
}
