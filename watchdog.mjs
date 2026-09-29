#!/usr/bin/env node
/**
 * Likoer24-Watchdog — täglicher Rundgang durch den Laden.
 *
 * Liest nur. Er ändert nichts am Shop, deployt nichts und schreibt nichts in
 * die Datenbank — das ist Absicht: ein Wächter, der selbst eingreifen darf,
 * kann nachts auch selbst etwas kaputt machen. Er sammelt Befunde, legt sie
 * fürs Dashboard ab und meldet nur, was sich seit gestern geändert hat.
 *
 * Aufruf:
 *   node watchdog.mjs                  vollständiger Lauf, meldet Änderungen
 *   node watchdog.mjs --kein-push      ohne Telegram (zum Ausprobieren)
 *   node watchdog.mjs --nur=server     nur eine Gruppe
 *   node watchdog.mjs --nur=consent    nur der Consent-Leck-Test (Browser)
 *   node watchdog.mjs --json           nur das Ergebnis als JSON auf stdout
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schlimmster, jetztText } from './lib/kern.mjs';
import { unterschied, nachrichtBauen, senden } from './lib/melden.mjs';

const HIER = dirname(fileURLToPath(import.meta.url));
const STAND = join(HIER, 'state');
const LETZTER = join(STAND, 'latest.json');
const VERLAUF = join(STAND, 'history.jsonl');
const BASIS = join(STAND, 'baseline.json');

// Ein Wächter darf an einer verirrten Zurückweisung nicht sterben — sie wird
// protokolliert, der Lauf geht weiter.
process.on('unhandledRejection', (e) => { console.error('Unbehandelte Zurückweisung:', e?.message || e); });

const args = process.argv.slice(2);
const hat = (f) => args.includes(f);
const wert = (f) => (args.find((a) => a.startsWith(f + '=')) || '').split('=')[1] || null;
const NUR = wert('--nur');
const STILL = hat('--json');

const GRUPPEN = [
  { id: 'erreichbarkeit', modul: './checks/erreichbarkeit.mjs' },
  { id: 'konfigurator',   modul: './checks/konfigurator.mjs' },
  { id: 'bestellungen',   modul: './checks/bestellungen.mjs' },
  { id: 'server',         modul: './checks/server.mjs' },
  // Funnel nach Server: nutzt dessen Upload-Listing mit, statt es noch einmal zu holen.
  { id: 'funnel',         modul: './checks/funnel.mjs' },
  { id: 'seo',            modul: './checks/seo.mjs' },
  // Zuletzt, weil er einen echten Browser startet und am längsten braucht.
  { id: 'klickpfad',      modul: './checks/klickpfad.mjs' },
  // Ebenfalls Browser: Tracker ohne Einwilligung, „Ablehnen", Gegenprobe mit „Ok",
  // Teil-Einwilligungen (nur Statistik / nur Marketing).
  { id: 'consent',        modul: './checks/consent-leck.mjs' },
];

function jsonLesen(pfad, standard = null) {
  try { return JSON.parse(readFileSync(pfad, 'utf8')); } catch { return standard; }
}

/**
 * Die Zugangsdaten für WooCommerce stehen schon in der Dashboard-Konfiguration.
 * Sie ein zweites Mal zu pflegen wäre eine Fehlerquelle — also erben wir sie,
 * falls die eigene Konfiguration nichts anderes sagt.
 */
function konfigLaden() {
  const eigen = jsonLesen(join(HIER, 'config.json'));
  if (!eigen) {
    console.error('config.json fehlt. Vorlage: cp config.example.json config.json');
    process.exit(2);
  }
  // Mehrere Kandidaten, damit dieselbe Konfiguration auf dem Mac (Arbeitskopie)
  // und auf dem Pi (Betrieb) funktioniert.
  if (eigen.dashboardConfig) {
    for (const kandidat of [].concat(eigen.dashboardConfig)) {
      const dash = jsonLesen(kandidat.replace(/^~/, process.env.HOME || ''));
      if (!dash) continue;
      if (!eigen.woocommerce?.ck && dash.woocommerce?.ck) eigen.woocommerce = dash.woocommerce;
      // Den Analytics-Zugang (Schrittquoten im Funnel-Check) genauso erben.
      if (!eigen.analytics?.appPassword && dash.analytics?.appPassword) eigen.analytics = dash.analytics;
      if (eigen.woocommerce?.ck && eigen.analytics?.appPassword) break;
    }
  }
  if (!eigen.woocommerce?.ck) {
    console.error('Keine WooCommerce-Zugangsdaten — weder in config.json noch in der Dashboard-Konfiguration.');
    process.exit(2);
  }
  return eigen;
}

