import { useTranslation } from 'react-i18next';
import { centsToDollars, TICK_MAX, type WispGrantSettingsControls } from './useWispGrantControls';

/**
 * The grant's operational settings (W04 Task 8): daily budget and check-in
 * floor behind one Save, then the unattended-reads (#10973) and session-notes
 * (#10390) switches in their own sections (settings rule 7). The full header
 * shows it inline; the docked pane shows it in a popover.
 */
export default function WispGrantSettingsPanel({ settings, className }: { settings: WispGrantSettingsControls; className: string }) {
  const { t } = useTranslation('ai');
  const {
    budget, setBudget, tick, setTick, saving, save, budgetMax, tickMin,
    unattendedReadsOn, unattendedReadsSaving, toggleUnattendedReads,
    summaryRefineOn, summaryRefineSaving, toggleSummaryRefine,
  } = settings;

  return (
    <div className={className} data-testid="wisp-settings-panel">
      <p className="font-medium">{t('wisp.settings.title')}</p>
      <label className="flex items-center justify-between gap-2">
        {t('wisp.settings.budget')}
        <input
          type="number"
          data-testid="wisp-settings-budget"
          min={0}
          step="0.01"
          max={budgetMax === null ? undefined : centsToDollars(budgetMax)}
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          className="w-24 rounded border bg-background px-2 py-1"
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        {t('wisp.settings.tick')}
        <input
          type="number"
          data-testid="wisp-settings-tick"
          min={tickMin}
          max={TICK_MAX}
          value={tick}
          onChange={(e) => setTick(e.target.value)}
          className="w-24 rounded border bg-background px-2 py-1"
        />
      </label>
      <div className="flex justify-end">
        <button
          type="button"
          data-testid="wisp-settings-save"
          disabled={saving}
          onClick={() => void save()}
          className="rounded bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50"
        >
          {t('wisp.settings.save')}
        </button>
      </div>
      {/* #10973, settings rule 7: its own section, outside the Save form. Off autosaves; on asks for a step-up. */}
      <section className="space-y-1 border-t pt-2" data-testid="wisp-settings-unattended-reads" aria-labelledby="wisp-unattended-reads-title">
        <div className="flex items-center justify-between gap-2">
          <p id="wisp-unattended-reads-title" className="font-medium">{t('wisp.settings.unattendedReads.title')}</p>
          <button
            type="button"
            role="switch"
            aria-checked={unattendedReadsOn}
            aria-labelledby="wisp-unattended-reads-title"
            data-testid="wisp-unattended-reads-switch"
            disabled={unattendedReadsSaving}
            onClick={() => void toggleUnattendedReads()}
            className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${unattendedReadsOn ? 'bg-primary' : 'bg-muted'}`}
          >
            <span className={`inline-block h-3 w-3 rounded-full bg-background shadow transition-transform ${unattendedReadsOn ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <p className="text-muted-foreground">{t('wisp.settings.unattendedReads.description')}</p>
        <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
          <li>{t('wisp.settings.unattendedReads.registryKey')}</li>
          <li>{t('wisp.settings.unattendedReads.registryValue')}</li>
          <li>{t('wisp.settings.unattendedReads.securityLog')}</li>
          <li>{t('wisp.settings.unattendedReads.deviceNote')}</li>
        </ul>
        <p className="text-muted-foreground">{t('wisp.settings.unattendedReads.applies')}</p>
      </section>
      {/* #10390, settings rule 7: its own section, outside the Save form. Autosaves both ways. */}
      <section className="space-y-1 border-t pt-2" data-testid="wisp-settings-summary-refine" aria-labelledby="wisp-summary-refine-title">
        <div className="flex items-center justify-between gap-2">
          <p id="wisp-summary-refine-title" className="font-medium">{t('wisp.settings.summaryRefine.title')}</p>
          <button
            type="button"
            role="switch"
            aria-checked={summaryRefineOn}
            aria-labelledby="wisp-summary-refine-title"
            data-testid="wisp-summary-refine-switch"
            disabled={summaryRefineSaving}
            onClick={() => void toggleSummaryRefine()}
            className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${summaryRefineOn ? 'bg-primary' : 'bg-muted'}`}
          >
            <span className={`inline-block h-3 w-3 rounded-full bg-background shadow transition-transform ${summaryRefineOn ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <p className="text-muted-foreground">{t('wisp.settings.summaryRefine.description')}</p>
      </section>
    </div>
  );
}
