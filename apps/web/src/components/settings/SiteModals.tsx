import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import SiteForm from './SiteForm';
import type { Site } from './SiteList';
import type { SiteFormDefaults, SiteModalMode } from './useSiteCrud';

/**
 * The site add/edit/delete modal JSX, extracted verbatim from
 * `OrganizationsPage` (#5075 W02) so `OrgSitesTab` on the organization record
 * can render the exact same modals against `useSiteCrud`'s state instead of a
 * second, drifting copy.
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

  return (
    <>
      {/* Site Add/Edit Modal */}
      {(mode === 'add' || mode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="mb-4 flex items-start justify-between gap-4 rounded-lg border bg-card p-6 shadow-xs">
              <div>
                <h2 className="text-lg font-semibold">
                  {mode === 'edit'
                    ? t('organizationsPage.siteModal.editTitle')
                    : guidingFirstSite
                      ? t('organizationsPage.siteModal.firstTitle', { organization: orgName })
                      : t('organizationsPage.siteModal.addTitle')}
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
          </div>
        </div>
      )}

      {/* Site Delete Confirmation Modal */}
      {mode === 'delete' && selectedSite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('organizationsPage.deleteSite.title')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('organizationsPage.deleteSite.messagePrefix')} <span className="font-medium">{selectedSite.name}</span>?
              {t('organizationsPage.deleteSite.messageSuffix')}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void onConfirmDelete()}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? t('organizationsPage.actions.deleting') : t('common:actions.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