async function lauf() {
  const cfg = konfigLaden();
  const baseline = jsonLesen(BASIS, {});
  const neueBaseline = { ...baseline };
  const merkzettel = {};

  // Der Kontext wandert durch alle Checks: gemeinsame Konfiguration, das
  // Gedächtnis für Drift-Vergleiche und ein paar Zwischenergebnisse, damit
  // die Konfigurator-Seite nicht dreimal geladen wird.
  const ctx = {
    cfg,
    konfHtml: null,
    boot: null,
    // Zwischenergebnisse für spätere Checks (Deploy-Zeitpunkt, Upload-Listing),
    // damit niemand dieselbe Liste zweimal holt.
    notizen: {},
    // Gedächtnis nur lesen — drift() setzt immer den neuen Wert.
    gemerkt: (schluessel) => baseline[schluessel],
    merken: (schluessel, w) => { merkzettel[schluessel] = w; },
    drift(schluessel, w) {
      const vorher = baseline[schluessel];
      neueBaseline[schluessel] = w;
      return { geaendert: vorher !== undefined && String(vorher) !== String(w), vorher };
    },
  };

  const gruppen = [];
  for (const g of GRUPPEN) {
    if (NUR && g.id !== NUR) continue;
    const t0 = Date.now();
    try {
      const modul = await import(g.modul);
      const befunde = await modul.run(ctx);
      gruppen.push({
        id: g.id, titel: modul.name, dauerMs: Date.now() - t0,
        status: schlimmster(...befunde.map((b) => b.status)), befunde,
      });
    } catch (e) {
      // Ein abgestürzter Check ist selbst ein Befund — und darf die anderen
      // nicht mitreißen.
      gruppen.push({
        id: g.id, titel: g.id, dauerMs: Date.now() - t0, status: 'warn',
        befunde: [{ id: 'absturz', titel: 'Prüfung abgebrochen', status: 'warn', text: e.message }],
      });
    }
  }

  const alle = gruppen.flatMap((g) => g.befunde);
  const zahlen = { ok: 0, info: 0, warn: 0, alarm: 0 };
  for (const b of alle) zahlen[b.status]++;

  return {
    ergebnis: {
      zeit: new Date().toISOString(),
      zeitText: jetztText(),
      status: schlimmster(...alle.map((b) => b.status)),
      zahlen,
      dauerMs: gruppen.reduce((s, g) => s + g.dauerMs, 0),
      gruppen,
      messwerte: merkzettel,
    },
    neueBaseline,
  };
}

function ausgeben(e) {
  const zeichen = { ok: '  ok  ', info: ' info ', warn: ' WARN ', alarm: 'ALARM ' };
  console.log(`\nLikoer24-Watchdog — ${e.zeitText}   Gesamt: ${e.status.toUpperCase()}`);
  for (const g of e.gruppen) {
    console.log(`\n${g.titel}  (${(g.dauerMs / 1000).toFixed(1)} s)`);
    for (const b of g.befunde) {
      console.log(`  [${zeichen[b.status]}] ${b.titel}: ${b.text}`);
      for (const d of b.details || []) console.log(`             – ${typeof d === 'string' ? d : JSON.stringify(d)}`);
    }
  }
  console.log(`\n${e.zahlen.ok} ok · ${e.zahlen.info} Hinweis(e) · ${e.zahlen.warn} Warnung(en) · ${e.zahlen.alarm} Alarm(e)\n`);
}

// ---- Hauptlauf ----------------------------------------------------------------

mkdirSync(STAND, { recursive: true });
const vorher = existsSync(LETZTER) ? jsonLesen(LETZTER) : null;
const { ergebnis, neueBaseline } = await lauf();

if (STILL) {
  console.log(JSON.stringify(ergebnis, null, 2));
} else {
  ausgeben(ergebnis);
}

// Ein Teillauf (--nur=…) darf den Gesamtstand nicht überschreiben, sonst gilt
// alles Ungeprüfte plötzlich als verschwunden.
if (!NUR) {
  writeFileSync(LETZTER, JSON.stringify(ergebnis, null, 2));
  writeFileSync(BASIS, JSON.stringify(neueBaseline, null, 2));
  appendFileSync(VERLAUF, JSON.stringify({
    zeit: ergebnis.zeit, status: ergebnis.status, zahlen: ergebnis.zahlen,
    probleme: ergebnis.gruppen.flatMap((g) => g.befunde.filter((b) => b.status === 'warn' || b.status === 'alarm').map((b) => `${g.id}.${b.id}`)),
    messwerte: ergebnis.messwerte,
  }) + '\n');
}

const diff = unterschied(ergebnis, vorher);
// Die Grundregel „nur Veränderung melden" bleibt. Aber ein Alarm, der steht,
// kostet weiter Geld — der wird nach einem Tag noch einmal erinnert, statt
// nach der ersten Meldung zwischen den Warnungen zu verschwinden. (Vom 03. bis
// 06.09.2026 blieb genau so eine Meldung liegen.)
const MELDUNG = join(STAND, 'letzte-meldung.json');
const letzteMeldung = jsonLesen(MELDUNG, {});
const stundenSeitMeldung = letzteMeldung.zeit ? (Date.now() - new Date(letzteMeldung.zeit).getTime()) / 3600000 : Infinity;
const erinnerungFaellig = diff.weiterhin.length > 0 && stundenSeitMeldung >= 20;
const meldenswert = diff.neu.length || diff.behoben.length || diff.veraendert.length || erinnerungFaellig;
if (!meldenswert) {
  if (!STILL) console.log('Nichts Neues seit dem letzten Lauf — keine Meldung nötig.');
} else if (hat('--kein-push')) {
  if (!STILL) console.log(`Meldung unterdrückt (--kein-push): ${diff.neu.length} neu, ${diff.veraendert.length} verändert, ${diff.behoben.length} behoben, ${diff.weiterhin.length} Alarm(e) weiter offen.`);
} else {
  const r = await senden(nachrichtBauen(ergebnis, diff, { erinnerung: erinnerungFaellig }));
  if (!STILL) console.log(r.gesendet ? 'Meldung verschickt.' : `Keine Meldung verschickt: ${r.grund}`);
  if (r.gesendet && !NUR) writeFileSync(MELDUNG, JSON.stringify({ zeit: new Date().toISOString() }));
}
