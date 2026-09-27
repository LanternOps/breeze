-- Self-service DNS-TXT ownership proof for adopting a sending-domain object
-- that already exists at the provider (see
-- services/emailDomains/dnsOwnershipProof.ts and domainSync.ts's
-- provision()). Previously the only way to adopt a pre-existing provider
-- object was an operator-maintained allowlist
-- (EMAIL_DOMAINS_ADOPT_EXISTING_ALLOWLIST); this column lets a partner prove
-- control of the domain by publishing a per-row token as a TXT record, which
-- the allowlist remains a belt-and-suspenders override for.
--
-- partner_sending_domains is partner-axis (RLS shape 3, no org_id column) —
-- this is a column addition to an already-registered table, so no new RLS
-- policy, cascade-list, or export-policy entry is needed (those triggers are
-- "new org_id table" / "new column on an org-cascade table"; this table has
-- neither).
ALTER TABLE partner_sending_domains
  ADD COLUMN IF NOT EXISTS ownership_verify_token varchar(64);
