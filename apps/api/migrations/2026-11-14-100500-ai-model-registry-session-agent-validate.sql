-- AI model registry W02 (#7600): validate the ai_sessions constraints -100400
-- added NOT VALID. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, so chat
-- reads and writes continue during the scan (the new columns are all NULL, so
-- every row passes). A no-op once validated. Writes no rows.
ALTER TABLE public.ai_sessions VALIDATE CONSTRAINT ai_sessions_offering_shape_chk;
ALTER TABLE public.ai_sessions VALIDATE CONSTRAINT ai_sessions_offering_fk;
ALTER TABLE public.ai_sessions VALIDATE CONSTRAINT ai_sessions_offering_org_partner_fk;
