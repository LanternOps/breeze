const RESEND_BASE = 'https://api.resend.com';

export function extractVerifyToken(html: string): string | null {
  const m = html.match(/verify-email\?token=([A-Za-z0-9_-]{48})/);
  return m ? m[1] : null;
}

interface ResendListItem { id: string; to: string[] | string; subject?: string; created_at?: string }

async function resend(path: string, apiKey: string): Promise<any> {
  const res = await fetch(`${RESEND_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Resend ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

function toList(to: string[] | string | undefined): string[] {
  if (!to) return [];
  return Array.isArray(to) ? to : [to];
}

/**
 * Poll Resend's sent log for the verification email to `recipient`, fetch its
 * HTML, and return the 48-char token. Throws on timeout.
 */
export async function fetchVerifyToken(opts: {
  apiKey: string;
  recipient: string;
  timeoutMs?: number;
}): Promise<string> {
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  let delay = 2_000;
  while (Date.now() < deadline) {
    const list = (await resend('/emails?limit=100', opts.apiKey)) as { data?: ResendListItem[] };
    const match = (list.data ?? []).find((e) =>
      toList(e.to).some((addr) => addr.toLowerCase() === opts.recipient.toLowerCase()),
    );
    if (match) {
      const full = (await resend(`/emails/${match.id}`, opts.apiKey)) as { html?: string; text?: string };
      const token = extractVerifyToken(full.html ?? full.text ?? '');
      if (token) return token;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 10_000);
  }
  throw new Error(`Verification email to ${opts.recipient} not observed in Resend within budget`);
}
