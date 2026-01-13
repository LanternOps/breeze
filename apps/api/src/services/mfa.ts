import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';

export function generateMFASecret(): string {
  return generateSecret({ length: 20 });
}

export async function verifyMFAToken(secret: string, token: string): Promise<boolean> {
  try {
    const result = await verify({
      secret,
      token,
      epochTolerance: 30 // Allow ~30 seconds tolerance for clock drift
    });
    return result.valid;
  } catch {
    return false;
  }
}

export function generateOTPAuthURL(secret: string, email: string): string {
  return generateURI({
    secret,
    issuer: 'Breeze RMM',
    label: email,
    algorithm: 'sha1',
    digits: 6,
    period: 30
  });
}

export async function generateQRCode(otpAuthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpAuthUrl, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 256
  });
}

export function generateRecoveryCodes(count: number = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = Array.from({ length: 8 }, () =>
      Math.random().toString(36).charAt(2)
    ).join('').toUpperCase();
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}
