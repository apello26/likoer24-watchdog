/**
 * Ist der Laden offen?
 *
 * Der billigste und wichtigste Check: Startseite, Konfigurator, Warenkorb,
 * Kasse und die REST-Basis müssen antworten — und zwar mit dem, was sie
 * antworten sollen, nicht bloß mit HTTP 200. Eine WordPress-Fehlerseite
 * kommt fröhlich als 200 zurück; deshalb prüfen wir zusätzlich auf
 * Textmerkmale und plausible Seitengrößen.
 */

import { befund, holenWeich } from '../lib/kern.mjs';

export const name = 'Erreichbarkeit';

/** Seiten, die immer gehen müssen, mit Mindestgröße und Pflichttext. */
const SEITEN = [
  { id: 'start',        pfad: '/',              minKb: 40, muss: /konfigurator/i,               titel: 'Startseite' },
  { id: 'konfigurator', pfad: '/konfigurator/', minKb: 60, muss: /LK24_BOOT/,                   titel: 'Konfigurator' },
  { id: 'warenkorb',    pfad: '/cart/',         minKb: 10, muss: /warenkorb|cart/i,             titel: 'Warenkorb' },
  // Die Kasse ist die German-Market-Seite. /check-out/ leitet bei leerem
  // Warenkorb auf /cart/ um — als Prüfpunkt also untauglich.
  { id: 'kasse',        pfad: '/bestellung_bestaetigen__absenden/', minKb: 40, muss: /woocommerce|bestellung/i, titel: 'Kasse' },
];

/** Verräterische Sätze, die auf einer gesunden Seite nichts zu suchen haben. */
const KAPUTT = [
  { re: /There has been a critical error on this website|Es gab einen kritischen Fehler/i, was: 'WordPress meldet einen kritischen Fehler' },
  { re: /Fatal error:|Parse error:|Warning: .{0,40} on line \d+/,                          was: 'PHP-Fehler wird im Seitenquelltext ausgegeben' },
  { re: /Error establishing a database connection/i,                                       was: 'keine Datenbankverbindung' },
  { re: /No space left on device/i,                                                        was: 'Server meldet volle Platte' },
  { re: /briefly unavailable for scheduled maintenance/i,                                  was: 'Wartungsmodus aktiv (.maintenance-Datei hängt)' },
];

export async function run(ctx) {
  const out = [];
  const basis = ctx.cfg.shop.basis;

  for (const s of SEITEN) {
    const r = await holenWeich(basis + s.pfad, { timeoutMs: ctx.cfg.shop.timeoutMs });
    ctx.merken(`seite.${s.id}.ms`, r.dauerMs);

    if (r.status === 0) {
      out.push(befund(`seite.${s.id}`, s.titel, 'alarm', `nicht erreichbar (${r.fehler})`));
      continue;
    }
    if (r.status !== 200) {
      out.push(befund(`seite.${s.id}`, s.titel, 'alarm', `HTTP ${r.status}`));
      continue;
    }

    const schaden = KAPUTT.find((k) => k.re.test(r.text));
    if (schaden) {
      out.push(befund(`seite.${s.id}`, s.titel, 'alarm', schaden.was));
      continue;
    }
    if (r.groesse < s.minKb * 1024) {
      out.push(befund(`seite.${s.id}`, s.titel, 'alarm',
        `nur ${Math.round(r.groesse / 1024)} KB statt mindestens ${s.minKb} KB — Seite wirkt abgeschnitten`));
      continue;
    }
    if (!s.muss.test(r.text)) {
      out.push(befund(`seite.${s.id}`, s.titel, 'alarm', 'Seite lädt, aber der erwartete Inhalt fehlt'));
      continue;
    }

    // Tempo: nur melden, wenn es wirklich zäh wird. Der Konfigurator darf
    // langsamer sein als eine Textseite, deshalb eine großzügige Schwelle.
    const langsam = r.dauerMs > (ctx.cfg.shop.langsamMs ?? 6000);
    out.push(befund(`seite.${s.id}`, s.titel, langsam ? 'warn' : 'ok',
      langsam ? `antwortet in ${(r.dauerMs / 1000).toFixed(1)} s — ungewöhnlich träge`
              : `HTTP 200 in ${(r.dauerMs / 1000).toFixed(1)} s`));

    if (s.id === 'konfigurator') ctx.konfHtml = r.text; // spart dem nächsten Check den Abruf
  }

  // REST-Basis: ohne sie kann der Konfigurator weder Foto hochladen noch Versand rechnen.
  const rest = await holenWeich(`${basis}/wp-json/likoer24/v1/shipping`, { timeoutMs: ctx.cfg.shop.timeoutMs });
  // Ein GET auf einen POST-Endpunkt gibt 404/405 zurück — das ist der Beweis,
  // dass die Route registriert ist. 200 wäre auch in Ordnung. Nur ein
  // Totalausfall (0) oder ein 5xx ist ein echtes Problem.
  const restOk = rest.status > 0 && rest.status < 500;
  out.push(befund('rest', 'REST-Schnittstelle', restOk ? 'ok' : 'alarm',
    restOk ? `erreichbar (HTTP ${rest.status})` : `antwortet nicht (${rest.fehler || 'HTTP ' + rest.status})`));

  return out;
}
