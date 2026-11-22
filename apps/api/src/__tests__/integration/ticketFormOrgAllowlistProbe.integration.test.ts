/**
 * #9692 — getTicketFormForOrg must honor a partner-wide form's org allowlist.
 * The probe's correlated EXISTS rendered `"form_id" = "id"`, which bound to
 * ticket_form_org_links.id, so `anyLinks` read false and the form looked open to
 * every org. The unit suite mocks the probe's result, so only real Postgres
 * shows that.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { ticketFormOrgLinks, ticketForms } from '../../db/schema';
import { getTicketFormForOrg, TicketFormError } from '../../services/ticketFormService';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const admin = () => getTestDb() as any;

let fx: { partnerId: string; listed: string; unlisted: string; formId: string };

beforeEach(async () => {
  const partner = await createPartner();
  const listed = await createOrganization({ partnerId: partner.id });
  const unlisted = await createOrganization({ partnerId: partner.id });
  const [form] = await admin()
    .insert(ticketForms)
    .values({ partnerId: partner.id, orgId: null, name: 'partner-wide' })
    .returning({ id: ticketForms.id });
  fx = { partnerId: partner.id, listed: listed.id, unlisted: unlisted.id, formId: form.id };
});

const forOrg = (id: string) => getTicketFormForOrg(fx.formId, { id, partnerId: fx.partnerId });

describe('getTicketFormForOrg allowlist probe', () => {
  it('leaves a form with no link rows open to every org under the partner', async () => {
    await expect(forOrg(fx.listed)).resolves.toMatchObject({ id: fx.formId });
    await expect(forOrg(fx.unlisted)).resolves.toMatchObject({ id: fx.formId });
  });

  it('admits a linked org and refuses an unlisted one once link rows exist', async () => {
    await admin().insert(ticketFormOrgLinks).values({ formId: fx.formId, orgId: fx.listed });

    await expect(forOrg(fx.listed)).resolves.toMatchObject({ id: fx.formId });
    const refused = await forOrg(fx.unlisted).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(TicketFormError);
    expect((refused as TicketFormError).message).toBe('Ticket form is not available for this organization');
  });

  it('judges each form by its own link rows', async () => {
    const [other] = await admin()
      .insert(ticketForms)
      .values({ partnerId: fx.partnerId, orgId: null, name: 'other' })
      .returning({ id: ticketForms.id });
    await admin().insert(ticketFormOrgLinks).values({ formId: other.id, orgId: fx.listed });

    // The other form's link must not put this form's allowlist in effect.
    await expect(forOrg(fx.unlisted)).resolves.toMatchObject({ id: fx.formId });
  });

  it('does not admit an org because another form lists it', async () => {
    const [other] = await admin()
      .insert(ticketForms)
      .values({ partnerId: fx.partnerId, orgId: null, name: 'other' })
      .returning({ id: ticketForms.id });
    await admin().insert(ticketFormOrgLinks).values([
      { formId: fx.formId, orgId: fx.listed },
      { formId: other.id, orgId: fx.unlisted },
    ]);

    const refused = await forOrg(fx.unlisted).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(TicketFormError);
  });
});
