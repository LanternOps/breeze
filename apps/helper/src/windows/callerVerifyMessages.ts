// Translated copy for the caller-verification card. All values are plain
// strings rendered as React text -- never HTML.

export type Copy = {
  title: string;
  notMe: string;
  failed: string;
  remaining: string;
  request: (technician: string, org: string, action: string, target: string) => string;
  safety: (technician: string, partner: string) => string;
};

export const messages: Record<string, Copy> = {
  en: {
    title: 'Caller verification',
    notMe: 'This is not me',
    failed: 'Could not send your answer. Try again.',
    remaining: 'seconds remaining',
    request: (t, o, a, x) => `${t} from ${o} is on the phone with you and wants to ${a} for ${x}`,
    safety: (t, p) =>
      `Only tap a number if you are on the phone with ${t} right now. If you are not sure, hang up and call ${p} on the number you already have.`,
  },
  'de-DE': {
    title: 'Anrufer bestätigen',
    notMe: 'Das bin ich nicht',
    failed: 'Ihre Antwort konnte nicht gesendet werden. Versuchen Sie es erneut.',
    remaining: 'Sekunden verbleibend',
    request: (t, o, a, x) => `${t} von ${o} spricht mit Ihnen am Telefon und möchte folgende Aktion für ${x} ausführen: ${a}`,
    safety: (t, p) =>
      `Tippen Sie nur auf eine Zahl, wenn Sie gerade mit ${t} telefonieren. Wenn Sie unsicher sind, legen Sie auf und rufen Sie ${p} unter der Ihnen bereits bekannten Nummer an.`,
  },
  'es-419': {
    title: 'Verificación de la persona que llama',
    notMe: 'No soy yo',
    failed: 'No se pudo enviar tu respuesta. Inténtalo de nuevo.',
    remaining: 'segundos restantes',
    request: (t, o, a, x) => `${t} de ${o} está hablando contigo por teléfono y quiere realizar esta acción para ${x}: ${a}`,
    safety: (t, p) =>
      `Toca un número solo si estás hablando por teléfono con ${t} en este momento. Si no estás seguro, cuelga y llama a ${p} al número que ya conoces.`,
  },
  'fr-CA': {
    title: 'Vérification de la personne qui appelle',
    notMe: 'Ce n’est pas moi',
    failed: 'Impossible d’envoyer votre réponse. Réessayez.',
    remaining: 'secondes restantes',
    request: (t, o, a, x) => `${t} de ${o} vous parle au téléphone et souhaite effectuer cette action pour ${x} : ${a}`,
    safety: (t, p) =>
      `Appuyez sur un numéro uniquement si vous êtes au téléphone avec ${t} en ce moment. En cas de doute, raccrochez et rappelez ${p} au numéro que vous connaissez déjà.`,
  },
  'fr-FR': {
    title: 'Vérification de l’appelant',
    notMe: 'Ce n’est pas moi',
    failed: 'Impossible d’envoyer votre réponse. Réessayez.',
    remaining: 'secondes restantes',
    request: (t, o, a, x) => `${t} de ${o} est au téléphone avec vous et souhaite effectuer cette action pour ${x} : ${a}`,
    safety: (t, p) =>
      `Appuyez sur un numéro uniquement si vous êtes au téléphone avec ${t} en ce moment. En cas de doute, raccrochez et rappelez ${p} au numéro que vous connaissez déjà.`,
  },
  'it-IT': {
    title: 'Verifica del chiamante',
    notMe: 'Non sono io',
    failed: 'Impossibile inviare la risposta. Riprova.',
    remaining: 'secondi rimanenti',
    request: (t, o, a, x) => `${t} di ${o} è al telefono con te e vuole eseguire questa azione per ${x}: ${a}`,
    safety: (t, p) =>
      `Tocca un numero solo se stai parlando al telefono con ${t} in questo momento. Se hai dubbi, riaggancia e chiama ${p} al numero che già conosci.`,
  },
  'pt-BR': {
    title: 'Verificação de quem está ligando',
    notMe: 'Não sou eu',
    failed: 'Não foi possível enviar sua resposta. Tente novamente.',
    remaining: 'segundos restantes',
    request: (t, o, a, x) => `${t} de ${o} está falando com você por telefone e quer realizar esta ação para ${x}: ${a}`,
    safety: (t, p) =>
      `Toque em um número somente se estiver falando ao telefone com ${t} agora. Se tiver dúvidas, desligue e ligue para ${p} usando o número que você já conhece.`,
  },
  'tr-TR': {
    title: 'Arayan doğrulaması',
    notMe: 'Bu ben değilim',
    failed: 'Yanıtınız gönderilemedi. Yeniden deneyin.',
    remaining: 'saniye kaldı',
    request: (t, o, a, x) => `${o} kuruluşundan ${t} sizinle telefonda konuşuyor ve ${x} için şu işlemi yapmak istiyor: ${a}`,
    safety: (t, p) =>
      `Yalnızca şu anda ${t} ile telefonda konuşuyorsanız bir sayıya dokunun. Emin değilseniz telefonu kapatın ve ${p} kuruluşunu zaten bildiğiniz numaradan arayın.`,
  },
};

const BASE_LOCALES: Record<string, string> = {
  en: 'en',
  de: 'de-DE',
  es: 'es-419',
  fr: 'fr-FR',
  it: 'it-IT',
  pt: 'pt-BR',
  tr: 'tr-TR',
};

export function copyFor(locale: string): Copy {
  return messages[locale] ?? messages[BASE_LOCALES[locale.split('-')[0]!.toLowerCase()] ?? 'en']!;
}
