# Microsoft 365 ticket mailbox re-consent

## Action required

This release strengthens Microsoft 365 ticket mailbox consent by verifying the Microsoft tenant and consenting administrator identity and binding verified tenant ownership to the Breeze partner.

All non-disabled Microsoft 365 ticket mailbox connections become `reauth_required` during the upgrade. Disabled rows that retain a legacy tenant or delta cursor also become `reauth_required` and have that state cleared. Already-disabled rows with neither value remain disabled and are not reactivated. Inbound Microsoft polling and outbound Microsoft Graph replies remain disabled until a full-partner mailbox administrator with MFA completes consent again. SMTP fallback for outbound customer mail remains active when no verified Graph mailbox resolves.

For each affected mailbox, a full-partner mailbox administrator must:

1. Complete MFA and sign in to Breeze.
2. Open **Settings → Partner → Ticketing**.
3. Select **Reconnect Microsoft 365** and complete the Microsoft consent flow with an eligible Microsoft 365 administrator.
4. Confirm that the mailbox connection returns to `connected`.

## Deployment

1. Deploy the database migration and API together.
2. Confirm that the API and migration are healthy.
3. Deploy the web UI.
4. Complete the administrator re-consent steps for each mailbox.

Do not deploy the new API before its database migration is complete.

## Verification

Run the following query as a database administrator after deployment. It must return zero rows. Any result identifies a `connected` mailbox without a matching `(tenant_id, partner_id)` ownership row.

```sql
SELECT c.id, c.partner_id, c.tenant_id, c.mailbox_address
FROM ticket_mailbox_connections AS c
LEFT JOIN ticket_mailbox_tenant_ownerships AS o
  ON o.tenant_id = c.tenant_id
 AND o.partner_id = c.partner_id
WHERE c.status = 'connected'
  AND o.tenant_id IS NULL;
```

Confirm that active connections and disabled rows with legacy tenant/cursor state remain `reauth_required` until their administrators complete consent again. Confirm that clean rows that were already disabled remain `disabled`. After re-consent, verify that inbound polling and outbound Graph replies resume only for the verified connection. Confirm that SMTP delivery remains available when no verified Graph mailbox resolves.

## Rollback

If the application deployment must be rolled back:

- Keep the mailbox tenant ownership and consent-session tables.
- Keep the composite tenant/partner foreign key and the connected-row ownership check.
- Keep legacy mailbox connections disabled until they complete verified consent again.
- Do not restore unsigned callback behavior.

The ownership data and database protections must remain in place while application services are rolled back.
