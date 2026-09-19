import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import SiteForm from './SiteForm';
import type { Site } from './SiteList';
import type { SiteFormDefaults, SiteModalMode } from './useSiteCrud';
import { Dialog } from '../shared/Dialog';
import { ConfirmDialog } from '../shared/ConfirmDialog';

/**
 * The site add/edit/delete modal JSX, extracted verbatim from
 * `OrganizationsPage` (#5075 W02) so `OrgSitesTab` on the organization record
 * can render the exact same modals against `useSiteCrud`'s state instead of a
 * second, drifting copy.
 *
 * Both overlays are real dialogs (`shared/Dialog`): `role="dialog"`,
 * `aria-modal`, Escape, backdrop click, focus trap and focus restore. The
 * bare `fixed inset-0` divs they replaced had none of that, so a keyboard
 * user's Tab walked the page underneath the modal.
 */
export interface SiteModalsProps {
  mode: SiteModalMode;
  selectedSite: Site | null;
  guidingFirstSite: boolean;
  /** Interpolated into the add-modal's title/description; the org this
   *  set of sites belongs to. */
  orgName?: string;
  /** Pre-selects a new site's timezone instead of the form's UTC default. */
  partnerTimezone?: string;
  submitting: boolean;
  onSubmit: (values: Record<string, unknown>) => void | Promise<void>;
  onClose: () => void;
  onConfirmDelete: () => void | Promise<void>;
  getSiteFormDefaults: (
    site: Site & { address?: Record<string, string>; contact?: Record<string, string> },
  ) => SiteFormDefaults;
}

const SITE_FORM_TITLE_ID = 'site-form-dialog-title';
const noop = () => {};

export default function SiteModals({
  mode,
  selectedSite,
  guidingFirstSite,
  orgName,
  partnerTimezone,
  submitting,
  onSubmit,
  onClose,
  onConfirmDelete,
  getSiteFormDefaults,
}: SiteModalsProps) {
  const { t } = useTranslation('settings');

  const formOpen = mode === 'add' || mode === 'edit';
  const formTitle =
    mode === 'edit'
      ? t('organizationsPage.siteModal.editTitle')
      : guidingFirstSite
        ? t('organizationsPage.siteModal.firstTitle', { organization: orgName })
        : t('organizationsPage.siteModal.addTitle');

  return (
    <>
      {/* Site Add/Edit dialog. Escape and the backdrop are inert while a
          submit is in flight so a half-saved form cannot be dismissed. */}
      {formOpen && (
        <Dialog
          open
          onClose={submitting ? noop : onClose}
          title={formTitle}
          labelledBy={SITE_FORM_TITLE_ID}
          maxWidth="2xl"
          alignTop
        >
          <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
            <div>
              <h2 id={SITE_FORM_TITLE_ID} className="text-lg font-semibold">
                {formTitle}
              </h2>
              <p className="text-sm text-muted-foreground">
                {mode === 'edit'
                  ? t('organizationsPage.siteModal.editDescription')
                  : guidingFirstSite
                    ? t('organizationsPage.siteModal.firstDescription')
                    : t('organizationsPage.siteModal.addDescription', { organization: orgName })}
              </p>
            </div>
            {guidingFirstSite && (
              <button
                type="button"
                onClick={onClose}
                className="shrink-0 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                {t('organizationsPage.siteModal.skip')}
              </button>
            )}
          </div>
          <SiteForm
            onSubmit={onSubmit}
            onCancel={onClose}
            className="space-y-6 p-6"
            defaultValues={
              selectedSite
                ? getSiteFormDefaults(selectedSite as Site & { address?: Record<string, string>; contact?: Record<string, string> })
                : partnerTimezone
                  ? { timezone: partnerTimezone }
                  : undefined
            }
            submitLabel={
              mode === 'edit'
                ? t('organizationsPage.siteModal.saveChanges')
                : guidingFirstSite
                  ? t('organizationsPage.siteModal.createFirst')
                  : t('organizationsPage.siteModal.create')
            }
            loading={submitting}
          />
        </Dialog>
      )}

      {/* Site Delete confirmation — the shared destructive ConfirmDialog, so it
          carries the same shape-coded icon, single-fire latch and dialog
          semantics as every other delete in the app.

          `devices.site_id` is NOT NULL with a plain FK to `sites` (no ON
          DELETE), so the API's DELETE cannot succeed while devices are still
          on the site — it aborts on the FK. Say so before the click and
          disable Confirm, instead of letting the operator learn it from a
          failed request. */}
      {mode === 'delete' && selectedSite && (
        <ConfirmDialog
          open
          onClose={submitting ? noop : onClose}
          onConfirm={() => void onConfirmDelete()}
          title={t('organizationsPage.deleteSite.title')}
          message={
            selectedSite.deviceCount > 0
              ? t('organizationsPage.deleteSite.blockedMessage', { name: selectedSite.name, count: selectedSite.deviceCount })
              : t('organizationsPage.deleteSite.message', { name: selectedSite.name })
          }
          confirmLabel={t('common:actions.delete')}
          variant="destructive"
          isLoading={submitting}
          confirmDisabled={selectedSite.deviceCount > 0}
          confirmTestId="site-delete-confirm"
        />
      )}
    </>
  );
}
