/**
 * Consent-Leck — lädt der Shop Tracker, bevor jemand „Ok" gesagt hat?
 *
 * Die Grenze ist hart: Wer ablehnt (oder noch gar nichts entschieden hat), wird
 * nie mit ID, Cookie, Fingerprint, GA4, Ads oder Meta erfasst. Genau diese
 * Grenze ist in der Vergangenheit still gerissen: GTM pingte GA4 und Ads für
 * alle Besucher, die WooCommerce-Bestellzuordnung setzte sbjs-Cookies bei
 * jedem, und Brevo kam um den 28.09.2026 herum unbemerkt dazu. Nichts davon
 * sieht man von außen am HTML — nur im Netzwerkverkehr eines echten Browsers.
 *
 * Deshalb lädt dieser Check Startseite, Konfigurator und eine Landingpage in
 * einem frischen Browser-Profil (Handy und Desktop, ohne Consent-Cookie),
 * protokolliert jeden Request und jeden Cookie und ordnet sie drei Listen zu:
 *
 *   FEHLER   Tracker ohne Einwilligung → Alarm.
 *   BEKANNT  bekannte Lecks, die auf eine Entscheidung warten → gelb.
 *   fremd    Drittanbieter, die auf keiner Liste stehen → gelb, damit ein
 *            neues Leck beim ersten Lauf auffällt statt nach Wochen.
 *
 * Brevo (Seiten-Tracking, E-Mail-Mitleser) und PayPal Payments sind seit
 * Consent 0.2.0 auf Nicht-Kaufseiten per Code abgeschaltet (class-fremd-haertung.php)
 * — tauchen sie dort wieder auf, ist das ein Alarm wie jeder andere Tracker (den
 * E-Mail-Mitleser erkennt der Check am HTML, er sendet erst bei einer Eingabe).
 * Die Abschaltung hängt an der Seite, nicht an der Einwilligung: taucht eins erst
 * nach einer Zustimmung auf, ist das in der jeweiligen Gegenprobe gelb.
 *
 * Danach „Ablehnen": kein Reload (ab Consent 0.2.0; vorher Reload = Hinweis),
 * Cookie gespeichert, und auch beim nächsten Seitenaufruf kein Tracker. Dann
 * die Gegenprobe auf einer neuen Seite mit „Ok": Seit Consent 0.2.0 lädt die
 * Seite dabei NICHT neu — in derselben Seitenansicht müssen der eigene Tracker
 * (session-init 2xx), GTM und GA4 anlaufen, und schon der erste GA4-Hit muss
 * die Zustimmung tragen (gcs=G111). Startet die Messung erst auf der nächsten
 * Seite, ist das gelb (die erste Seitenansicht fehlt); startet sie gar nicht,
 * rot — sonst schaltet das Gate nicht nur die Lecks ab, sondern die Messung.
 * Gelb ist auch, was doppelt startet (gtm.js, GA4-page_view, Meta-PageView,
 * session-init), ein falsches landing und ein „Ok", das nur programmatisch reagiert.
 *
 * Dann der Widerruf — der einzige Weg, auf dem consent.js noch neu lädt: „Ok",
 * danach „Datenschutz" → „Ablehnen". Erwartet: Event reload=true, neues Dokument,
 * danach kein Tracker. Kein Reload oder Tracker nach dem Reload ist rot, was die
 * sterbende Seite nach dem Klick noch sendet, gelb.
 *
 * Und eine Positivprobe im Warenkorb (/cart/, leer, nur lesend): Dort MUSS PayPal
 * laden — sonst ist die Härtung zu breit, und PayPal-Kunden können nicht zahlen.
 *
 * Zum Schluss die Teil-Einwilligungen (TEIL_PROFILE), je zweimal auf einer
 * gecachten Landingpage: als Wiederkehrer mit vorbelegtem Consent-Cookie und
 * als Erstbesucher, der die Kategorie im Banner wählt („Einstellungen" →
 * Schalter → „Auswahl speichern", ohne Reload — hier schalten die Gates in der
 * laufenden Seite frei). „Nur Statistik" darf GA4 und Site Kits Google-Tag
 * bekommen, aber weder GTM (Entscheidung E1) noch Ads oder Meta; „Nur Marketing"
 * darf GTM/Ads/Meta, aber keinen GA4-Hit und keinen eigenen Tracker. Genau
 * dazwischen lagen die Lecks, die „Ablehnen" und „Ok" nie sehen.
 *
 * Der Wächter selbst füttert niemanden: Die Senken von GA4, Ads und Meta
 * (collect-Endpunkte), Brevos Besucher-Tracking und PayPals FraudNet-/Statistik-
 * Beacons werden im Browser abgefangen. Der Request ist trotzdem im Protokoll —
 * man sieht, DASS gesendet worden wäre, ohne dass es ankommt. Der User-Agent
 * trägt „likoer24-watchdog" (lib/browser.mjs); der eigene Reichweitenzähler und
 * die Sessions filtern ihn heraus (Analytics ≥ 0.8.0).
 */

import { befund } from '../lib/kern.mjs';
import { browserStarten, seiteOeffnen, chromiumFinden, pause } from '../lib/browser.mjs';

export const name = 'Consent-Leck';

// ---- Listen -------------------------------------------------------------------
//
// hosts:       Hostname (Drittanbieter)          hostPfad: host + Pfad
// eigenePfade: Pfad + Query auf der eigenen Domain  cookies: Cookie-Name (egal welche Domain)
// cookieDomains: Cookies dieser Domains (Drittanbieter); ohne Angabe gelten die hosts.
// nurNichtKauf: gilt nicht auf Kaufseiten (KAUFSEITE)  hinweis: Zusatzzeile im Alarm (was prüfen?)

