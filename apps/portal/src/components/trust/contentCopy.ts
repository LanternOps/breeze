// Owner: W02f. Public-page copy for the subprocessor table, the FAQ and the controls-met history (defineTrustCopy,
// 8 locales; the portal has no i18next runtime). pt-BR, es-419, fr-FR, fr-CA, de-DE, it-IT and tr-TR are
// machine-drafted pending native review.
import { defineTrustCopy } from './trustCopy';

export const CONTENT_COPY = defineTrustCopy({
  en: {
    subprocessorsHeading: 'Subprocessors', colName: 'Name', colPurpose: 'Purpose', colLocation: 'Location', colWebsite: 'Website',
    faqHeading: 'Frequently asked questions',
    historyHeading: 'Controls met over time',
    historyCaption: 'Controls met over the last 90 days. Each change is recorded when Breeze re-evaluates the page.',
    historySummary: (met: number, shown: number) => `${met} of ${shown} controls met`,
  },
  'pt-BR': {
    subprocessorsHeading: 'Subprocessadores', colName: 'Nome', colPurpose: 'Finalidade', colLocation: 'Localização', colWebsite: 'Site',
    faqHeading: 'Perguntas frequentes',
    historyHeading: 'Controles atendidos ao longo do tempo',
    historyCaption: 'Controles atendidos nos últimos 90 dias. Cada mudança é registrada quando o Breeze reavalia a página.',
    historySummary: (met: number, shown: number) => `${met} de ${shown} controles atendidos`,
  },
  'es-419': {
    subprocessorsHeading: 'Subencargados del tratamiento', colName: 'Nombre', colPurpose: 'Finalidad', colLocation: 'Ubicación', colWebsite: 'Sitio web',
    faqHeading: 'Preguntas frecuentes',
    historyHeading: 'Controles cumplidos a lo largo del tiempo',
    historyCaption: 'Controles cumplidos en los últimos 90 días. Cada cambio se registra cuando Breeze vuelve a evaluar la página.',
    historySummary: (met: number, shown: number) => `${met} de ${shown} controles cumplidos`,
  },
  'fr-FR': {
    subprocessorsHeading: 'Sous-traitants ultérieurs', colName: 'Nom', colPurpose: 'Finalité', colLocation: 'Emplacement', colWebsite: 'Site web',
    faqHeading: 'Questions fréquentes',
    historyHeading: 'Contrôles satisfaits dans le temps',
    historyCaption: 'Contrôles satisfaits au cours des 90 derniers jours. Chaque changement est enregistré lorsque Breeze réévalue la page.',
    historySummary: (met: number, shown: number) => `${met} contrôles satisfaits sur ${shown}`,
  },
  'fr-CA': {
    subprocessorsHeading: 'Sous-traitants ultérieurs', colName: 'Nom', colPurpose: 'Finalité', colLocation: 'Emplacement', colWebsite: 'Site Web',
    faqHeading: 'Foire aux questions',
    historyHeading: 'Contrôles respectés dans le temps',
    historyCaption: 'Contrôles respectés au cours des 90 derniers jours. Chaque changement est consigné lorsque Breeze réévalue la page.',
    historySummary: (met: number, shown: number) => `${met} contrôles respectés sur ${shown}`,
  },
  'de-DE': {
    subprocessorsHeading: 'Unterauftragsverarbeiter', colName: 'Name', colPurpose: 'Zweck', colLocation: 'Standort', colWebsite: 'Website',
    faqHeading: 'Häufig gestellte Fragen',
    historyHeading: 'Erfüllte Kontrollen im Zeitverlauf',
    historyCaption: 'Erfüllte Kontrollen der letzten 90 Tage. Jede Änderung wird erfasst, wenn Breeze die Seite neu bewertet.',
    historySummary: (met: number, shown: number) => `${met} von ${shown} Kontrollen erfüllt`,
  },
  'it-IT': {
    subprocessorsHeading: 'Sub-responsabili del trattamento', colName: 'Nome', colPurpose: 'Finalità', colLocation: 'Ubicazione', colWebsite: 'Sito web',
    faqHeading: 'Domande frequenti',
    historyHeading: 'Controlli soddisfatti nel tempo',
    historyCaption: 'Controlli soddisfatti negli ultimi 90 giorni. Ogni variazione viene registrata quando Breeze rivaluta la pagina.',
    historySummary: (met: number, shown: number) => `${met} controlli soddisfatti su ${shown}`,
  },
  'tr-TR': {
    subprocessorsHeading: 'Alt veri işleyenler', colName: 'Ad', colPurpose: 'Amaç', colLocation: 'Konum', colWebsite: 'Web sitesi',
    faqHeading: 'Sık sorulan sorular',
    historyHeading: 'Zaman içinde karşılanan kontroller',
    historyCaption: 'Son 90 günde karşılanan kontroller. Breeze sayfayı yeniden değerlendirdiğinde her değişiklik kaydedilir.',
    historySummary: (met: number, shown: number) => `${shown} kontrolün ${met} tanesi karşılandı`,
  },
});
