-- Caller verification (anti-vishing) W01: conservative destination backfill.
-- Every nonblank legacy contact email/mobile becomes one 'import'-sourced
-- provenance row dated from the contact's last update. Import provenance is
-- never "established" on its own (a human must attest it), so this cannot
-- manufacture assurance. Malformed legacy values are preserved as history;
-- attestation and method availability reject them until corrected. Mobile
-- country codes are never guessed. Idempotent: a contact/kind that already
-- has any destination row is skipped.
--
-- Writes rows, so system scope is elected first (RLS is FORCEd for the table
-- owner; without this the INSERT would abort with 42501).
SELECT set_config('breeze.scope','system',true);
DO $$ DECLARE n bigint; BEGIN
 INSERT INTO caller_verification_destinations(org_id,contact_id,kind,value_hash,value_redacted,set_at,source)
 SELECT c.org_id,c.id,v.kind::caller_verification_destination_kind,
  encode(sha256(convert_to(v.value,'UTF8')),'hex'),
  CASE WHEN v.kind='email' THEN left(left(v.value,1)||'***@'||split_part(v.value,'@',2),64)
       ELSE '+***'||right(v.value,2) END,
  c.updated_at,'import'
 FROM contacts c CROSS JOIN LATERAL (VALUES
  ('email',nullif(lower(btrim(c.email)),'')),
  ('mobile',nullif(regexp_replace(c.mobile,'[[:space:]().-]','','g'),''))) v(kind,value)
 WHERE v.value IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM caller_verification_destinations d WHERE d.contact_id=c.id AND d.kind=v.kind::caller_verification_destination_kind)
 ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS n = ROW_COUNT;
 RAISE WARNING 'caller verification destinations backfilled: %',n;
END $$;