/** Tracker, die ohne Einwilligung NIE laden dürfen. Jeder Treffer ist ein Alarm. */
const FEHLER = [
  {
    id: 'gtm', titel: 'Google Tag Manager / gtag.js',
    hosts: [/(^|\.)googletagmanager\.com$/],
  },
  {
    id: 'ga', titel: 'Google Analytics',
    hosts: [/(^|\.)google-analytics\.com$/, /(^|\.)analytics\.google\.com$/],
    cookies: [/^_ga($|_)/, /^_gid$/, /^_gat($|_)/],
  },
  {
    id: 'ads', titel: 'Google Ads / DoubleClick',
    hosts: [/(^|\.)googleadservices\.com$/, /(^|\.)doubleclick\.net$/, /(^|\.)googlesyndication\.com$/],
    // Ads-/Remarketing-Pings direkt an google.<tld> (ccm/collect, pagead, rmkt, ga-audiences).
    hostPfad: [/^(www\.)?google\.[a-z.]+\/(ccm|pagead|rmkt|ads)\//],
    cookies: [/^_gcl_/],
  },
  {
    id: 'meta', titel: 'Meta-Pixel',
    hosts: [/(^|\.)connect\.facebook\.net$/],
    hostPfad: [/^(www\.)?facebook\.com\/tr\b/],
    cookies: [/^_fbp$/, /^_fbc$/],
    cookieDomains: [/(^|\.)facebook\.(com|net)$/],
  },
  {
    id: 'recaptcha', titel: 'Google reCAPTCHA',
    hostPfad: [/^(www\.)?gstatic\.com\/recaptcha\//, /^(www\.)?google\.com\/recaptcha\//, /^(www\.)?recaptcha\.net\//],
  },
  {
    id: 'sbjs', titel: 'WooCommerce-Bestellzuordnung (sbjs-Cookies)',
    cookies: [/^sbjs_/],
  },
  {
    id: 'tracker', titel: 'Eigener Tracker (lk24a)',
    cookies: [/^lk24a_(sid|vid)$/],
    // Die cookielosen Aggregat-Beacons (reach-hit, reach-consent, konfig-agg) sind für
    // alle erlaubt — Sessions und Events nicht.
    eigenePfade: [/likoer24-analytics\/v1\/(session-init|events?|funnel|vitals)\b/],
  },
  {
    id: 'andere', titel: 'Weitere Tracker (Bing, Clarity, TikTok, Pinterest, Hotjar, LinkedIn)',
    hosts: [/(^|\.)bat\.bing\.com$/, /(^|\.)clarity\.ms$/, /(^|\.)analytics\.tiktok\.com$/, /(^|\.)ct\.pinterest\.com$/,
      /(^|\.)hotjar\.(com|io)$/, /(^|\.)px\.ads\.linkedin\.com$/, /(^|\.)snap\.licdn\.com$/],
    cookies: [/^_uet(sid|vid)$/, /^_cl(ck|sk)$/, /^_ttp$/, /^_pin_unauth$/, /^_hj/],
  },
  {
    // Bis Consent 0.1.9 „bekannt" (gelb). Seit 0.2.0 per Code aus (class-fremd-haertung.php):
    // Seiten-Tracking + Warenkorbabbruch aus, Footer-Listener ausgehängt, Cookies geräumt.
    id: 'brevo', titel: 'Brevo-Tracking',
    hinweis: 'seit Consent 0.2.0 per Code abgeschaltet (class-fremd-haertung.php) — Kill-Switch-Filter an? Alte WPFC-Cache-Datei? Brevo-Plugin-Update?',
    // sdk-loader.js (cdn.brevo.com), sa.js (sibautomation.com), Besucher-Ping (in-automate.brevo.com).
    hosts: [/(^|\.)brevo\.com$/, /(^|\.)sibautomation\.com$/, /(^|\.)sendinblue\.com$/],
    // email_id: setzt das Plugin serverseitig mit der Klartext-Adresse (cart-events-manager.php).
    cookies: [/^sib_cuid$/, /^tracking_email$/, /^email_id$/],
    // Der E-Mail-Mitleser (Footer-Listener) sendet erst beim Verlassen eines E-Mail-Felds —
    // er fällt deshalb am HTML auf, nicht am Netzwerk (siehe JS_LAGE).
  },
  {
    // Bis Consent 0.1.9 „bekannt" (gelb). Seit 0.2.0 auf Nicht-Kaufseiten per Code aus
    // (class-fremd-haertung.php); Warenkorb, Kasse (inkl. order-pay/Danke-Seite) und
    // Konto → Zahlungsmethoden laden PayPal weiter.
    id: 'paypal', titel: 'PayPal Payments (SDK/FraudNet/Wallets) auf Nicht-Kaufseite',
    hinweis: 'seit Consent 0.2.0 außerhalb von Warenkorb, Kasse und Konto → Zahlungsmethoden per Code abgeschaltet (class-fremd-haertung.php) — Kill-Switch-Filter an? Neues Skript-Handle nach PayPal-Update? Alte WPFC-Cache-Datei?',
    nurNichtKauf: true,
    hosts: [/(^|\.)paypal\.com$/, /(^|\.)paypalobjects\.com$/, /(^|\.)applepay\.cdn-apple\.com$/],
    hostPfad: [/^pay\.google\.com\/gp\/p\/js\/pay\.js$/],
    // Die Plugin-Skripte selbst (ppcp-smart-button, ppcp-fraudnet, Apple/Google-Pay-Module) —
    // die laden das SDK ggf. erst später nach; Stylesheets zählen nicht.
    eigenePfade: [/\/wp-content\/plugins\/woocommerce-paypal-payments\/[^?#]*\.js(\?|$)/],
  },
].map((r) => ({ ...r, art: 'fehler' }));

/**
 * Kaufseiten: dort gehört PayPal hin (Regeln mit nurNichtKauf gelten dort nicht).
 * Genau die Freigabeliste der Härtung (paypal_seite_erlaubt() in class-fremd-haertung.php):
 * Warenkorb, Kasse samt Endpunkten (is_checkout(): order-pay, order-received), im Konto
 * NUR die Zahlungsmethoden-Endpunkte — Dashboard und Bestellungen nicht. Deutsche und
 * englische Slugs, weil der Live-Checkout /check-out/ heißt. Die German-Market-Prüfseite
 * (nur mit woocommerce_de_secondcheckout=on) hat keinen festen Slug: consentLeck.kaufSeitenExtra.
 */
const KAUFSEITE = new RegExp([
  '^/(cart|warenkorb|check-?out|kasse)(/|$)',
  '/order-pay/',
  '^/(my-account|mein-konto|konto|kundenkonto)/(payment-methods|add-payment-method|zahlungsmethoden|zahlungsarten'
    + '|zahlungsmethode-hinzufuegen|zahlungsart-hinzufuegen)(/|$)',
].join('|'), 'i');
/** Zusätzliche Kaufseiten aus der Konfiguration (Pfad-Präfixe) — run() setzt sie je Lauf. */
let kaufSeitenExtra = [];
const istKaufseite = (pfad) => {
  const p = String(pfad || '');
  return KAUFSEITE.test(p) || kaufSeitenExtra.some((x) => x && p.toLowerCase().startsWith(x.toLowerCase()));
};

/**
 * Bekannte Lecks — gelb statt rot, bis jemand entschieden hat.
 * Wartet auf Thomas im WP-Admin (bzw. beim jeweils genannten Schritt).
 *
 * art: 'bekannt'  gelb, solange es auftaucht
 *      'fehler'   nach dem Abstellen hierauf umstellen — ein Rückfall wird dann rot
 *      'erlaubt'  bewusst hingenommen (z. B. nach Entscheidung des DSB) — gar keine Meldung
 */
const BEKANNT = [
  // Brevo und PayPal standen bis Consent 0.1.9 hier (gelb) — seit 0.2.0 per Code
  // abgeschaltet und deshalb in FEHLER.
  {
    // 29.09.2026: vom DSB freigegeben (Thomas) — laedt bewusst ohne Einwilligung.
    id: 'trustedshops', art: 'erlaubt', titel: 'Trusted Shops',
    wer: 'vom DSB freigegeben (29.09.2026)',
    hosts: [/(^|\.)etrusted\.com$/, /(^|\.)trustedshops\.(com|de)$/],
  },
  {
    // Bis Konfigurator 1.0.221 „bekannt" (gelb): Schriften kamen für jeden Besucher von Google.
    // Seit 1.0.222 selbst gehostet (gleiche Binaries/@font-face, auch der Snapshot-Fetch), die
    // Datenschutzerklärung nennt Google Fonts nicht mehr (§ 2/7/25) — ein Rückfall ist ein Alarm.
    // seitenbasiert: hängt nicht an der Einwilligung — der Alarm steht beim Erstbesucher; die
    // Widerruf-Probe zählt die Regel nicht (lädt z. B. reCAPTCHA nach Einwilligung Schriften von
    // fonts.gstatic.com, deckt das § 20 — kein Rückfall).
    id: 'fonts', art: 'fehler', titel: 'Google Fonts', seitenbasiert: true,
    wer: 'seit Konfigurator 1.0.222 selbst gehostet',
    hinweis: 'seit Konfigurator 1.0.222 selbst gehostet (Handle lk24-fonts, fontEmbedCSS des Snapshots) — alte Plugin-Version oder WPFC-Cache-Datei auf dem Server? Neue Schrift/neues Template mit Google-URL? Solange es lädt, stimmt die Datenschutzerklärung (§ 7) nicht.',
    hosts: [/(^|\.)fonts\.googleapis\.com$/, /(^|\.)fonts\.gstatic\.com$/],
  },
];

/** Drittanbieter ohne Tracking, die vor der Einwilligung laden dürfen (Hostname-Muster). */
const ERLAUBT = [];

const REGELN = [...FEHLER, ...BEKANNT].filter((r) => r.art !== 'erlaubt');
const ERLAUBT_HOSTS = [
  ...ERLAUBT,
  ...BEKANNT.filter((r) => r.art === 'erlaubt').flatMap((r) => r.hosts || []),
];

/** Regeln für eine bestimmte Seite: auf Kaufseiten ist PayPal erlaubt (nurNichtKauf). */
function regelnFuer(pfad, regeln = REGELN) {
  return istKaufseite(pfad) ? regeln.map((r) => (r.nurNichtKauf ? { ...r, art: 'erlaubt' } : r)) : regeln;
}

/**
 * Teil-Einwilligungen: je Profil zwei Proben — als Wiederkehrer mit vorbelegtem
 * Consent-Cookie und als Erstbesucher, der die Kategorie im Banner wählt (ohne Reload,
 * die Gates schalten in der laufenden Seite frei). Je Profil die Regeln, die dort ALARM
 * sind — alles andere darf laden (die Kategorie ist ja erlaubt).
 * urls: ganze URL (für Query-Unterschiede wie gtag/js?id=AW- vs. ?id=GT-).
 */
const REGEL = Object.fromEntries(FEHLER.map((r) => [r.id, r]));

/**
 * Seitenbasiert abgeschaltet, nicht consent-abhängig: Brevo und PayPal dürfen auf
 * Nicht-Kaufseiten auch NACH einer Einwilligung nicht laden. In den Einwilligungs-Proben
 * („Ok", Teil-Einwilligungen) gelb — der Alarm steht schon beim Erstbesucher; so bleibt
 * auch eine Rückkehr sichtbar, die nur bei Einwilligern auftritt.
 */
const ABGESCHALTET = [REGEL.brevo, REGEL.paypal];

const TEIL_PROFILE = [
  {
    id: 'statistik', titel: '„Nur Statistik"', ohne: 'ohne Marketing-Einwilligung',
    kategorien: { statistics: true, marketing: false, external_media: false },
    // Erlaubt: Site Kits Google-Tag (gtag/js?id=GT-…), GA4-Hits mit gcs G101, eigener Tracker, sbjs.
    verboten: [
      { id: 'gtm', titel: 'GTM (E1: erst mit Marketing)', hostPfad: [/^(www\.)?googletagmanager\.com\/gtm\.js$/] },
      { id: 'ads-tag', titel: 'Google-Ads-Tag (gtag/js?id=AW-)', urls: [/^https?:\/\/(www\.)?googletagmanager\.com\/gtag\/js\?(?:[^#]*&)?id=AW-/i] },
      REGEL.ads,
      REGEL.meta,
    ],
  },
  {
    id: 'marketing', titel: '„Nur Marketing"', ohne: 'ohne Statistik-Einwilligung',
    kategorien: { statistics: false, marketing: true, external_media: false },
    // Erlaubt: GTM, Ads, Meta. Verboten: alles, was Statistik braucht — GA4 (auch über
    // den AW-gtag, der Site Kits vorgemerktes config GT-… abarbeitet), eigener Tracker, sbjs.
    verboten: [
      { id: 'ga4', titel: 'GA4-Hits', hosts: REGEL.ga.hosts, hostPfad: [/^[^/]+\/g\/collect$/], cookies: REGEL.ga.cookies },
      REGEL.tracker,
      REGEL.sbjs,
    ],
  },
];
// Fallback, falls die „Ok"-Gegenprobe keine Version liefert (CONSENT_VERSION im Consent-Plugin).
const CONSENT_VERSION_STANDARD = '2026-06-11-1';

/**
 * Senken, die der Wächter abfängt, damit seine Besuche nicht in GA4, Ads, Meta,
 * Brevo oder PayPal landen. Nur Messpunkte — Loader (gtm.js, gtag/js, fbevents.js,
 * Brevos sdk-loader.js/sa.js, PayPals sdk/js) laufen durch, sonst sähe man nicht,
 * was sie tun (und die Einordnung bliebe blind).
 * Chrome-Muster: * = beliebig viele Zeichen, ? = genau eins.
 */
const SENKEN = [
  // GTM-eigene Mess-/Diagnose-Pings (/a?…, /td?…); '?' steht im Chrome-Muster für genau ein Zeichen.
  '*://*googletagmanager.com/a?*',
  '*://*googletagmanager.com/td?*',
  '*://*google-analytics.com/*',
  '*://*analytics.google.com/*',
  '*://*doubleclick.net/*',
  '*://*googleadservices.com/*',
  '*://*googlesyndication.com/*',
  '*://*.google.*/ccm/*',
  '*://*.google.*/pagead/*',
  '*://*.google.*/rmkt/*',
  '*://*.google.*/ads/*',
  '*://*facebook.com/tr*',
  '*://bat.bing.com/*',
  '*://*.clarity.ms/*',
  '*://analytics.tiktok.com/*',
  '*://ct.pinterest.com/*',
  // Brevo: Seitenaufruf-/Automation-Ping (sonst landet jeder Konfigurator-Aufruf des
  // Wächters in Brevos Besucher-Tracking). sib_cuid setzt das Skript trotzdem — nur im
  // Wegwerf-Kontext, und so bleibt das Leck sichtbar.
  '*://in-automate.brevo.com/*',
  '*://in-automate.sendinblue.com/*',
  // PayPal: FraudNet-Datensammler (v1/r), Zähler und Client-Logger. Das FraudNet-Skript
  // selbst (c.paypal.com/da/r/…js) ist ein Loader und läuft durch.
  '*://c.paypal.com/v1/r*',
  '*://c6.paypal.com/v1/r*',
  '*://b.stats.paypal.com/*',
  '*://www.paypal.com/xoplatform/logger*',
  // Eigene Event-Senken: session-init läuft durch (Beweis, dass der Tracker nach „Ok"
  // startet; Sessions mit Wächter-UA verwirft der Server ab Analytics 0.8.0), Events,
  // Funnel und Vitals nicht — die würden sonst als Waisen-Zeilen in der Live-DB landen.
  '*/likoer24-analytics/v1/event*',
  '*/likoer24-analytics/v1/funnel*',
  '*/likoer24-analytics/v1/vitals*',
];

/** Teil-Einwilligungen: dort wird der eigene Tracker nicht ausgewertet — alles Eigene abfangen. */
const SENKEN_TEIL = [...SENKEN, '*/likoer24-analytics/v1/*'];

// ---- Einordnung ---------------------------------------------------------------

/** Registrierbare Domain, grob (reicht für eine Meldung „neuer Drittanbieter"). */
function domainVon(host) {
  const teile = host.split('.');
  if (teile.length <= 2) return host;
  const zweit = teile[teile.length - 2];
  const n = /^(co|com|org|net|gov|ac|edu)$/.test(zweit) && teile[teile.length - 1].length === 2 ? 3 : 2;
  return teile.slice(-n).join('.');
}

/** Pfad kürzen: zwei Segmente, IDs maskiert — für die Meldung, nicht zum Suchen. */
function kurzPfad(pfad) {
  const seg = pfad.split('/').filter(Boolean).slice(0, 2)
    .map((s) => (/[0-9a-f]{12,}|\d{6,}|^[A-Za-z0-9_-]{24,}$/i.test(s) ? '…' : s.slice(0, 32)));
  return '/' + seg.join('/');
}

function istErstePartei(host, siteHost) {
  return host === siteHost || host.endsWith('.' + siteHost);
}

/** Ziel für die Meldung; bei Google-Tag-Loadern mit Tag-ID (AW- vs. GT- ist der Unterschied). */
function zielText(u, host) {
  const id = /(^|\.)googletagmanager\.com$/.test(host) ? (u.searchParams.get('id') || '') : '';
  return host + kurzPfad(u.pathname) + (/^(AW|GT|G|GTM|DC)-[A-Z0-9]{4,20}$/i.test(id) ? `?id=${id}` : '');
}

/**
 * Request einordnen. Ohne weitere Argumente gegen FEHLER+BEKANNT, Unbekanntes als
 * „fremd". Für die Teil-Einwilligungen mit eigener Regelliste und ohne „fremd".
 */
function requestEinordnen(urlText, siteHost, regeln = REGELN, fremdMelden = true) {
  let u;
  try { u = new URL(urlText); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const eigen = istErstePartei(host, siteHost);
  const hostPfad = host + u.pathname;
  for (const r of regeln) {
    if (eigen) {
      const pq = u.pathname + u.search;
      if (r.eigenePfade?.some((re) => re.test(pq))) {
        // 'erlaubt' (PayPal auf einer Kaufseite): bekannt und in Ordnung — gar keine Meldung.
        if (r.art === 'erlaubt') return null;
        const m = pq.match(/likoer24-analytics\/v1\/[a-z-]+/);
        const plugin = u.pathname.match(/\/wp-content\/plugins\/([^/]+)\/(?:.*\/)?([^/]+)$/);
        return { regel: r, ziel: m ? '/' + m[0] : plugin ? `Plugin ${plugin[1]}: ${plugin[2].slice(0, 48)}` : u.pathname };
      }
      continue;
    }
    if (r.urls?.some((re) => re.test(urlText)) || r.hosts?.some((re) => re.test(host)) || r.hostPfad?.some((re) => re.test(hostPfad))) {
      if (r.art === 'erlaubt') return null;
      return { regel: r, ziel: zielText(u, host) };
    }
  }
  if (!fremdMelden || eigen || ERLAUBT_HOSTS.some((re) => re.test(host))) return null;
  return { fremd: domainVon(host), ziel: host + kurzPfad(u.pathname) };
}

function cookieEinordnen(nameC, domain, siteHost, regeln = REGELN, fremdMelden = true) {
  const dom = String(domain || siteHost).replace(/^\./, '').toLowerCase();
  const eigen = istErstePartei(dom, siteHost);
  const kurz = nameC.length > 24 ? nameC.slice(0, 12) + '…' : nameC;
  for (const r of regeln) {
    if (r.cookies?.some((re) => re.test(nameC))) {
      if (r.art === 'erlaubt') return null;
      // _ga_<Mess-ID> & Co. zusammenfassen: gleiche Art, gleicher Befund.
      return { regel: r, ziel: 'Cookie ' + nameC.replace(/_[A-Z0-9]{6,}$/, '_*') + (eigen ? '' : ` (${dom})`) };
    }
    if (!eigen && (r.cookieDomains || r.hosts || []).some((re) => re.test(dom))) {
      if (r.art === 'erlaubt') return null;
      return { regel: r, ziel: `Cookie ${kurz} (${dom})` };
    }
  }
  if (!fremdMelden || eigen || ERLAUBT_HOSTS.some((re) => re.test(dom))) return null;
  return { fremd: domainVon(dom), ziel: `Cookie ${kurz} (${dom})` };
}

// ---- Browser-Handgriffe -------------------------------------------------------

const BINDUNG = '__lk24wdCookie';

// Jeder Cookie-Schreibvorgang aus JavaScript wird gemeldet — auch einer, der gleich
// wieder gelöscht wird. Ein Tracker-Cookie, das 50 ms lebt, ist trotzdem gesetzt.
// Löschungen (leerer Wert, Max-Age <= 0, Ablauf in der Vergangenheit) zählen nicht.
const COOKIE_HAKEN = `(function () {
  try {
    var d = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (!d || !d.set || !d.get) return;
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true, enumerable: d.enumerable,
      get: function () { return d.get.call(this); },
      set: function (v) {
        try {
          var s = String(v), i = s.indexOf('=');
          var name = (i > 0 ? s.slice(0, i) : s).trim();
          var wert = i > 0 ? s.slice(i + 1).split(';')[0].trim() : '';
          var ma = /;\\s*max-age\\s*=\\s*(-?\\d+)/i.exec(s);
          var ex = /;\\s*expires\\s*=\\s*([^;]+)/i.exec(s);
          var weg = wert === '' || (ma && Number(ma[1]) <= 0) || (ex && Date.parse(ex[1]) < Date.now());
          if (name && !weg && typeof window.${BINDUNG} === 'function') window.${BINDUNG}(name.slice(0, 80));
        } catch (e) {}
        return d.set.call(this, v);
      }
    });
  } catch (e) {}
})();`;

// consent.js meldet jede Entscheidung als 'likoer24-consent-updated'; detail.reload sagt
// verbindlich, ob die Seite gleich neu lädt (ab Consent 0.2.0 / Welle N). Darauf verlassen
// sich die Gates (GA4, Ads, GTM, Meta, Tracker) — also mitschreiben und gegen das prüfen,
// was wirklich passiert. reload fehlt (null) = alte consent.js 0.1.9.
const EVENT_BINDUNG = '__lk24wdConsent';
const EVENT_HAKEN = `(function () {
  try {
    window.addEventListener('likoer24-consent-updated', function (e) {
      try {
        var d = (e && e.detail) || {};
        if (typeof window.${EVENT_BINDUNG} !== 'function') return;
        window.${EVENT_BINDUNG}(JSON.stringify({
          reload: Object.prototype.hasOwnProperty.call(d, 'reload') ? d.reload : null,
          via: String(d.via || ''), source: String(d.source || ''), kat: d.categories || null
        }));
      } catch (x) {}
    });
  } catch (e) {}
})();`;

// Was im HTML steht (nicht im Netzwerk): Banner, GTM-noscript, Brevos E-Mail-Mitleser
// (Footer-Listener, schreibt tracking_email und schickt die Adresse per admin-ajax, sobald
// jemand ein E-Mail-Feld verlässt — ohne Eingabe gibt es keinen Request, deshalb am HTML),
// Brevo-Init und ob die Meta-Brücke eingebunden ist.
const JS_LAGE = `(function () {
  var inline = Array.prototype.filter.call(document.scripts, function (s) { return !s.src; })
    .map(function (s) { return s.textContent || ''; });
  var brevo = [];
  // Brevos Listener: schreibt tracking_email und meldet per admin-ajax (action=the_ajax_hook) —
  // beides zusammen, damit ein Aufräum-Skript, das den Cookie nur nennt, nicht zählt.
  if (inline.some(function (t) { return /tracking_email/.test(t) && /the_ajax_hook|addEventListener\\(\\s*["']blur/.test(t); })) brevo.push('E-Mail-Mitleser im HTML (tracking_email-Listener)');
  if (inline.some(function (t) { return /window\\.Brevo\\b[\\s\\S]{0,80}\\binit\\b/.test(t); })) brevo.push('Brevo-Init im HTML (window.Brevo)');
  return {
    banner: !!document.querySelector('.lk24-consent'),
    noscriptGtm: Array.prototype.some.call(document.querySelectorAll('noscript'), function (n) { return /googletagmanager\\.com\\/ns\\.html/.test(n.textContent || n.innerHTML || ''); }),
    brevo: brevo,
    metaBridge: !!document.getElementById('lk24a-meta-bridge-js'),
    // Google-Ads-Loader (class-google-ads.php, Inline-Skript mit Consent-Gate)
    adsGate: !!document.getElementById('lk24a-gads'),
    // Inline-Gates von Analytics < 0.8.0 (ohne Listener) — dieselbe Prüfung wie consent.js
    // legacyGates(): Stehen sie im HTML (alter WPFC-Cache), lädt consent.js nach „Ok" absichtlich neu.
    altGates: ['lk24a-ga4-gate', 'lk24a-gads', 'lk24a-gtm'].filter(function (id) {
      var el = document.getElementById(id);
      return !!el && String(el.textContent || '').indexOf('likoer24-consent-updated') === -1;
    })
  };
})()`;

async function lageLesen(seite) {
  try { return (await seite.eval(JS_LAGE)) || null; } catch { /* unten: wenigstens das Banner */ }
  // Hält JS_LAGE nicht (Seite lädt gerade um, Skriptfehler), soll daraus kein falsches
  // „Banner öffnet sich nicht" werden — die Banner-Frage allein ist trivial.
  try { return { banner: !!(await seite.eval(`!!document.querySelector('.lk24-consent')`)), noscriptGtm: false, brevo: [], metaBridge: false, adsGate: false, altGates: [] }; } catch { return null; }
}

/**
 * Warum lud die Seite nach einer Zustimmung neu? Seit Consent 0.2.0 nur noch bei alten
 * Inline-Gates (consent.js legacyGates(): WPFC-Cache von vor Analytics 0.8.0, falsche
 * Deploy-Reihenfolge, Rollback) oder auf reloadOnGrant-Seiten (Danke-Seite) — oder weil
 * noch die alte consent.js ausgeliefert wird (Event ohne reload).
 */
function reloadGrund(lage, event) {
  // Zuerst consent.js: 0.1.9 lädt nach JEDER Entscheidung neu, egal welche Gates.
  if (event && event.reload === null) return 'es wird noch die alte consent.js (vor 0.2.0) ausgeliefert — Upload nach httpdocs/…? Server-Cache?';
  if (lage?.altGates?.length) return `die Seite trägt noch alte Inline-Gates ohne Listener (${lage.altGates.join(', ')}) — WPFC-Cache von vor Analytics 0.8.0? Cache der Seite leeren`;
  return 'seit Consent 0.2.0 nur noch beim Widerruf, bei alten Inline-Gates oder auf reloadOnGrant-Seiten (Danke-Seite) vorgesehen';
}

// Knopf im Consent-Banner suchen, in den sichtbaren Bereich holen und prüfen, ob ein
// Tipp dort ankommt (elementFromPoint). Muster auf den Knopftext — oder, mit sel, ein
// Element außerhalb des Banners (der „Datenschutz"-Knopf zum Widerruf).
const JS_KNOPF = `(function (muster, sel) {
  var el;
  if (sel) {
    el = document.querySelector(sel);
  } else {
    var re = new RegExp(muster, 'i');
    var dlg = document.querySelector('.lk24-consent');
    if (!dlg) return { ok: false, grund: 'kein Banner offen' };
    el = Array.prototype.slice.call(dlg.querySelectorAll('button')).find(function (b) {
      return re.test((b.textContent || '').replace(/\\s+/g, ' ').trim());
    });
  }
  if (!el) return { ok: false, grund: 'Knopf fehlt' };
  try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch (e) {}
  var r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return { ok: false, grund: 'Knopf unsichtbar' };
  var x = r.left + r.width / 2, y = r.top + r.height / 2;
  var hit = document.elementFromPoint(x, y);
  var frei = !!hit && (hit === el || el.contains(hit));
  return { ok: true, x: x, y: y, frei: frei,
    verdeckt: frei ? '' : (hit ? hit.tagName.toLowerCase() + (hit.className ? '.' + String(hit.className).split(' ')[0] : '') : 'nichts') };
})`;

const JS_KNOPF_JS = `(function (muster, sel) {
  var el;
  if (sel) {
    el = document.querySelector(sel);
  } else {
    var re = new RegExp(muster, 'i');
    var dlg = document.querySelector('.lk24-consent');
    el = dlg && Array.prototype.slice.call(dlg.querySelectorAll('button')).find(function (b) {
      return re.test((b.textContent || '').replace(/\\s+/g, ' ').trim());
    });
  }
  if (!el) return false; el.click(); return true;
})`;

const KNOPF_ABLEHNEN = '^Ablehnen$';
const KNOPF_OK = '^(Ok|Okay|Alle akzeptieren|Akzeptieren)$';
const KNOPF_EINSTELLUNGEN = '^Einstellungen$';
const KNOPF_SPEICHERN = '^Auswahl speichern$';
// „Datenschutz"-Knopf (consent.js buildReopenButton, mobil ein Schloss-Icon) — öffnet den Dialog zum Widerruf.
const OEFFNER = '.lk24-consent-open';
const CONSENT_COOKIE = 'lk24_consent';
// Erledigt-Bedingung für „Ablehnen" nach einer Zustimmung: das Cookie steht auf „alles aus"
// (das Cookie allein reicht hier nicht — es ist seit dem „Ok" schon da).
const JS_ALLES_AUS = `(function () {
  var m = document.cookie.match(/(?:^|;\\s*)${CONSENT_COOKIE}=([^;]*)/);
  if (!m) return false;
  try {
    var c = (JSON.parse(decodeURIComponent(m[1])) || {}).categories || {};
    return !c.statistics && !c.marketing && !c.external_media;
  } catch (e) { return false; }
})()`;

// Schalter einer Kategorie in Ebene 2 des Banners: Zustand und Tippziel (das Label —
// ein Tipp irgendwo darauf schaltet die Checkbox um).
const JS_SCHALTER = `(function (name) {
  var dlg = document.querySelector('.lk24-consent');
  if (!dlg) return { ok: false, grund: 'kein Banner offen' };
  var input = dlg.querySelector('input[type="checkbox"][name="' + name + '"]');
  if (!input) return { ok: false, grund: 'Schalter fehlt' };
  if (input.disabled) return { ok: false, grund: 'Schalter gesperrt' };
  var el = input.closest('label') || input;
  try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch (e) {}
  var r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return { ok: false, grund: 'Schalter unsichtbar', an: input.checked };
  var x = r.left + Math.min(24, r.width / 2), y = r.top + r.height / 2;
  var hit = document.elementFromPoint(x, y);
  var frei = !!hit && (hit === el || el.contains(hit));
  return { ok: true, an: input.checked, x: x, y: y, frei: frei,
    verdeckt: frei ? '' : (hit ? hit.tagName.toLowerCase() + (hit.className ? '.' + String(hit.className).split(' ')[0] : '') : 'nichts') };
})`;

class Abgebrochen extends Error {}

function mitZeitlimit(p, ms, was, abbruch) {
  let wecker;
  const limit = new Promise((_, rej) => {
    wecker = setTimeout(() => { abbruch.jetzt = true; rej(new Error(`${was}: Zeitlimit von ${Math.round(ms / 1000)} s überschritten`)); }, ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(wecker));
}

/**
 * Eine Seite in einem frischen Browser-Kontext (eigene Cookies, eigener Speicher,
 * leerer Cache) — wie ein Erstbesucher. Liefert Seite + Protokoll.
 */
async function frischeSeite(browser, geraet, opt) {
  const { browserContextId } = await browser.send('Target.createBrowserContext', {});
  // seiteOeffnen() legt den Tab per Target.createTarget an — hier im eigenen Kontext.
  const imKontext = {
    ...browser,
    send: (m, p, sid, t) => browser.send(m, m === 'Target.createTarget' ? { ...p, browserContextId } : p, sid, t),
  };
  let seite;
  try {
    seite = await seiteOeffnen(imKontext, { mobil: geraet.mobil, width: geraet.breite, height: geraet.hoehe });
  } catch (e) {
    await browser.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    throw e;
  }

  const prot = {
    phase: 'vor',
    // Dokument-Zähler des Tabs: steigt, sobald im Hauptframe ein neues Dokument übernimmt
    // (Runtime.executionContextsCleared). Danach läuft kein Skript der alten Seite mehr —
    // so trennt der Widerruf sauber, was die sterbende Seite noch tat und was die neue.
    dok: 0,
    letzte: Date.now(),
    requests: [],        // { url, phase, dok, typ, id, sid, frame, t, post }
    antworten: new Map(), // requestId → HTTP-Status
    verworfen: new Set(), // requestId: Server hat still verworfen (X-LK24A-Drop, Analytics ≥ 0.8.0)
    abgefangen: new Set(),
    cookieSchreiber: [], // { name, phase, dok }
    events: [],          // 'likoer24-consent-updated': { reload, via, source, kat, phase, dok, t }
    sessions: new Set([seite.sessionId]),
    hauptFrame: seite.targetId,
  };
  const ab = [];
  const meins = (sid) => prot.sessions.has(sid);
  const senkMuster = (opt.senken || SENKEN).map((u) => ({ urlPattern: u, requestStage: 'Request' }));

  ab.push(browser.on('Network.requestWillBeSent', (p, sid) => {
    if (!meins(sid)) return;
    prot.letzte = Date.now();
    const url = p.request?.url || '';
    // Rumpf nur, wo er gezählt wird: eigener Tracker (session-init: Landing; events: page_view),
    // Meta (POST id=…&ev=PageView) und GA4 (gebündelte Events, je Zeile en=…).
    const post = /likoer24-analytics\/v1\/(session-init|events?)\b/.test(url) ? String(p.request?.postData || '').slice(0, 20000)
      : (RE_META_TR.test(url) || RE_GA_HIT.test(url)) ? String(p.request?.postData || '').slice(0, 4000) : undefined;
    prot.requests.push({ url, phase: prot.phase, dok: prot.dok, typ: p.type || '', id: p.requestId, sid, frame: p.frameId, t: Date.now(), post });
  }));
  ab.push(browser.on('Runtime.executionContextsCleared', (p, sid) => {
    if (sid === seite.sessionId) prot.dok++;
  }));
  ab.push(browser.on('Network.responseReceived', (p, sid) => {
    if (!meins(sid)) return;
    prot.antworten.set(p.requestId, p.response?.status ?? 0);
    if (Object.keys(p.response?.headers || {}).some((k) => k.toLowerCase() === 'x-lk24a-drop')) prot.verworfen.add(p.requestId);
  }));
  ab.push(browser.on('Fetch.requestPaused', (p, sid) => {
    if (!meins(sid)) return;
    if (p.networkId) prot.abgefangen.add(p.networkId);
    browser.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sid).catch(() => {});
  }));
  ab.push(browser.on('Runtime.bindingCalled', (p, sid) => {
    if (!meins(sid)) return;
    if (p.name === BINDUNG) prot.cookieSchreiber.push({ name: String(p.payload || ''), phase: prot.phase, dok: prot.dok });
    else if (p.name === EVENT_BINDUNG) {
      let e = null;
      try { e = JSON.parse(String(p.payload || '')); } catch { /* kaputt = ignorieren */ }
      if (e && typeof e === 'object') prot.events.push({ ...e, phase: prot.phase, dok: prot.dok, t: Date.now() });
    }
  }));
  // Iframes und Worker (PayPal-Buttons, Widgets) laufen in eigenen Zielen — auch deren
  // Verkehr gehört ins Protokoll. Sie warten beim Start, bis das Netzwerk mitschreibt.
  ab.push(browser.on('Target.attachedToTarget', async (p, sid) => {
    if (!meins(sid)) return;
    const kind = p.sessionId;
    prot.sessions.add(kind);
    try {
      await browser.send('Network.enable', {}, kind, 5000);
      if (opt.sperren) await browser.send('Fetch.enable', { patterns: senkMuster }, kind, 5000).catch(() => {});
      await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, kind, 5000).catch(() => {});
    } catch { /* Ziel war schon wieder weg */ }
    finally {
      browser.send('Runtime.runIfWaitingForDebugger', {}, kind, 5000).catch(() => {});
    }
  }));

  await seite.send('Runtime.addBinding', { name: BINDUNG });
  await seite.send('Runtime.addBinding', { name: EVENT_BINDUNG });
  await seite.send('Page.addScriptToEvaluateOnNewDocument', { source: COOKIE_HAKEN });
  await seite.send('Page.addScriptToEvaluateOnNewDocument', { source: EVENT_HAKEN });
  if (opt.sperren) await seite.send('Fetch.enable', { patterns: senkMuster });
  await seite.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  try {
    const { frameTree } = await seite.send('Page.getFrameTree');
    if (frameTree?.frame?.id) prot.hauptFrame = frameTree.frame.id;
  } catch { /* targetId reicht */ }

  return {
    seite, prot,
    /** Cookies dieses Kontexts (alle Domains). */
    async cookies() {
      const r = await browser.send('Storage.getCookies', { browserContextId });
      return r.cookies || [];
    },
    /** Hauptdokument-Anfragen bisher — steigt die Zahl, lädt die Seite neu. */
    dokumente() {
      return prot.requests.filter((q) => q.typ === 'Document' && q.sid === seite.sessionId && q.frame === prot.hauptFrame).length;
    },
    async schliessen() {
      for (const f of ab) { try { f(); } catch { /* egal */ } }
      await seite.schliessen().catch(() => {});
      await browser.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    },
  };
}

/** Warten, bis das Netz ruhig wird: mindestens min, dann stille ms ohne neuen Request, höchstens max. */
async function ruhe(prot, { min, stille, max }, abbruch) {
  const start = Date.now();
  for (;;) {
    if (abbruch.jetzt) throw new Abgebrochen('abgebrochen');
    const jetzt = Date.now();
    if (jetzt - start >= max) return;
    if (jetzt - start >= min && jetzt - prot.letzte >= stille) return;
    await pause(250);
  }
}

/** Ein bisschen „Mensch": Mausrad. Manche Loader warten auf die erste Interaktion. */
async function anstupsen(seite) {
  try {
    await seite.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: seite.width / 2, y: seite.height / 3 });
    await seite.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: seite.width / 2, y: seite.height / 3, deltaX: 0, deltaY: 400 });
  } catch { /* egal */ }
}

function consentAusCookies(cookies) {
  const c = cookies.find((k) => k.name === CONSENT_COOKIE);
  if (!c) return null;
  try { return JSON.parse(decodeURIComponent(c.value)); } catch { return { kaputt: true }; }
}

/**
 * Knopf im Banner drücken wie ein Mensch: Fingertipp (Handy) bzw. Mausklick, zuletzt
 * programmatisch. Erledigt = Consent-Cookie geschrieben oder Neuladen begonnen — oder,
 * mit fertig (JS-Ausdruck), sobald der in der Seite wahr wird (z. B. Ebene 2 offen).
 * sel: statt Knopftext im Banner ein Element per CSS-Selektor (z. B. OEFFNER).
 * weg 'js' heißt: für Menschen tot (verdeckt oder ohne Reaktion auf Tipp/Klick).
 */
async function knopfDruecken(fs, muster, mobil, fertig = '', sel = '') {
  const args = `(${JSON.stringify(muster)}, ${JSON.stringify(sel)})`;
  const k = await fs.seite.eval(`${JS_KNOPF}${args}`);
  if (!k?.ok) return { weg: null, grund: k?.grund || 'nicht auswertbar' };
  const docsVorher = fs.dokumente();
  const erledigt = async () => {
    const ende = Date.now() + 2000;
    while (Date.now() < ende) {
      if (fs.dokumente() > docsVorher) return true;
      try {
        if (fertig ? await fs.seite.eval(fertig) : consentAusCookies(await fs.cookies())) return true;
      } catch { /* weiter */ }
      await pause(150);
    }
    return false;
  };
  const wege = mobil ? ['tipp', 'klick', 'js'] : ['klick', 'js'];
  for (const weg of wege) {
    if (weg !== 'js' && !k.frei) continue;
    try {
      if (weg === 'tipp') await fs.seite.tippen(k.x, k.y);
      else if (weg === 'klick') await fs.seite.klicken(k.x, k.y);
      else await fs.seite.eval(`${JS_KNOPF_JS}${args}`);
    } catch { /* Seite lädt womöglich schon neu */ }
    if (await erledigt()) return { weg, verdeckt: k.frei ? '' : k.verdeckt };
  }
  return { weg: null, grund: k.frei ? 'keine Reaktion' : `verdeckt von ${k.verdeckt}` };
}

/** Wegtext für die Details: Tipp/Klick oder „nur programmatisch (verdeckt von …)". */
function wegText(w, verdeckt = '') {
  if (!w) return 'ohne Wirkung';
  return { tipp: 'Tipp', klick: 'Klick', schon: 'schon so', js: `nur programmatisch${verdeckt ? ` (verdeckt von ${verdeckt})` : ''}` }[w] || w;
}

/**
 * Schalter einer Kategorie in Ebene 2 auf wert stellen — per Tipp/Klick aufs Label,
 * zuletzt programmatisch. Liefert den Weg (oder null + Grund).
 */
async function schalterSetzen(fs, name, wert, mobil) {
  const lesen = () => fs.seite.eval(`${JS_SCHALTER}(${JSON.stringify(name)})`).catch(() => null);
  let k = await lesen();
  if (!k?.ok) return { weg: null, grund: k?.grund || 'nicht auswertbar' };
  if (k.an === wert) return { weg: 'schon' };
  const verdeckt = k.frei ? '' : (k.verdeckt || 'unbekannt');
  const wege = mobil ? ['tipp', 'klick', 'js'] : ['klick', 'js'];
  for (const weg of wege) {
    if (weg !== 'js' && !k.frei) continue;
    try {
      if (weg === 'tipp') await fs.seite.tippen(k.x, k.y);
      else if (weg === 'klick') await fs.seite.klicken(k.x, k.y);
      else await fs.seite.eval(`(function (n) { var i = document.querySelector('.lk24-consent input[type="checkbox"][name="' + n + '"]'); if (i) i.click(); })(${JSON.stringify(name)})`);
    } catch { /* weiter */ }
    await pause(200);
    k = await lesen();
    if (k?.ok && k.an === wert) return { weg, verdeckt };
    if (!k?.ok) break;
  }
  return { weg: null, grund: verdeckt ? `verdeckt von ${verdeckt}` : 'keine Reaktion' };
}

/** Nach einem Knopfdruck: lädt die Seite neu? Wenn ja, bis zum load-Ereignis warten. */
async function neuladenAbwarten(browser, fs, docsVorher, ladeWarter) {
  const ende = Date.now() + 2500;
  while (Date.now() < ende && fs.dokumente() <= docsVorher) await pause(100);
  if (fs.dokumente() <= docsVorher) { ladeWarter.abbrechen(); return false; }
  try { await ladeWarter; } catch { /* dann eben ohne load-Ereignis */ }
  await pause(300);
  return true;
}

// ---- Abläufe -----------------------------------------------------------------

const RUHE_VOR = { min: 5000, stille: 2000, max: 12000 };
const RUHE_NACH = { min: 3500, stille: 1500, max: 9000 };

/**
 * Eine Seite als Erstbesucher: laden, protokollieren, „Ablehnen", beobachten,
 * und — falls consent.js nicht selbst neu lädt — einmal frisch nachladen.
 */
async function seitePruefen(browser, geraet, url, opt, abbruch) {
  const fs = await frischeSeite(browser, geraet, opt);
  const { seite, prot } = fs;
  const erg = { geraet: geraet.name, pfad: new URL(url).pathname, banner: false, noscriptGtm: false, cookiesJe: {}, htmlJe: {}, ablehnen: null };
  try {
    await seite.oeffnen(url, 45000);
    await anstupsen(seite);
    await ruhe(prot, RUHE_VOR, abbruch);
    const lage = (await lageLesen(seite)) || {};
    erg.banner = !!lage.banner;
    erg.noscriptGtm = !!lage.noscriptGtm;
    erg.htmlJe.vor = lage.brevo || [];
    erg.cookiesJe.vor = await fs.cookies();

    if (!erg.banner) return { erg, prot };

    // ---- Ablehnen -------------------------------------------------------------
    const docsVorher = fs.dokumente();
    const ladeWarter = browser.warteAuf('Page.loadEventFired', seite.sessionId, 40000);
    prot.phase = 'ablehnen';
    const druck = await knopfDruecken(fs, KNOPF_ABLEHNEN, geraet.mobil);
    const ab = { weg: druck.weg, grund: druck.grund || '', verdeckt: druck.verdeckt || '', reload: false, bannerZu: null, consent: null };
    erg.ablehnen = ab;
    if (!druck.weg) { ladeWarter.abbrechen(); return { erg, prot }; }

    ab.reload = await neuladenAbwarten(browser, fs, docsVorher, ladeWarter);
    await ruhe(prot, RUHE_NACH, abbruch);
    ab.bannerZu = await seite.eval(`!document.querySelector('.lk24-consent')`).catch(() => null);
    erg.cookiesJe.ablehnen = await fs.cookies();
    ab.consent = consentAusCookies(erg.cookiesJe.ablehnen);

    // Ohne eigenes Neuladen: der nächste Seitenaufruf eines Ablehners (Normalfall für
    // jeden dritten Besucher) muss genauso sauber sein.
    if (!ab.reload) {
      prot.phase = 'abgelehnt';
      await seite.oeffnen(url, 45000);
      await anstupsen(seite);
      await ruhe(prot, RUHE_NACH, abbruch);
      ab.bannerNachLaden = await seite.eval(`!!document.querySelector('.lk24-consent')`).catch(() => null);
      erg.cookiesJe.abgelehnt = await fs.cookies();
    }
    return { erg, prot };
  } finally {
    await fs.schliessen();
  }
}

const ok2xx = (st) => st >= 200 && st < 300;
const RE_INIT = /likoer24-analytics\/v1\/session-init\b/;
const RE_EVENTS = /likoer24-analytics\/v1\/events?\b/;
const RE_GTM = /^https?:\/\/(www\.)?googletagmanager\.com\/gtm\.js\b/;
const RE_GA_TAG = /^https?:\/\/(www\.)?googletagmanager\.com\/gtag\/js\?(?:[^#]*&)?id=(GT|G)-/i;
const RE_ADS_TAG = /^https?:\/\/(www\.)?googletagmanager\.com\/gtag\/js\?(?:[^#]*&)?id=AW-/i;
// GA4-Hits: region1.google-analytics.com, analytics.google.com, stats.g.doubleclick.net (Signals).
const RE_GA_HIT = /^https?:\/\/[^/]*(google-analytics\.com|analytics\.google\.com|doubleclick\.net)\/g\/collect\b/;
const RE_META = /connect\.facebook\.net\/.+\/fbevents\.js/;
const RE_META_TR = /^https?:\/\/(www\.)?facebook\.com\/tr\b/;

/** Parameter aus URL oder (urlencodiertem) Rumpf — Meta schickt ev/id per POST, GA4 bündelt en= je Zeile. */
function paramAus(q, name) {
  try { const v = new URL(q.url).searchParams.get(name); if (v) return v; } catch { /* weiter im Rumpf */ }
  const m = String(q.post || '').match(new RegExp(`(?:^|[&\\n])${name}=([^&\\n]*)`));
  if (!m) return '';
  try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { return m[1]; }
}

/** GA4-page_view-Hits in einem Request: en in der URL oder je Zeile im gebündelten Rumpf. */
function gaPageViews(q) {
  try { if (new URL(q.url).searchParams.get('en') === 'page_view') return 1; } catch { return 0; }
  return String(q.post || '').split('\n').filter((z) => /(^|&)en=page_view(&|$)/.test(z)).length;
}

/** Zählung → „name 2×"-Texte für alles, was öfter als einmal lief. */
function mehrfach(zahl, fmt) {
  return Object.entries(zahl).filter(([, n]) => n > 1).map(([k, n]) => fmt(k, n));
}

/**
 * Was lief in diesen Requests? Tracker (session-init, page_view aus den Event-Rümpfen),
 * GTM, Google-Tag (GT-/G-), Ads-Tag (AW-), GA4-Hits samt gcs des ERSTEN Hits, Meta.
 * Dazu doppelt Gestartetes (N2-Guard): gtm.js je Container, GA4-page_view je Property,
 * Meta-PageView je Pixel, session-init mit 2xx. gtag/js NICHT — das lädt legitim zweimal
 * (der AW-Tag holt den GT-Tag nach und umgekehrt).
 * reqs: Ausschnitt aus prot.requests (eine Seitenansicht), zeitlich sortiert.
 */
function messungAus(reqs, prot) {
  const status = (q) => prot.antworten?.get(q.id);
  const ab = (q) => !!prot.abgefangen?.has(q.id);
  const init = reqs.filter((q) => RE_INIT.test(q.url));
  const tracker = reqs.filter((q) => RE_INIT.test(q.url) || RE_EVENTS.test(q.url))
    .map((q) => ({ pfad: (q.url.match(/v1\/([a-z-]+)/) || [])[1] || '?', status: status(q) ?? null, abgefangen: ab(q), verworfen: !!prot.verworfen?.has(q.id) }));
  // page_view: je Ereignis einmal zählen — ein abgefangener Batch wird vom Tracker erneut gesendet.
  const pv = new Set();
  let eventsLesbar = 0;
  for (const q of reqs) {
    if (!RE_EVENTS.test(q.url) || !q.post) continue;
    try {
      const batch = JSON.parse(q.post).batch;
      if (!Array.isArray(batch)) continue;
      eventsLesbar++;
      for (const e of batch) if (e && e.type === 'page_view') pv.add(`${e.ts}|${e.page_url}`);
    } catch { /* Rumpf abgeschnitten */ }
  }
  let landing = '';
  for (const q of init) { try { landing = landing || String(JSON.parse(q.post || '{}').landing || ''); } catch { /* egal */ } }
  const gaHits = reqs.filter((q) => RE_GA_HIT.test(q.url));
  const gcsListe = gaHits.map((q) => gcsVon(q.url));

  // Doppelt gestartet? Je Ziel zählen (zwei verschiedene Container/Properties sind kein Doppel).
  const zahl = (liste, key) => liste.reduce((z, q) => { const k = key(q); if (k) z[k] = (z[k] || 0) + 1; return z; }, {});
  const gtmJe = zahl(reqs.filter((q) => RE_GTM.test(q.url)), (q) => paramAus(q, 'id') || '?');
  const gaPvJe = {};
  for (const q of gaHits) { const n = gaPageViews(q); if (n) { const k = paramAus(q, 'tid') || '?'; gaPvJe[k] = (gaPvJe[k] || 0) + n; } }
  const metaPvJe = zahl(reqs.filter((q) => RE_META_TR.test(q.url) && paramAus(q, 'ev') === 'PageView'), (q) => paramAus(q, 'id') || '?');
  // fbevents.js lädt die Meta-Brücke genau einmal (Snippet-Guard „if (f.fbq) return") —
  // ein zweiter Ladevorgang heißt: ein zweites Pixel-Snippet (GTM, Fremd-Plugin).
  const fbevents = reqs.filter((q) => RE_META.test(q.url)).length;
  // session-init: nur beantwortete zählen — ein abgefangener/gescheiterter darf wiederholt werden.
  const initOk = init.filter((q) => ok2xx(status(q))).length;
  const doppelt = [
    ...mehrfach(gtmJe, (k, n) => `gtm.js ${k} ${n}×`),
    ...mehrfach(gaPvJe, (k, n) => `GA4-page_view ${k} ${n}×`),
    ...(fbevents > 1 ? [`fbevents.js ${fbevents}×`] : []),
    ...mehrfach(metaPvJe, (k, n) => `Meta-PageView ${k} ${n}×`),
    ...(initOk > 1 ? [`session-init ${initOk}×`] : []),
  ];
  return {
    trackerOk: init.some((q) => ok2xx(status(q))) || tracker.some((t) => t.pfad !== 'session-init' && ok2xx(t.status)),
    // Echte Fehlantworten (403, 500 …) — abgefangene und nicht gesehene Antworten zählen nicht.
    trackerKaputt: tracker.filter((t) => !t.abgefangen && t.status !== null && !ok2xx(t.status)),
    trackerGesendet: init.length > 0,
    tracker,
    pageViews: pv.size,
    eventsLesbar,
    landing,
    gtm: reqs.filter((q) => RE_GTM.test(q.url)).map((q) => status(q) ?? null),
    gtmOk: reqs.some((q) => RE_GTM.test(q.url) && (ok2xx(status(q)) || status(q) === 304)),
    gaTag: reqs.filter((q) => RE_GA_TAG.test(q.url)).map((q) => `${new URL(q.url).searchParams.get('id') || '?'} ${status(q) ?? '—'}`),
    adsTag: reqs.some((q) => RE_ADS_TAG.test(q.url)),
    gaHits: gaHits.length,
    gaAbgefangen: gaHits.filter(ab).length,
    gcsErst: gcsListe[0] || '',
    gcs: [...new Set(gcsListe.filter(Boolean))],
    meta: reqs.some((q) => RE_META.test(q.url)),
    metaPageViews: Object.values(metaPvJe).reduce((a, b) => a + b, 0),
    doppelt,
  };
}

/** Zwei Detailzeilen zu einer Messung. */
function messungText(m, wo) {
  const tr = m.tracker.length
    ? liste(new Set(m.tracker.map((t) => `${t.pfad} ${t.abgefangen ? 'abgefangen' : t.status ?? 'ohne Antwort'}${t.verworfen ? ' (vom Server als Bot verworfen)' : ''}`)), 4)
    : 'keine Anfrage';
  return [
    `${wo} — Tracker: ${tr}${m.eventsLesbar ? ` · page_view ${m.pageViews}×` : ''}${m.landing ? ` · landing ${m.landing}` : ''}`,
    `${wo} — GTM: ${m.gtm.length ? `gtm.js ${m.gtm.map((x) => x ?? '—').join('/')}` : 'nicht geladen'} · Google-Tag: ${m.gaTag.length ? liste(new Set(m.gaTag), 3) : 'nein'}`
      + ` · GA4-Hits: ${m.gaHits}${m.gcsErst ? ` (erster gcs ${m.gcsErst}${m.gcs.length > 1 ? `, alle ${m.gcs.join('/')}` : ''})` : ''}${m.gaAbgefangen ? ', abgefangen' : ''}`
      + ` · Ads-Tag: ${m.adsTag ? 'ja' : 'nein'} · Meta-Pixel: ${m.meta ? 'geladen' : 'nein'}`,
  ];
}

/**
 * Messung komplett (Tracker antwortet, GTM und GA4 laufen — und Ads/Meta, sofern deren
 * Loader im HTML steht)? Sonst schaut die Gegenprobe noch beim nächsten Seitenaufruf nach.
 */
const messungKomplett = (m, lage) => m.trackerOk && m.gtmOk && m.gaHits > 0
  && (!lage?.adsGate || m.adsTag) && (!lage?.metaBridge || m.meta);

/** Brevo/PayPal (per Code abgeschaltet) in einer Einwilligungs-Probe: Regel → Ziele. */
function abgeschaltetAus(reqs, cookies, schreiber, html, siteHost, pfad) {
  const regeln = regelnFuer(pfad, ABGESCHALTET);
  const je = new Map();
  const merke = (tr) => {
    if (!tr?.regel) return;
    const e = je.get(tr.regel.id) || { regel: tr.regel, ziele: new Set() };
    e.ziele.add(tr.ziel);
    je.set(tr.regel.id, e);
  };
  for (const q of reqs) merke(requestEinordnen(q.url, siteHost, regeln, false));
  for (const c of cookies || []) merke(cookieEinordnen(c.name, c.domain, siteHost, regeln, false));
  for (const w of schreiber || []) merke(cookieEinordnen(w.name, siteHost, siteHost, regeln, false));
  for (const h of html || []) merke({ regel: REGEL.brevo, ziel: h });
  return [...je.values()];
}

/**
 * Gegenprobe: „Ok" in einem frischen Kontext. Seit Consent 0.2.0 ohne Reload — die
 * Messung muss in DERSELBEN Seitenansicht anlaufen (Tracker, GTM, GA4 mit gcs G111
 * schon beim ersten Hit). Fehlt dort etwas, noch ein Seitenaufruf hinterher: startet
 * es wenigstens dort (gelb, erste Seitenansicht fehlt) oder gar nicht (rot)?
 */
async function zustimmungPruefen(browser, geraet, url, opt, abbruch, siteHost) {
  const fs = await frischeSeite(browser, geraet, opt);
  const { seite, prot } = fs;
  const u = new URL(url);
  // gclid: optionale Variante (consentLeck.zustimmungGclid) — dann muss nach „Ok" _gcl_aw stehen.
  const z = { geraet: geraet.name, pfad: u.pathname, gclid: u.searchParams.has('gclid'), weg: null, grund: '', verdeckt: '', reload: false, consent: null, event: null, folge: null };
  try {
    prot.phase = 'z-vor';
    await seite.oeffnen(url, 45000);
    await ruhe(prot, { min: 3000, stille: 1500, max: 8000 }, abbruch);
    const docsVorher = fs.dokumente();
    const ladeWarter = browser.warteAuf('Page.loadEventFired', seite.sessionId, 40000);
    prot.phase = 'zustimmung';
    const tKlick = Date.now();
    const druck = await knopfDruecken(fs, KNOPF_OK, geraet.mobil);
    z.weg = druck.weg;
    z.grund = druck.grund || '';
    z.verdeckt = druck.verdeckt || '';
    if (!druck.weg) { ladeWarter.abbrechen(); return { z, prot }; }
    z.reload = await neuladenAbwarten(browser, fs, docsVorher, ladeWarter);
    await anstupsen(seite);
    await ruhe(prot, { min: 6000, stille: 2000, max: 14000 }, abbruch);

    // Die Antwort auf session-init kann etwas nachlaufen (keepalive, langsamer Server).
    const nachKlick = () => prot.requests.filter((q) => q.phase === 'zustimmung' && q.t >= tKlick);
    const ende = Date.now() + 5000;
    while (Date.now() < ende && !messungAus(nachKlick(), prot).trackerOk) await pause(250);

    z.event = prot.events.find((e) => e.phase === 'zustimmung') || null;
    z.lage = await lageLesen(seite);
    z.nach = messungAus(nachKlick(), prot);
    const cookies = await fs.cookies();
    z.consent = consentAusCookies(cookies);
    z.lk24a = cookies.filter((c) => /^lk24a_(sid|vid)$/.test(c.name)).map((c) => c.name);
    z.gclAw = cookies.some((c) => c.name === '_gcl_aw');

    // In derselben Seitenansicht unvollständig: läuft es wenigstens beim nächsten Aufruf?
    if (!z.reload && !messungKomplett(z.nach, z.lage)) {
      prot.phase = 'z-folge';
      await seite.oeffnen(url, 45000);
      await anstupsen(seite);
      await ruhe(prot, { min: 5000, stille: 2000, max: 12000 }, abbruch);
      z.folge = messungAus(prot.requests.filter((q) => q.phase === 'z-folge'), prot);
    }
    // Nur was NACH dem Klick lief (Requests, JS-Cookies): das HTML und die Cookies von
    // vorher hat die Erstbesucher-Probe schon — hier geht es um consent-abhängige Rückkehr.
    const reqs = prot.requests.filter((q) => q.phase === 'zustimmung' || q.phase === 'z-folge');
    const schreiber = prot.cookieSchreiber.filter((w) => w.phase === 'zustimmung' || w.phase === 'z-folge');
    z.abgeschaltet = abgeschaltetAus(reqs, [], schreiber, [], siteHost, z.pfad);
    return { z, prot };
  } finally {
    await fs.schliessen();
  }
}

/**
 * Teil-Einwilligung als Erstbesucher im Banner: „Einstellungen" → Schalter →
 * „Auswahl speichern". Kein Reload (erste Entscheidung) — die Gates müssen in der
 * laufenden Seite freischalten, und zwar nur die gewählte Kategorie. Eigene Beacons
 * und Messpunkte abgefangen (SENKEN_TEIL); ausgewertet wird ab dem Speichern.
 */
async function teilBannerPruefen(browser, geraet, url, profil, opt, abbruch) {
  const fs = await frischeSeite(browser, geraet, { ...opt, senken: SENKEN_TEIL });
  const { seite, prot } = fs;
  // wege: je Schritt, womit er ging (Tipp/Klick oder nur programmatisch) — 'js' ist gelb.
  const t = { profil, modus: 'banner', geraet: geraet.name, pfad: new URL(url).pathname, banner: null, cookies: [], consent: null, reload: false, event: null, schritt: '', wege: [] };
  try {
    prot.phase = 'tb-vor';
    await seite.oeffnen(url, 45000);
    await ruhe(prot, { min: 3000, stille: 1500, max: 8000 }, abbruch);
    const e = await knopfDruecken(fs, KNOPF_EINSTELLUNGEN, geraet.mobil, `!!document.querySelector('.lk24-consent__panel--settings')`);
    if (!e.weg) { t.schritt = `„Einstellungen": ${e.grund}`; return { t, prot }; }
    t.wege.push({ was: '„Einstellungen"', weg: e.weg, verdeckt: e.verdeckt || '' });
    for (const [k, v] of Object.entries(profil.kategorien)) {
      const sch = await schalterSetzen(fs, k, v, geraet.mobil);
      if (!sch.weg) { t.schritt = `Schalter ${k}: ${sch.grund}`; return { t, prot }; }
      t.wege.push({ was: `Schalter ${k}`, weg: sch.weg, verdeckt: sch.verdeckt || '' });
    }
    const docsVorher = fs.dokumente();
    const ladeWarter = browser.warteAuf('Page.loadEventFired', seite.sessionId, 40000);
    prot.phase = 'teil';
    const druck = await knopfDruecken(fs, KNOPF_SPEICHERN, geraet.mobil);
    if (!druck.weg) { ladeWarter.abbrechen(); t.schritt = `„Auswahl speichern": ${druck.grund}`; return { t, prot }; }
    t.wege.push({ was: '„Auswahl speichern"', weg: druck.weg, verdeckt: druck.verdeckt || '' });
    t.reload = await neuladenAbwarten(browser, fs, docsVorher, ladeWarter);
    await anstupsen(seite);
    await ruhe(prot, { min: 6000, stille: 2000, max: 14000 }, abbruch);
    t.event = prot.events.find((x) => x.phase === 'teil') || null;
    t.banner = await seite.eval(`!!document.querySelector('.lk24-consent')`).catch(() => null);
    t.lage = await lageLesen(seite);
    t.cookies = await fs.cookies();
    t.consent = consentAusCookies(t.cookies);
    return { t, prot };
  } finally {
    await fs.schliessen();
  }
}

/**
 * Teil-Einwilligung als Wiederkehrer: Consent-Cookie vorbelegt (wie consent.js es
 * schreibt: host-only, Path=/), dann eine Seite laden und mitschreiben. Alle eigenen
 * Beacons und Messpunkte werden abgefangen (SENKEN_TEIL) — ausgewertet wird nur,
 * was geladen oder gesendet worden wäre.
 */
async function teilPruefen(browser, geraet, url, profil, version, opt, abbruch) {
  const fs = await frischeSeite(browser, geraet, { ...opt, senken: SENKEN_TEIL });
  const { seite, prot } = fs;
  const t = { profil, modus: 'wiederkehrer', geraet: geraet.name, pfad: new URL(url).pathname, banner: null, cookies: [], consent: null };
  try {
    prot.phase = 'teil';
    const wert = JSON.stringify({ version, decidedAt: new Date().toISOString(), categories: { necessary: true, ...profil.kategorien } });
    const gesetzt = await seite.send('Network.setCookie', {
      name: CONSENT_COOKIE, value: encodeURIComponent(wert), url: new URL('/', url).href, path: '/',
      secure: url.startsWith('https:'), sameSite: 'Lax',
    });
    if (gesetzt && gesetzt.success === false) throw new Error('Consent-Cookie ließ sich nicht vorbelegen');
    await seite.oeffnen(url, 45000);
    await anstupsen(seite);
    await ruhe(prot, { min: 6000, stille: 2000, max: 14000 }, abbruch);
    t.banner = await seite.eval(`!!document.querySelector('.lk24-consent')`).catch(() => null);
    t.lage = await lageLesen(seite);
    t.cookies = await fs.cookies();
    t.consent = consentAusCookies(t.cookies);
    return { t, prot };
  } finally {
    await fs.schliessen();
  }
}

/**
 * Widerruf: frischer Kontext, „Ok", die Tags anlaufen lassen, dann „Datenschutz" →
 * „Ablehnen". Seit Consent 0.2.0 der EINZIGE Weg, auf dem consent.js neu lädt — nur so
 * sind laufende Tags (GA4, GTM, Meta, Tracker) wirklich weg. Erwartet: Event reload=true,
 * neues Dokument binnen 2,5 s, danach kein Tracker. prot.dok trennt die sterbende Seite
 * (alles nach dem Klick bis zum Dokumentwechsel) von der neu geladenen.
 */
async function widerrufPruefen(browser, geraet, url, opt, abbruch) {
  // Alles Eigene abgefangen (SENKEN_TEIL): hier zählt nur, OB der Tracker lief — keine
  // zusätzliche Live-Session und kein Reichweiten-Treffer je Lauf.
  const fs = await frischeSeite(browser, geraet, { ...opt, senken: SENKEN_TEIL });
  const { seite, prot } = fs;
  const w = { geraet: geraet.name, pfad: new URL(url).pathname, schritt: '', oeffnerFehlt: '', ablehnenKaputt: '', wege: [],
    reload: false, event: null, consent: null, banner: null, dokKlick: null, cookies: [] };
  try {
    prot.phase = 'w-vor';
    await seite.oeffnen(url, 45000);
    await ruhe(prot, { min: 3000, stille: 1500, max: 8000 }, abbruch);
    const ok = await knopfDruecken(fs, KNOPF_OK, geraet.mobil);
    if (!ok.weg) { w.schritt = `„Ok": ${ok.grund}`; return { w, prot }; }
    w.wege.push({ was: '„Ok"', weg: ok.weg, verdeckt: ok.verdeckt || '' });
    // Wie ein Besucher, der eine Weile bleibt: die Tags laufen an.
    prot.phase = 'w-ok';
    await anstupsen(seite);
    await ruhe(prot, { min: 5000, stille: 1500, max: 10000 }, abbruch);

    prot.phase = 'w-offen';
    const auf = await knopfDruecken(fs, '', geraet.mobil, `!!document.querySelector('.lk24-consent')`, OEFFNER);
    if (!auf.weg) { w.oeffnerFehlt = auf.grund; return { w, prot }; }
    w.wege.push({ was: '„Datenschutz"', weg: auf.weg, verdeckt: auf.verdeckt || '' });
    await pause(300);

    const docsVorher = fs.dokumente();
    const ladeWarter = browser.warteAuf('Page.loadEventFired', seite.sessionId, 40000);
    prot.phase = 'widerruf';
    w.dokKlick = prot.dok;
    const druck = await knopfDruecken(fs, KNOPF_ABLEHNEN, geraet.mobil, JS_ALLES_AUS);
    if (!druck.weg) { ladeWarter.abbrechen(); w.ablehnenKaputt = druck.grund; return { w, prot }; }
    w.wege.push({ was: '„Ablehnen"', weg: druck.weg, verdeckt: druck.verdeckt || '' });
    w.reload = await neuladenAbwarten(browser, fs, docsVorher, ladeWarter);
    prot.phase = 'w-nach';
    await anstupsen(seite);
    await ruhe(prot, RUHE_NACH, abbruch);
    w.event = prot.events.find((e) => e.phase === 'widerruf') || null;
    w.banner = await seite.eval(`!!document.querySelector('.lk24-consent')`).catch(() => null);
    w.cookies = await fs.cookies();
    w.consent = consentAusCookies(w.cookies);
    return { w, prot };
  } finally {
    await fs.schliessen();
  }
}

const RE_PPCP_JS = /^https?:\/\/[^/]+\/wp-content\/plugins\/woocommerce-paypal-payments\/[^?#]*\.js(\?|#|$)/;
const RE_PP_SDK = /^https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js\b/;
const JS_KAUF = `({
  smartButton: !!document.getElementById('ppcp-smart-button-js'),
  pluginSkripte: Array.prototype.filter.call(document.scripts, function (s) { return /\\/woocommerce-paypal-payments\\//.test(s.src || ''); }).length,
  paypal: !!(window.paypal && typeof window.paypal === 'object'),
  pfad: location.pathname
})`;

/**
 * Positivprobe Kaufseite (nur lesend): den LEEREN Warenkorb als Erstbesucher laden —
 * dort muss PayPal Payments laden (Plugin-Skript ppcp-smart-button und das SDK), sonst
 * ist die Härtung (class-fremd-haertung.php) zu breit und PayPal-Kunden können nicht
 * zahlen. /check-out/ leitet mit leerem Warenkorb auf /cart/ um, läuft aber durch
 * denselben is_checkout()-Zweig. FraudNet-/Statistik-Beacons fängt SENKEN ab.
 */
async function kaufPruefen(browser, geraet, url, opt, abbruch) {
  const fs = await frischeSeite(browser, geraet, { ...opt, senken: SENKEN_TEIL });
  const { seite, prot } = fs;
  const k = { geraet: geraet.name, pfad: new URL(url).pathname, status: null, dom: null, plugin: [], sdk: [] };
  try {
    prot.phase = 'kauf';
    await seite.oeffnen(url, 45000);
    await ruhe(prot, { min: 4000, stille: 1500, max: 10000 }, abbruch);
    k.dom = await seite.eval(JS_KAUF).catch(() => null);
    const status = (q) => prot.antworten.get(q.id) ?? null;
    const docs = prot.requests.filter((q) => q.typ === 'Document' && q.sid === seite.sessionId && q.frame === prot.hauptFrame);
    k.status = docs.length ? status(docs[docs.length - 1]) : null;
    k.plugin = prot.requests.filter((q) => RE_PPCP_JS.test(q.url))
      .map((q) => `${(q.url.split(/[?#]/)[0].split('/').pop() || '?').slice(0, 48)} ${status(q) ?? '—'}`);
    k.sdk = prot.requests.filter((q) => RE_PP_SDK.test(q.url)).map(status);
    return { k, prot };
  } finally {
    await fs.schliessen();
  }
}

// ---- Auswertung --------------------------------------------------------------

const PHASEN_TEXT = { vor: 'vor der Wahl', ablehnen: 'nach „Ablehnen"', abgelehnt: 'Folgeaufruf abgelehnt' };

/** Treffer einer Seite einsammeln: Requests, Cookie-Stände je Phase, Cookie-Schreibvorgänge. */
function trefferSammeln(erg, prot, siteHost) {
  const treffer = []; // { regel|fremd, ziel, phase }
  const regeln = regelnFuer(erg.pfad);
  for (const q of prot.requests) {
    if (!(q.phase in PHASEN_TEXT)) continue;
    const e = requestEinordnen(q.url, siteHost, regeln);
    if (e) treffer.push({ ...e, phase: q.phase, abgefangen: prot.abgefangen.has(q.id) });
  }
  for (const [phase, liste] of Object.entries(erg.cookiesJe)) {
    for (const c of liste || []) {
      const e = cookieEinordnen(c.name, c.domain, siteHost, regeln);
      if (e) treffer.push({ ...e, phase });
    }
  }
  for (const w of prot.cookieSchreiber) {
    if (!(w.phase in PHASEN_TEXT)) continue;
    const e = cookieEinordnen(w.name, siteHost, siteHost, regeln);
    if (e) treffer.push({ ...e, phase: w.phase });
  }
  // Im HTML statt im Netz: Brevos E-Mail-Mitleser / Brevo-Init (Seite als Erstbesucher).
  for (const [phase, liste] of Object.entries(erg.htmlJe || {})) {
    for (const ziel of liste || []) treffer.push({ regel: REGEL.brevo, ziel, phase });
  }
  return treffer;
}

function liste(set, n = 6) {
  const a = [...set];
  return a.slice(0, n).join(', ') + (a.length > n ? ` (+${a.length - n})` : '');
}

function auswerten(seiten, zustimmung, laufFehler, opt, teilBefunde = []) {
  const out = [];
  const geprueft = seiten.filter((s) => s.erg);
  const anzahl = geprueft.length;

  // ---- Regeln: je Regel ein Befund -------------------------------------------
  const jeRegel = new Map();
  const jeFremd = new Map();
  let fehlerTreffer = 0;
  for (const s of geprueft) {
    for (const t of s.treffer) {
      const ort = `${s.erg.geraet} ${s.erg.pfad}`;
      if (t.regel) {
        if (t.regel.art === 'fehler') fehlerTreffer++;
        const e = jeRegel.get(t.regel.id) || { regel: t.regel, ziele: new Set(), orte: new Map(), abgefangen: 0 };
        e.ziele.add(t.ziel);
        if (t.abgefangen) e.abgefangen++;
        if (!e.orte.has(ort)) e.orte.set(ort, new Set());
        e.orte.get(ort).add(t.phase);
        jeRegel.set(t.regel.id, e);
      } else if (t.fremd) {
        const e = jeFremd.get(t.fremd) || { ziele: new Set(), orte: new Set(), phasen: new Set() };
        e.ziele.add(t.ziel);
        e.orte.add(ort);
        e.phasen.add(t.phase);
        jeFremd.set(t.fremd, e);
      }
    }
  }

  const ortText = (e) => {
    const vor = [...e.orte.values()].filter((p) => p.has('vor')).length;
    const nach = [...e.orte.values()].filter((p) => p.has('ablehnen') || p.has('abgelehnt')).length;
    const teile = [];
    if (vor) teile.push(`vor der Wahl auf ${vor}/${anzahl} Seitenaufrufen`);
    if (nach) teile.push(`nach „Ablehnen" auf ${nach}/${anzahl}`);
    return teile.join(', ') || 'ohne Einwilligung';
  };
  const ortDetails = (e) => {
    const jeGeraet = new Map();
    for (const [ort, phasen] of e.orte) {
      const [g, p] = ort.split(' ');
      if (!jeGeraet.has(g)) jeGeraet.set(g, []);
      const kurz = ['vor', 'ablehnen', 'abgelehnt'].filter((ph) => phasen.has(ph))
        .map((ph) => ({ vor: 'vor', ablehnen: 'Ablehnen', abgelehnt: 'Folgeaufruf' })[ph]);
      jeGeraet.get(g).push(`${p} (${kurz.join('+')})`);
    }
    return [...jeGeraet].map(([g, l]) => `${g}: ${l.join(' · ')}`);
  };

  for (const r of FEHLER) {
    const e = jeRegel.get(r.id);
    if (!e) continue;
    out.push(befund(`leck-${r.id}`, `${r.titel} ohne Einwilligung`, 'alarm',
      ortText(e) + (e.abgefangen ? ` (${e.abgefangen}× vom Wächter abgefangen)` : ''),
      [`Ziele: ${liste(e.ziele)}`, ...ortDetails(e), ...(r.hinweis ? [r.hinweis] : [])]));
  }
  // noscript-GTM: lädt nur ohne JavaScript — klein, aber dieselbe Grenze.
  const noscript = geprueft.filter((s) => s.erg.noscriptGtm).map((s) => `${s.erg.geraet} ${s.erg.pfad}`);
  if (noscript.length) {
    out.push(befund('leck-gtm-noscript', 'GTM-noscript-iframe im HTML', 'warn',
      `lädt GTM ohne JavaScript und ohne Consent-Prüfung (${noscript.length}/${anzahl} Seitenaufrufe)`, [liste(new Set(noscript))]));
  }
  if (!fehlerTreffer && anzahl) {
    out.push(befund('leck', 'Tracker ohne Einwilligung', 'ok',
      `keine (${anzahl} Seitenaufruf${anzahl === 1 ? '' : 'e'} als Erstbesucher, vor der Wahl und nach „Ablehnen")`));
  }
  for (const r of BEKANNT) {
    const e = jeRegel.get(r.id);
    if (!e) continue;
    const status = r.art === 'fehler' ? 'alarm' : 'warn';
    out.push(befund(`${r.art === 'fehler' ? 'leck' : 'bekannt'}-${r.id}`, `${r.titel} ohne Einwilligung`, status,
      `${ortText(e)}${e.abgefangen ? ` (${e.abgefangen}× vom Wächter abgefangen)` : ''}${r.art === 'bekannt' ? ` — bekannt, ${r.wer}` : ' — war abgestellt, ist zurück'}`,
      [`Ziele: ${liste(e.ziele)}`, ...ortDetails(e), ...(r.art === 'fehler' && r.hinweis ? [r.hinweis] : [])]));
  }
  for (const [dom, e] of jeFremd) {
    out.push(befund(`fremd-${dom.replace(/[^a-z0-9]+/g, '-')}`, `Neuer Drittanbieter: ${dom}`, 'warn',
      `lädt ohne Einwilligung (${e.orte.size}/${anzahl} Seitenaufrufe) und steht auf keiner Liste — Tracker? Dann in checks/consent-leck.mjs einsortieren`,
      [`Ziele: ${liste(e.ziele)}`, `Orte: ${liste(e.orte)}`]));
  }

  // ---- Banner --------------------------------------------------------------------
  const ohneBanner = geprueft.filter((s) => !s.erg.banner).map((s) => `${s.erg.geraet} ${s.erg.pfad}`);
  if (anzahl) out.push(ohneBanner.length
    ? befund('banner', 'Consent-Banner', 'warn',
        `öffnet sich nicht von selbst auf ${ohneBanner.length}/${anzahl} Seitenaufrufen — dort kann niemand einwilligen (Messung fehlt)`, [liste(new Set(ohneBanner))])
    : befund('banner', 'Consent-Banner', 'ok', `öffnet sich beim Erstbesuch (${anzahl}/${anzahl})`));

  // ---- Ablehnen --------------------------------------------------------------------
  const abl = geprueft.filter((s) => s.erg.ablehnen);
  if (abl.length) {
    const ort = (s) => `${s.erg.geraet} ${s.erg.pfad}`;
    const kaputt = abl.filter((s) => !s.erg.ablehnen.weg);
    const nichtGespeichert = abl.filter((s) => s.erg.ablehnen.weg && !(s.erg.ablehnen.consent?.categories
      && ['statistics', 'marketing', 'external_media'].every((k) => s.erg.ablehnen.consent.categories[k] === false)));
    const nurJs = abl.filter((s) => s.erg.ablehnen.weg === 'js');
    const offen = abl.filter((s) => s.erg.ablehnen.weg && s.erg.ablehnen.bannerZu === false);
    const wiederOffen = abl.filter((s) => s.erg.ablehnen.bannerNachLaden === true);
    const mitReload = abl.filter((s) => s.erg.ablehnen.reload);
    // Tracker, die erst NACH dem Ablehnen auftauchen, hat das Ablehnen selbst ausgelöst.
    const ausgeloest = new Set();
    for (const s of abl) {
      const vorher = new Set(s.treffer.filter((t) => t.regel?.art === 'fehler' && t.phase === 'vor').map((t) => t.regel.id));
      for (const t of s.treffer) {
        if (t.regel?.art === 'fehler' && t.phase !== 'vor' && !vorher.has(t.regel.id)) ausgeloest.add(`${t.regel.titel} (${ort(s)})`);
      }
    }
    const nachAblehnen = new Set(abl.flatMap((s) => s.treffer.filter((t) => t.regel?.art === 'fehler' && t.phase !== 'vor').map((t) => t.regel.id)));
    const trefferText = nachAblehnen.size ? `, danach weiter ${nachAblehnen.size} Tracker-Art(en) aktiv (siehe oben)` : ', danach keine Tracker';
    // Womit ging es? Handy per Fingertipp, Desktop per Mausklick — „js" heißt: für Menschen tot.
    const wegeText = [...new Set(abl.map((s) => s.erg.geraet))].map((g) => {
      const zahl = {};
      for (const s of abl.filter((x) => x.erg.geraet === g)) { const w = s.erg.ablehnen.weg || 'nichts'; zahl[w] = (zahl[w] || 0) + 1; }
      return `${g}: ${Object.entries(zahl).map(([w, n]) => `${{ tipp: 'Tipp', klick: 'Klick', js: 'nur programmatisch', nichts: 'ohne Wirkung' }[w] || w} ${n}×`).join(', ')}`;
    }).join(' · ');

    if (kaputt.length) {
      out.push(befund('ablehnen', '„Ablehnen"', 'alarm',
        `funktioniert nicht auf ${kaputt.length}/${abl.length} Seitenaufrufen`, kaputt.map((s) => `${ort(s)}: ${s.erg.ablehnen.grund}`).slice(0, 4)));
    } else if (nichtGespeichert.length) {
      out.push(befund('ablehnen', '„Ablehnen"', 'alarm',
        `speichert die Entscheidung nicht (${nichtGespeichert.length}/${abl.length}) — kein ${CONSENT_COOKIE}-Cookie mit allen Kategorien aus`,
        nichtGespeichert.map((s) => `${ort(s)}: ${JSON.stringify(s.erg.ablehnen.consent?.categories ?? null)}`).slice(0, 4)));
    } else if (ausgeloest.size) {
      out.push(befund('ablehnen', '„Ablehnen"', 'alarm',
        'löst selbst Tracking aus — nach dem Klick tauchen Tracker auf, die vorher nicht da waren (oder sehr spät laden)', [liste(ausgeloest, 4)]));
    } else if (nurJs.length || offen.length || wiederOffen.length) {
      const d = [];
      if (nurJs.length) d.push(`reagiert nicht auf Tipp/Klick, nur programmatisch: ${liste(new Set(nurJs.map((s) => ort(s) + (s.erg.ablehnen.verdeckt ? ` (verdeckt von ${s.erg.ablehnen.verdeckt})` : ''))), 4)}`);
      if (offen.length) d.push(`Banner bleibt offen: ${liste(new Set(offen.map(ort)), 4)}`);
      if (wiederOffen.length) d.push(`Banner kommt beim nächsten Aufruf wieder: ${liste(new Set(wiederOffen.map(ort)), 4)}`);
      out.push(befund('ablehnen', '„Ablehnen"', 'warn', `hakt (${d.length} Auffälligkeit(en))${trefferText}`, d));
    } else if (mitReload.length) {
      // Bis Consent 0.1.9 lud jede Entscheidung neu. Ab 0.2.0 nicht mehr beim ersten Ablehnen.
      out.push(befund('ablehnen', '„Ablehnen"', 'info',
        `lädt die Seite neu (${mitReload.length}/${abl.length}) — altes Verhalten vor Consent 0.2.0, Hinweis, kein Fehler${trefferText}`, [wegeText]));
    } else {
      out.push(befund('ablehnen', '„Ablehnen"', 'ok',
        `kein Reload, Banner zu, Entscheidung gespeichert (${abl.length}/${abl.length})${trefferText}`, [wegeText]));
    }
  }

  // ---- Zustimmung (Gegenprobe) -------------------------------------------------------
  if (zustimmung) {
    const z = zustimmung.z;
    const wo = `${z.geraet} ${z.pfad}`;
    if (zustimmung.fehler) {
      out.push(befund('zustimmung', '„Ok" (Gegenprobe)', 'warn', `nicht auswertbar: ${zustimmung.fehler}`));
    } else if (!z.weg) {
      out.push(befund('zustimmung', '„Ok" (Gegenprobe)', 'alarm', `„Ok" funktioniert nicht (${wo}): ${z.grund}`));
    } else if (!z.nach) {
      out.push(befund('zustimmung', '„Ok" (Gegenprobe)', 'warn', `nicht auswertbar (${wo}): keine Messung nach dem Klick`));
    } else {
      const n = z.nach;
      const f = z.folge;
      const alleAn = z.consent?.categories && ['statistics', 'marketing', 'external_media'].every((k) => z.consent.categories[k] === true);
      const probleme = [];
      let status = 'ok';
      const rot = (x) => { probleme.push(x); status = 'alarm'; };
      const gelb = (x) => { probleme.push(x); if (status === 'ok') status = 'warn'; };

      if (!alleAn) rot(`Einwilligung nicht gespeichert (${CONSENT_COOKIE})`);
      // „Ok" nur programmatisch: für Menschen tot (Overlay, z-index, pointer-events) —
      // die Einwilligungsquote bricht ein, auch wenn danach alles sauber misst.
      if (z.weg === 'js') gelb(`„Ok" reagiert nicht auf Tipp/Klick, nur programmatisch${z.verdeckt ? ` (verdeckt von ${z.verdeckt})` : ''}`);
      // Eigener Tracker: session-init mit 2xx in derselben Seitenansicht.
      const httpText = (l) => [...new Set(l.map((t) => t.status))].join('/');
      const kaputt = [...n.trackerKaputt, ...(f?.trackerKaputt || [])];
      if (!n.trackerOk) {
        if (f?.trackerOk) {
          // Beim nächsten Aufruf läuft er — aber was war in DIESER Ansicht? Nicht jedes Fehlen
          // ist „startet erst beim nächsten" (N4-Regression): ein langsamer Server beantwortet
          // das rechtzeitig gesendete session-init nur zu spät.
          if (n.trackerKaputt.length) gelb(`session-init in derselben Seitenansicht scheitert (HTTP ${httpText(n.trackerKaputt)}), erst der nächste Seitenaufruf wird gemessen`);
          else if (n.trackerGesendet) gelb('session-init in derselben Seitenansicht gesendet, Antwort nicht rechtzeitig gesehen (Server langsam?)');
          else gelb('eigener Tracker startet erst beim nächsten Seitenaufruf (die erste Seitenansicht fehlt)');
        } else if (kaputt.length) rot(`Tracker-Anfragen scheitern (HTTP ${httpText(kaputt)})`);
        else if (!n.trackerGesendet && !f?.trackerGesendet) rot('eigener Tracker startet nicht (kein session-init)');
        else gelb('Antwort auf session-init nicht gesehen');
      } else if (n.pageViews > 1) {
        gelb(`page_view doppelt (${n.pageViews}×)`);
      } else if (!z.reload && n.eventsLesbar && !n.pageViews) {
        gelb('Tracker läuft, aber ohne page_view der Seite, auf der zugestimmt wurde');
      }
      // GTM (Marketing).
      if (!n.gtmOk) {
        if (f?.gtmOk) gelb('GTM lädt erst beim nächsten Seitenaufruf');
        else rot('GTM lädt nicht');
      }
      // GA4 (Statistik): schon der erste Hit muss die Zustimmung tragen (gcs G111).
      if (!n.gaHits) {
        if (f?.gaHits) gelb('GA4 startet erst beim nächsten Seitenaufruf');
        else if (n.gaTag.length || f?.gaTag.length) gelb('Google-Tag lädt, aber kein GA4-Hit');
        else rot('GA4 lädt nicht (kein Google-Tag, kein Hit)');
      } else if (n.gcsErst !== 'G111') {
        gelb(`erster GA4-Hit nach „Ok" ohne volle Zustimmung (gcs ${n.gcsErst || 'fehlt'}) — GA4 wertet ihn als „denied"`);
      }
      // Meta und Google Ads (Marketing): nur, wenn deren Loader im HTML steht.
      if (z.lage?.metaBridge && !n.meta) {
        if (f?.meta) gelb('Meta-Pixel lädt erst beim nächsten Seitenaufruf');
        else gelb('Meta-Pixel lädt nach „Ok" nicht');
      }
      if (z.lage?.adsGate && !n.adsTag) {
        if (f?.adsTag) gelb('Google-Ads-Tag lädt erst beim nächsten Seitenaufruf');
        else gelb('Google-Ads-Tag lädt nach „Ok" nicht (Conversion-Messung fehlt)');
      }
      if (z.gclid && !z.gclAw) gelb('nach „Ok" mit ?gclid kein _gcl_aw — der Ads-Klick geht für die Kauf-Conversion verloren');
      // Doppelt gestartet (Ladepfad + Listener oder Listener + Sync) = Doppelzählung in GA4/Ads/Meta/Sessions.
      // Nur ohne Reload: mit Reload sind es zwei Seitenansichten (dafür gibt es unten schon gelb).
      if (!z.reload && n.doppelt?.length) gelb(`doppelt gestartet in derselben Seitenansicht: ${n.doppelt.join(', ')}`);
      // landing = die Seite, auf der zugestimmt wurde (nicht Referrer, nicht die nächste Seite).
      const landingPfad = String(n.landing || '').split(/[?#]/)[0];
      if (landingPfad && landingPfad !== z.pfad) gelb(`session-init meldet landing ${n.landing} statt ${z.pfad} — Kanalzuordnung falsch`);
      // Kein Reload mehr nach „Ok" (Consent 0.2.0) — und das Event muss genau das ankündigen.
      if (z.reload) gelb(`lädt nach „Ok" neu — ${reloadGrund(z.lage, z.event)}`);
      if (!z.event && !z.reload) gelb('kein likoer24-consent-updated nach „Ok" — daran hängen alle Gates');
      if (z.event && typeof z.event.reload === 'boolean' && z.event.reload !== z.reload) {
        gelb(`consent.js kündigt reload=${z.event.reload} an, die Seite lud ${z.reload ? '' : 'nicht '}neu — darauf verlassen sich die Gates`);
      }
      if (z.abgeschaltet?.length) gelb(`${z.abgeschaltet.map((a) => a.regel.titel).join(', ')} lädt auch nach „Ok" (per Code abgeschaltet)`);

      const eventText = !z.event ? 'kein likoer24-consent-updated gesehen'
        : `reload=${z.event.reload === null ? 'fehlt (consent.js vor 0.2.0)' : z.event.reload}${z.event.via ? ` (${z.event.via})` : ''}`;
      const d = [
        ...messungText(n, z.reload ? 'Nach „Ok" (mit Reload)' : 'Gleiche Seitenansicht'),
        ...(f ? messungText(f, 'Nächster Seitenaufruf') : []),
        `„Ok" per ${wegText(z.weg, z.verdeckt)} · Reload nach „Ok": ${z.reload ? 'ja' : 'nein'} · Event: ${eventText} · lk24a-Cookies: ${z.lk24a?.length ? z.lk24a.join(', ') : 'keine'}`
          + (z.gclid ? ` · _gcl_aw: ${z.gclAw ? 'ja' : 'nein'}` : ''),
        ...(z.abgeschaltet || []).map((a) => `${a.regel.titel}: ${liste(a.ziele, 4)}`),
      ];
      out.push(befund('zustimmung', '„Ok" (Gegenprobe)', status,
        status === 'ok'
          ? `ohne Reload laufen in derselben Seitenansicht Tracker, GTM und GA4 an (erster Hit gcs G111) (${wo})`
          : `${probleme.join(', ')} (${wo})${status === 'alarm' ? ' — Messung fällt für Einwilliger aus' : ''}`,
        d));
    }
  }

  out.push(...teilBefunde);
  for (const f of laufFehler) out.push(befund(`lauf-${f.id}`, `Consent-Leck ${f.titel}`, 'warn', `Test nicht auswertbar: ${f.text}`));
  return { out, fehlerTreffer };
}

/** gcs-Parameter eines GA4-Hits: G1<ad_storage><analytics_storage>, z. B. G101. */
function gcsVon(urlText) {
  try { return new URL(urlText).searchParams.get('gcs') || ''; } catch { return ''; }
}

/**
 * Teil-Einwilligungen: je Profil und Modus ein Befund (Wiederkehrer: teil-<profil>,
 * im Banner gewählt: teil-<profil>-banner). Alarm, sobald etwas aus profil.verboten
 * geladen, gesendet (auch abgefangen) oder als Cookie gesetzt wurde — oder das Banner
 * etwas anderes speichert als gewählt. Gelb, wenn der Test nicht greift, die erlaubte
 * Messung fehlt, die Banner-Auswahl hakt oder neu lädt.
 */
function teilAuswerten(teile, siteHost) {
  const out = [];
  let trefferZahl = 0;
  for (const e of teile) {
    const p = e.t.profil;
    const banner = e.t.modus === 'banner';
    const id = `teil-${p.id}${banner ? '-banner' : ''}`;
    const titel = `${p.titel} (${banner ? 'im Banner gewählt' : 'Teil-Einwilligung'})`;
    const wo = `${e.t.geraet} ${e.t.pfad}`;
    if (e.fehler) { out.push(befund(id, titel, 'warn', `nicht auswertbar (${wo}): ${e.fehler}`)); continue; }
    const { t, prot } = e;

    // Banner-Auswahl: kamen „Einstellungen", Schalter und „Auswahl speichern" durch?
    if (banner && t.schritt) {
      out.push(befund(id, titel, 'warn', `Auswahl im Banner klappt nicht (${wo}): ${t.schritt}`));
      continue;
    }
    // Greift der Test überhaupt? Offenes Banner = consent.js kennt das Cookie nicht
    // (z. B. neue CONSENT_VERSION) — dann lädt nichts, und „sauber" wäre gelogen.
    const kat = t.consent?.categories;
    const wieGewaehlt = kat && Object.entries(p.kategorien).every(([k, v]) => !!kat[k] === v);
    if (banner && kat && !wieGewaehlt) {
      trefferZahl++;
      out.push(befund(id, titel, 'alarm', `„Auswahl speichern" speichert etwas anderes als gewählt (${wo}): ${JSON.stringify(kat)}`));
      continue;
    }
    if (!(t.banner === false && wieGewaehlt)) {
      const grund = banner
        ? (t.banner === true ? 'Banner bleibt nach „Auswahl speichern" offen' : t.banner === null ? 'Seite nicht auswertbar' : 'Auswahl nicht gespeichert (kein Consent-Cookie)')
        : (t.banner === true ? 'Banner offen trotz vorbelegter Einwilligung — Consent-Version geändert?'
          : t.banner === null ? 'Seite nicht auswertbar'
          : `Consent-Cookie nicht wie vorbelegt (${JSON.stringify(kat ?? null)})`);
      out.push(befund(id, titel, 'warn', `nicht auswertbar (${wo}): ${grund}`));
      continue;
    }

    // Ausgewertet wird ab der Entscheidung (Wiederkehrer: alles; Banner: ab „Auswahl speichern").
    const reqs = banner ? prot.requests.filter((q) => q.phase === 'teil') : prot.requests;
    const schreiber = banner ? prot.cookieSchreiber.filter((w) => w.phase === 'teil') : prot.cookieSchreiber;

    // Verbotenes: Requests (auch abgefangene), Cookie-Stand am Ende, JS-Cookie-Schreibvorgänge.
    const jeRegel = new Map();
    const merke = (tr, abgefangen = false) => {
      if (!tr?.regel) return;
      const s = jeRegel.get(tr.regel.id) || { regel: tr.regel, ziele: new Set(), abgefangen: 0 };
      s.ziele.add(tr.ziel);
      if (abgefangen) s.abgefangen++;
      jeRegel.set(tr.regel.id, s);
    };
    for (const q of reqs) merke(requestEinordnen(q.url, siteHost, p.verboten, false), prot.abgefangen.has(q.id));
    for (const c of t.cookies) merke(cookieEinordnen(c.name, c.domain, siteHost, p.verboten, false));
    for (const w of schreiber) merke(cookieEinordnen(w.name, siteHost, siteHost, p.verboten, false));

    // Was lief — für die Details und die Erwartung an die erlaubte Kategorie.
    const m = messungAus(reqs, prot);
    const lk24a = [...new Set(t.cookies.filter((c) => /^lk24a_(sid|vid)$/.test(c.name)).map((c) => c.name))];
    // Wiederkehrer: die ganze Seite läuft mit Einwilligung. Banner: erst ab dem Speichern.
    const aus = banner ? abgeschaltetAus(reqs, [], schreiber, [], siteHost, t.pfad)
      : abgeschaltetAus(reqs, t.cookies, schreiber, t.lage?.brevo, siteHost, t.pfad);

    const verboten = [...jeRegel.values()];
    const d = verboten.map((s) => `${s.regel.titel}: ${liste(s.ziele)}${s.abgefangen ? ` (${s.abgefangen}× vom Wächter abgefangen)` : ''}`);
    d.push(`Geladen: GA4-Hits ${m.gaHits}${m.gcsErst ? ` (erster gcs ${m.gcsErst}${m.gcs.length > 1 ? `, alle ${m.gcs.join('/')}` : ''})` : ''}`
      + ` · Google-Tag ${m.gaTag.length ? 'ja' : 'nein'} · GTM ${m.gtm.length ? 'ja' : 'nein'} · Ads-Tag ${m.adsTag ? 'ja' : 'nein'} · Meta-Pixel ${m.meta ? 'ja' : 'nein'}`
      + ` · session-init ${m.trackerGesendet ? 'gesendet' : 'nein'} · lk24a-Cookies: ${lk24a.length ? lk24a.join(', ') : 'keine'}`);
    if (banner) {
      const ev = !t.event ? 'kein likoer24-consent-updated gesehen'
        : `reload=${t.event.reload === null ? 'fehlt (consent.js vor 0.2.0)' : t.event.reload}${t.event.via ? ` (${t.event.via})` : ''}`;
      d.push(`Reload nach „Auswahl speichern": ${t.reload ? 'ja' : 'nein'} · Event: ${ev}`);
      if (t.wege?.length) d.push(`Wege: ${t.wege.map((x) => `${x.was} ${wegText(x.weg, x.verdeckt)}`).join(' · ')}`);
    }
    for (const a of aus) d.push(`${a.regel.titel}: ${liste(a.ziele, 4)}`);

    const probleme = [];
    let status = 'ok';
    const gelb = (text) => { probleme.push(text); if (status === 'ok') status = 'warn'; };
    if (verboten.length) {
      probleme.push(`${verboten.map((s) => s.regel.titel).join(', ')} ${p.ohne}`);
      status = 'alarm';
      trefferZahl += verboten.length;
    }
    if (p.id === 'statistik') {
      const adAn = m.gcs.filter((g) => /^G11/.test(g));
      if (adAn.length) { probleme.push(`GA4 meldet ad_storage „granted" ${p.ohne} (gcs ${adAn.join('/')})`); status = 'alarm'; trefferZahl++; }
      else if (!m.gaHits) gelb(`kein GA4-Hit${banner ? ' in derselben Seitenansicht' : ''} — Statistik-Einwilliger werden nicht gemessen`);
      else if (m.gcsErst !== 'G101') gelb(`erster GA4-Hit trotz Statistik-Einwilligung als „denied" (gcs ${m.gcsErst || 'fehlt'})`);
      if (banner && !m.trackerGesendet) gelb('eigener Tracker startet nicht in derselben Seitenansicht (kein session-init)');
    }
    if (p.id === 'marketing') {
      if (!m.gtm.length) gelb(`GTM lädt nicht${banner ? ' in derselben Seitenansicht' : ''} (E1: Marketing reicht) — Ads-Messung fehlt`);
      if (t.lage?.metaBridge && !m.meta) gelb('Meta-Pixel lädt nicht');
    }
    if (banner && t.reload) gelb(`lädt nach „Auswahl speichern" neu — ${reloadGrund(t.lage, t.event)}`);
    if (banner && t.event && typeof t.event.reload === 'boolean' && t.event.reload !== t.reload) {
      gelb(`consent.js kündigt reload=${t.event.reload} an, die Seite lud ${t.reload ? '' : 'nicht '}neu`);
    }
    // Auswahl nur programmatisch möglich: für Menschen tot — die Teil-Einwilligung fällt aus.
    const nurJs = (t.wege || []).filter((x) => x.weg === 'js');
    if (banner && nurJs.length) {
      gelb(`reagiert nicht auf Tipp/Klick, nur programmatisch: ${nurJs.map((x) => x.was + (x.verdeckt ? ` (verdeckt von ${x.verdeckt})` : '')).join(', ')}`);
    }
    // Doppelt gestartet (N2-Guard) — nur in einer einzigen Seitenansicht aussagekräftig.
    if (!t.reload && m.doppelt?.length) gelb(`doppelt gestartet: ${m.doppelt.join(', ')}`);
    if (aus.length) gelb(`${aus.map((a) => a.regel.titel).join(', ')} lädt trotz Abschaltung`);

    out.push(befund(id, titel, status,
      status === 'ok' ? `nur Erlaubtes geladen${banner ? ', ohne Reload' : ''} (${wo})` : `${probleme.join(', ')} (${wo})`, d));
  }
  return { out, trefferZahl };
}

/** Ziel einer Mess-Anfrage mit Ereignisname (Meta ev=, GA4 en=) — beim Widerruf zählt, WAS rausging. */
function zielMitEreignis(q, ziel) {
  if (RE_META_TR.test(q.url)) { const ev = paramAus(q, 'ev'); return ev ? `${ziel} ev=${ev}` : ziel; }
  if (RE_GA_HIT.test(q.url)) {
    const en = paramAus(q, 'en') || (String(q.post || '').match(/(?:^|&)en=([^&\n]+)/) || [])[1] || '';
    return en ? `${ziel} en=${en}` : ziel;
  }
  return ziel;
}

const ABGESCHALTET_IDS = new Set(ABGESCHALTET.map((r) => r.id));

/**
 * Widerruf auswerten (Befund 'widerruf'). Rot: Widerruf nicht erreichbar/ohne Wirkung,
 * nicht gespeichert, kein Reload, oder nach dem Reload wieder Tracker. Gelb: was die
 * sterbende Seite nach dem Klick noch sendet (Meta-Klick-Event, GA4-Ping …), nur
 * programmatisch erreichbare Knöpfe, ein Event, das nicht zum Verhalten passt.
 * Brevo/PayPal und Google Fonts zählen hier nicht — die sind seitenbasiert und stehen schon beim Erstbesuch.
 */
function widerrufAuswerten(wr, siteHost) {
  if (!wr) return [];
  const id = 'widerruf';
  const titel = 'Widerruf („Datenschutz" → „Ablehnen")';
  const w = wr.w || {};
  const wo = `${w.geraet} ${w.pfad}`;
  if (wr.fehler) return [befund(id, titel, 'warn', `nicht auswertbar (${wo}): ${wr.fehler}`)];
  if (w.oeffnerFehlt) {
    return [befund(id, titel, 'alarm', `„Datenschutz"-Knopf: ${w.oeffnerFehlt} (${wo}) — Besucher können ihre Einwilligung nicht widerrufen`)];
  }
  if (w.ablehnenKaputt) {
    return [befund(id, titel, 'alarm', `„Ablehnen" im Datenschutz-Dialog wirkt nicht: ${w.ablehnenKaputt} (${wo}) — Widerruf nicht möglich`)];
  }
  if (w.schritt) return [befund(id, titel, 'warn', `nicht auswertbar (${wo}): ${w.schritt}`)];
  const { prot } = wr;

  // Nur consent-abhängige Tracker (FEHLER ohne Brevo/PayPal, ohne seitenbasierte wie Fonts); Kaufseiten-Freigaben beachten.
  const regeln = regelnFuer(w.pfad).filter((r) => r.art === 'fehler' && !ABGESCHALTET_IDS.has(r.id) && !r.seitenbasiert);
  const sammeln = (reqs, schreiber) => {
    const je = new Map();
    const merke = (tr, ziel) => {
      if (!tr?.regel) return;
      const e = je.get(tr.regel.id) || { regel: tr.regel, ziele: new Set() };
      e.ziele.add(ziel || tr.ziel);
      je.set(tr.regel.id, e);
    };
    for (const q of reqs) { const tr = requestEinordnen(q.url, siteHost, regeln, false); if (tr) merke(tr, zielMitEreignis(q, tr.ziel)); }
    for (const s of schreiber) merke(cookieEinordnen(s.name, siteHost, siteHost, regeln, false));
    return [...je.values()];
  };
  // Die sterbende Seite: nach dem Klick auf „Ablehnen", bis das neue Dokument übernimmt.
  const alt = (x) => x.phase === 'widerruf' && x.dok === w.dokKlick;
  const neu = (x) => (x.phase === 'widerruf' || x.phase === 'w-nach') && x.dok > w.dokKlick;
  const vorReload = sammeln(prot.requests.filter(alt), prot.cookieSchreiber.filter(alt));
  const nachReload = sammeln(prot.requests.filter(neu), prot.cookieSchreiber.filter(neu));
  const vorher = messungAus(prot.requests.filter((q) => ['w-vor', 'w-ok', 'w-offen'].includes(q.phase)), prot);
  const liegen = [...new Set((w.cookies || []).map((c) => cookieEinordnen(c.name, c.domain, siteHost, regeln, false))
    .filter((tr) => tr?.regel).map((tr) => tr.ziel.replace(/^Cookie /, '')))];

  const probleme = [];
  let status = 'ok';
  const rot = (x) => { probleme.push(x); status = 'alarm'; };
  const gelb = (x) => { probleme.push(x); if (status === 'ok') status = 'warn'; };
  const kat = w.consent?.categories;
  if (!(kat && ['statistics', 'marketing', 'external_media'].every((k) => kat[k] === false))) {
    rot(`Widerruf nicht gespeichert (${CONSENT_COOKIE}: ${JSON.stringify(kat ?? null)})`);
  }
  if (!w.reload) rot('lädt nach dem Widerruf nicht neu — GTM, GA4, Meta und Tracker laufen in dieser Seitenansicht weiter');
  if (nachReload.length) rot(`nach dem Reload wieder aktiv: ${nachReload.map((e) => e.regel.titel).join(', ')}`);
  if (vorReload.length) gelb(`sendet beim Widerruf noch (vor dem Reload): ${vorReload.map((e) => e.regel.titel).join(', ')}`);
  const nurJs = (w.wege || []).filter((x) => x.weg === 'js');
  if (nurJs.length) gelb(`reagiert nicht auf Tipp/Klick, nur programmatisch: ${nurJs.map((x) => x.was + (x.verdeckt ? ` (verdeckt von ${x.verdeckt})` : '')).join(', ')}`);
  if (!w.event) gelb('kein likoer24-consent-updated beim Widerruf');
  else if (typeof w.event.reload === 'boolean' && w.event.reload !== w.reload) {
    gelb(`consent.js kündigt reload=${w.event.reload} an, die Seite lud ${w.reload ? '' : 'nicht '}neu`);
  }
  if (w.reload && w.banner === true) gelb('Banner öffnet sich nach dem Widerruf wieder');

  const lief = [vorher.trackerGesendet && 'Tracker', vorher.gtm.length && 'GTM', vorher.gaHits && `GA4 (${vorher.gaHits} Hits)`,
    vorher.adsTag && 'Ads-Tag', vorher.meta && 'Meta-Pixel'].filter(Boolean);
  const ev = !w.event ? 'keins' : `reload=${w.event.reload === null ? 'fehlt (consent.js vor 0.2.0)' : w.event.reload}${w.event.via ? ` (${w.event.via})` : ''}`;
  const d = [
    `Vor dem Widerruf liefen: ${lief.length ? lief.join(', ') : 'keine Tags (die Probe sagt dann wenig über den Reload-Nutzen)'}`,
    `Wege: ${(w.wege || []).map((x) => `${x.was} ${wegText(x.weg, x.verdeckt)}`).join(' · ')} · Reload: ${w.reload ? 'ja' : 'nein'} · Event: ${ev}`,
    ...vorReload.map((e) => `Vor dem Reload noch gesendet — ${e.regel.titel}: ${liste(e.ziele, 4)}`),
    ...nachReload.map((e) => `Nach dem Reload — ${e.regel.titel}: ${liste(e.ziele, 4)}`),
    ...(liegen.length ? [`Cookies aus der Zustimmung bleiben im Browser liegen: ${liste(new Set(liegen), 6)}`] : []),
  ];
  return [befund(id, titel, status,
    status === 'ok' ? `lädt neu, danach kein Tracker, Entscheidung gespeichert (${wo})` : `${probleme.join(', ')} (${wo})`, d)];
}

/** Positivprobe Warenkorb auswerten (Befund 'kauf-paypal'). */
function kaufAuswerten(kr) {
  if (!kr) return [];
  const id = 'kauf-paypal';
  const titel = 'PayPal im Warenkorb (Positivprobe)';
  const k = kr.k || {};
  const wo = `${k.geraet} ${k.pfad}`;
  if (kr.fehler) return [befund(id, titel, 'warn', `nicht auswertbar (${wo}): ${kr.fehler}`)];
  const pfadNorm = (p) => String(p || '').replace(/\/+$/, '').toLowerCase();
  if (k.dom?.pfad && pfadNorm(k.dom.pfad) !== pfadNorm(k.pfad)) {
    return [befund(id, titel, 'warn', `nicht auswertbar: ${k.pfad} leitet auf ${k.dom.pfad} um (Warenkorb-Slug geändert? consentLeck.kaufSeite)`)];
  }
  if (k.status !== null && k.status !== undefined && !ok2xx(k.status)) {
    return [befund(id, titel, 'warn', `nicht auswertbar: ${k.pfad} antwortet mit HTTP ${k.status}`)];
  }
  const plugin = k.plugin.length > 0 || !!k.dom?.smartButton || (k.dom?.pluginSkripte || 0) > 0;
  const sdkOk = k.sdk.some((s) => ok2xx(s) || s === 304) || !!k.dom?.paypal;
  const d = [`Plugin-Skripte: ${k.plugin.length ? liste(new Set(k.plugin), 4) : 'keine'} · ppcp-smart-button im HTML: ${k.dom?.smartButton ? 'ja' : 'nein'}`
    + ` · PayPal-SDK: ${k.sdk.length ? k.sdk.map((s) => s ?? '—').join('/') : 'nicht angefragt'} · window.paypal: ${k.dom?.paypal ? 'ja' : 'nein'}`];
  const warum = 'Härtung zu breit? (is_cart() beim Hook, Filter lk24c_fremd_paypal_seite_erlaubt, PayPal-Update mit neuer Abhängigkeit)';
  if (!plugin) return [befund(id, titel, 'alarm', `PayPal Payments lädt im Warenkorb nicht (${wo}) — PayPal-Kunden können nicht zahlen. ${warum}`, d)];
  if (!k.sdk.length && !k.dom?.paypal) return [befund(id, titel, 'alarm', `Plugin-Skript da, aber das PayPal-SDK lädt nicht (${wo}) — keine PayPal-Buttons. ${warum}`, d)];
  if (!sdkOk) return [befund(id, titel, 'warn', `PayPal-SDK antwortet nicht (HTTP ${k.sdk.map((s) => s ?? '—').join('/')}) (${wo}) — Störung bei PayPal?`, d)];
  return [befund(id, titel, 'ok', `PayPal lädt im Warenkorb (Plugin-Skript + SDK) (${wo})`, d)];
}

// ---- Einstieg ----------------------------------------------------------------

const GERAETE = {
  mobil: { name: 'Handy', mobil: true, breite: 390, hoehe: 740 },
  desktop: { name: 'Desktop', mobil: false, breite: 1280, hoehe: 800 },
};

export async function run(ctx) {
  const cfg = ctx.cfg.consentLeck || {};
  if (cfg.aktiv === false) return [befund('leck', 'Tracker ohne Einwilligung', 'info', 'in config.json abgeschaltet')];
  if (!chromiumFinden()) {
    return [befund('leck', 'Tracker ohne Einwilligung', 'info',
      'kein Chromium gefunden — der Consent-Test läuft nicht (Pi: sudo apt install chromium; Mac: Google Chrome oder LK_CHROME)')];
  }

  const basis = String(process.env.LK24_CONSENT_BASIS || cfg.basis || ctx.cfg.shop?.basis || 'https://likoer24.de').replace(/\/+$/, '');
  const siteHost = new URL(basis).hostname.toLowerCase().replace(/^www\./, '');
  const seitenPfade = cfg.seiten || ['/', '/konfigurator/', '/hochzeit/'];
  const geraete = (cfg.geraete || ['mobil', 'desktop']).map((g) => GERAETE[g]).filter(Boolean);
  const opt = { sperren: cfg.sperren !== false };
  const zustimmungAn = cfg.zustimmung !== false;
  const zGeraet = GERAETE[cfg.zustimmungGeraet || 'mobil'] || GERAETE.mobil;
  const zPfad = cfg.zustimmungSeite || '/konfigurator/';
  // Teil-Einwilligungen auf einer gecachten LP (das Gate muss im Cache-HTML clientseitig greifen).
  const teilAn = cfg.teilEinwilligung !== false;
  // Dieselben Profile als Erstbesucher im Banner gewählt (ohne Reload, Gates schalten in der Seite frei).
  const teilBannerAn = teilAn && cfg.teilBanner !== false;
  const tGeraet = GERAETE[cfg.teilGeraet || 'desktop'] || GERAETE.desktop;
  const tPfad = cfg.teilSeite || '/hochzeit/';
  // Optional: „Ok" auf einer URL mit ?gclid (dann muss _gcl_aw stehen). Aus, bis Analytics 0.8.0
  // live ist — vorher zählt der Reichweitenzähler den Wächter-Besuch sonst als Ads-Klick.
  const zUrl = basis + zPfad + (cfg.zustimmungGclid ? `${zPfad.includes('?') ? '&' : '?'}gclid=lk24-watchdog-probe` : '');
  // Widerruf („Ok" → „Datenschutz" → „Ablehnen"): der einzige verbliebene Reload-Pfad.
  const widerrufAn = cfg.widerruf !== false;
  const wGeraet = GERAETE[cfg.widerrufGeraet || 'mobil'] || GERAETE.mobil;
  const wPfad = cfg.widerrufSeite || '/hochzeit/';
  // Positivprobe: im (leeren) Warenkorb MUSS PayPal laden.
  const kaufAn = cfg.kaufProbe !== false;
  const kGeraet = GERAETE[cfg.kaufGeraet || 'desktop'] || GERAETE.desktop;
  const kPfad = cfg.kaufSeite || '/cart/';
  kaufSeitenExtra = Array.isArray(cfg.kaufSeitenExtra) ? cfg.kaufSeitenExtra.map(String).filter(Boolean) : [];

  const t0 = Date.now();
  const seiten = [];
  const laufFehler = [];
  const teile = [];
  let zustimmung = null;
  let widerruf = null;
  let kauf = null;
  let browser = null;
  try {
    browser = await browserStarten({ width: 390, height: 740 });

    for (const g of geraete) {
      const abbruch = { jetzt: false };
      const ablauf = (async () => {
        for (const p of seitenPfade) {
          if (abbruch.jetzt) break;
          const url = basis + p;
          // Ein einzelner Aussetzer (Zeitüberschreitung beim Laden) bekommt einen zweiten Versuch.
          let letzter = null;
          for (let versuch = 0; versuch < 2 && !abbruch.jetzt; versuch++) {
            try {
              const { erg, prot } = await seitePruefen(browser, g, url, opt, abbruch);
              seiten.push({ erg, treffer: trefferSammeln(erg, prot, siteHost), requests: prot.requests.length });
              letzter = null;
              break;
            } catch (e) {
              letzter = e;
              if (e instanceof Abgebrochen) break;
              await pause(1500);
            }
          }
          if (letzter && !(letzter instanceof Abgebrochen)) {
            laufFehler.push({ id: `seite-${g.name}-${p}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, ''), titel: `${g.name} ${p}`, text: letzter.message });
          }
        }
      })();
      try {
        await mitZeitlimit(ablauf, (cfg.zeitlimitSek ?? 240) * 1000, `Consent-Leck ${g.name}`, abbruch);
      } catch (e) {
        laufFehler.push({ id: g.name.toLowerCase(), titel: g.name, text: e.message });
      }
    }

    if (zustimmungAn) {
      const abbruch = { jetzt: false };
      try {
        // Bis zu zwei Seitenaufrufe (gleiche Ansicht + ggf. Folgeaufruf) — deshalb mehr Zeit als eine Teil-Probe.
        zustimmung = await mitZeitlimit(zustimmungPruefen(browser, zGeraet, zUrl, opt, abbruch, siteHost), 150000, 'Gegenprobe „Ok"', abbruch);
      } catch (e) {
        zustimmung = { z: { geraet: zGeraet.name, pfad: zPfad }, fehler: e.message };
      }
    }

    if (teilAn) {
      // Version: Konfiguration vor dem, was consent.js in der Gegenprobe eben selbst geschrieben hat, sonst Standard.
      const gesehen = zustimmung?.z?.consent?.version;
      const version = String(cfg.consentVersion || (typeof gesehen === 'string' && gesehen) || CONSENT_VERSION_STANDARD);
      for (const profil of TEIL_PROFILE) {
        const abbruch = { jetzt: false };
        try {
          teile.push(await mitZeitlimit(teilPruefen(browser, tGeraet, basis + tPfad, profil, version, opt, abbruch), 60000, profil.titel, abbruch));
        } catch (e) {
          teile.push({ t: { profil, modus: 'wiederkehrer', geraet: tGeraet.name, pfad: tPfad }, fehler: e.message });
        }
      }
      if (teilBannerAn) {
        for (const profil of TEIL_PROFILE) {
          const abbruch = { jetzt: false };
          try {
            teile.push(await mitZeitlimit(teilBannerPruefen(browser, tGeraet, basis + tPfad, profil, opt, abbruch), 90000, `${profil.titel} im Banner`, abbruch));
          } catch (e) {
            teile.push({ t: { profil, modus: 'banner', geraet: tGeraet.name, pfad: tPfad }, fehler: e.message });
          }
        }
      }
    }

    if (widerrufAn) {
      const abbruch = { jetzt: false };
      try {
        widerruf = await mitZeitlimit(widerrufPruefen(browser, wGeraet, basis + wPfad, opt, abbruch), 90000, 'Widerruf', abbruch);
      } catch (e) {
        widerruf = { w: { geraet: wGeraet.name, pfad: wPfad }, fehler: e.message };
      }
    }

    if (kaufAn) {
      const abbruch = { jetzt: false };
      try {
        kauf = await mitZeitlimit(kaufPruefen(browser, kGeraet, basis + kPfad, opt, abbruch), 60000, 'Warenkorb-Probe', abbruch);
      } catch (e) {
        kauf = { k: { geraet: kGeraet.name, pfad: kPfad }, fehler: e.message };
      }
    }
  } catch (e) {
    return [befund('leck', 'Tracker ohne Einwilligung', 'warn', `Browser startet nicht: ${e.message}`)];
  } finally {
    try { browser?.schliessen(); } catch { /* egal */ }
  }

  const teil = teilAuswerten(teile, siteHost);
  const zusatz = [...teil.out, ...widerrufAuswerten(widerruf, siteHost), ...kaufAuswerten(kauf)];
  const { out, fehlerTreffer } = auswerten(seiten, zustimmung, laufFehler, opt, zusatz);
  ctx.merken('consent.fehlerTreffer', fehlerTreffer);
  ctx.merken('consent.teilTreffer', teil.trefferZahl);
  ctx.merken('consent.drittRequestsVor', seiten.reduce((n, s) => n + s.treffer.filter((t) => t.phase === 'vor' && !t.ziel.startsWith('Cookie ')).length, 0));
  ctx.merken('consent.dauerMs', Date.now() - t0);
  return out;
}
