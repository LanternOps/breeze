-- Add AdGuard Home as a supported DNS filtering provider.
-- Self-hosted DNS sinkhole common with MSP clients (RFC 1918 / SOHO networks).
ALTER TYPE dns_provider ADD VALUE IF NOT EXISTS 'adguard_home';
