// ============================================
// Auth Types
// ============================================

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  status: 'active' | 'invited' | 'disabled';
  avatarUrl: string | null;
  mfaEnabled: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface JWTPayload {
  sub: string;
  email: string;
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: 'system' | 'partner' | 'organization';
  iat: number;
  exp: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface LoginResponse {
  user: AuthUser;
  tokens: TokenPair | null;
  mfaRequired: boolean;
}

export interface MFASetupResponse {
  secret: string;
  otpAuthUrl: string;
  qrCodeDataUrl: string;
}

export interface PasswordResetRequest {
  token: string;
  password: string;
}
