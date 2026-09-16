-- Repair existing drift before enforcing ticket organization/partner coherence.
DO $$
DECLARE
  n bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  UPDATE public.tickets t
     SET partner_id = o.partner_id
    FROM public.organizations o
   WHERE t.org_id = o.id
     AND t.partner_id IS DISTINCT FROM o.partner_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'realigned % tickets partner_id', n;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tickets_org_partner_fk'
       AND conrelid = 'public.tickets'::regclass
  ) THEN
    ALTER TABLE public.tickets
      ADD CONSTRAINT tickets_org_partner_fk
      FOREIGN KEY (org_id, partner_id)
      REFERENCES public.organizations(id, partner_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;
