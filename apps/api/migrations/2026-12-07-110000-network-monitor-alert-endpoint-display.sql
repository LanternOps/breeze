-- Network-monitor alerts show endpoints as scheme + host (#7920 follow-up).
--
-- Since #7920 the monitor worker writes the check target into a new alert's
-- message and context.target as scheme + host, and check error text is
-- reduced the same way before it is stored. Alerts created before that still
-- hold the full endpoint URL in `message`, `context.target` and
-- `context.error`. This rewrites those rows the way the worker now writes them.
--
-- Scope: only alerts whose context.source is 'network_monitor' (set by
-- monitorWorker.ts for every alert it creates). Alerts from other sources and
-- tickets are not touched: a ticket is a record people have since read and
-- edited, and new tickets created from an alert already reduce the copied
-- text (createTicketFromAlert).
--
-- Mirrors utils/endpointDisplay.ts:
--   * a URL token (scheme://...) keeps scheme + host[:port]; userinfo, path,
--     query and fragment are dropped; trailing punctuation stays in the text.
--   * a scheme-less target with userinfo, a path or a query keeps its host.
-- Idempotent: rows already in the reduced form are left unchanged.

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
  url_token CONSTANT text :=
    '([A-Za-z][A-Za-z0-9+.-]*://)([^/?#[:space:]"<>`]*@)?([^/?#[:space:]"<>`@]*)([^[:space:]"<>`]*[^[:space:]"<>`)\]''.,;:!?])?';
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  WITH src AS (
    SELECT
      a.id,
      a.message,
      a.context,
      a.context->>'target' AS raw_target,
      CASE
        WHEN jsonb_typeof(a.context->'target') IS DISTINCT FROM 'string' THEN NULL
        WHEN a.context->>'target' ~ '^[A-Za-z][A-Za-z0-9+.-]*://'
          THEN regexp_replace(a.context->>'target', url_token, '\1\3', 'g')
        WHEN a.context->>'target' ~ '[/?#@]'
          THEN COALESCE(
            NULLIF(regexp_replace(regexp_replace(a.context->>'target', '^.*@', ''), '[/?#].*$', ''), ''),
            '[invalid-url]'
          )
        ELSE a.context->>'target'
      END AS shown_target
    FROM alerts a
    WHERE a.context->>'source' = 'network_monitor'
  ),
  next AS (
    SELECT
      s.id,
      regexp_replace(
        CASE
          -- Same guard as scrubAlertText: a target with no host part ('@',
          -- '/', 'x@') would rewrite unrelated characters of the message.
          WHEN s.shown_target IS NOT NULL
           AND s.shown_target <> s.raw_target
           AND s.shown_target <> '[invalid-url]'
           AND length(s.raw_target) >= 4
            THEN replace(s.message, s.raw_target, s.shown_target)
          ELSE s.message
        END,
        url_token, '\1\3', 'g'
      ) AS new_message,
      s.context
        || CASE WHEN s.shown_target IS NOT NULL
             THEN jsonb_build_object('target', s.shown_target) ELSE '{}'::jsonb END
        || CASE WHEN jsonb_typeof(s.context->'error') = 'string'
             THEN jsonb_build_object('error', regexp_replace(s.context->>'error', url_token, '\1\3', 'g'))
             ELSE '{}'::jsonb END
        AS new_context
    FROM src s
  )
  UPDATE alerts a
     SET message = nx.new_message,
         context = nx.new_context
    FROM next nx
   WHERE a.id = nx.id
     AND (a.message IS DISTINCT FROM nx.new_message OR a.context IS DISTINCT FROM nx.new_context);

  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'network-monitor alert endpoint display: % alert rows updated', n;
END $$;
