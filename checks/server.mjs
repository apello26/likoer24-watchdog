/**
 * Was der Server über sich selbst verrät.
 *
 * Alles hier läuft über FTP und liest nur — der Watchdog fasst den Live-Shop
 * nicht an. Das error_log ist laut Erfahrung die erste Anlaufstelle bei
 * kritischen Fehlern, und der nächtliche "no space left on device" taucht
 * genau dort auf, bevor er als hängende Bestellung sichtbar wird.
 */

import { createHash } from 'node:crypto';
import { befund, ftpListe, ftpEnde, ftpDatei } from '../lib/kern.mjs';

export const name = 'Server';

const MONATE = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/**
 * Zeitstempel aus einer Logzeile. Zwei Formate, weil in dieser Datei zwei
 * Programme schreiben:
 *   Apache:  [Fri Aug 28 07:07:58.473080 2026]   ← auch alle PHP-Meldungen,
 *                                                  die über FastCGI kommen
 *   PHP:     [28-Aug-2026 07:07:12 Europe/Berlin]
 */
function zeitVon(zeile) {
  const a = zeile.match(/^\[\w{3} ([A-Za-z]{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)? (\d{4})\]/);
  if (a && a[1] in MONATE) {
    return new Date(Number(a[6]), MONATE[a[1]], Number(a[2]), Number(a[3]), Number(a[4]), Number(a[5]));
  }
  const p = zeile.match(/^\[(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  if (p && p[2] in MONATE) {
    return new Date(Number(p[3]), MONATE[p[2]], Number(p[1]), Number(p[4]), Number(p[5]), Number(p[6]));
  }
  return null;
}

/**
 * Meldungen vergleichbar und lesbar machen: Apache-Rahmen, Prozess-IDs,
 * Client-Adressen, Pfade und laufende Nummern raus, damit gleichartige
 * Fehler zu einer Gruppe zusammenfallen.
 */
function kern(zeile) {
  return zeile
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/\[pid [^\]]+\]\s*/, '')
    .replace(/\[client [^\]]+\]\s*/, '')
    .replace(/\[[a-z_]+:[a-z]+\]\s*/, '')
    .replace(/AH\d+: Got error '?PHP message: ?/, '')
    .replace(/\/[\w./-]+\.php(:\d+)?/g, '<datei>')
    .replace(/\b\d{3,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

const SCHWER = [
  { re: /No space left on device|Disk quota exceeded/i, id: 'platte',  titel: 'Speicherplatz', text: 'Server meldet volle Platte' },
  { re: /Allowed memory size of \d+ bytes exhausted/i,  id: 'speicher', titel: 'Arbeitsspeicher', text: 'PHP-Speicherlimit gesprengt' },
  { re: /Maximum execution time .* exceeded/i,          id: 'laufzeit', titel: 'Laufzeit', text: 'Skript in die Zeitbegrenzung gelaufen' },
  { re: /Error establishing a database connection|MySQL server has gone away|Can't create\/write to file/i,
    id: 'datenbank', titel: 'Datenbank', text: 'Datenbankfehler' },
];

export async function run(ctx) {
  const out = [];
  const ftp = ctx.cfg.ftp;
  const seit = Date.now() - (ctx.cfg.schwellen.logFensterStunden ?? 24) * 3600000;

  // ---- error_log -------------------------------------------------------------
  let zeilen = [];
  try {
    const dateien = await ftpListe(ftp, ftp.logPfad ?? '/logs/');
    const log = dateien.find((d) => d.name === 'error_log');
    if (!log) {
      out.push(befund('log', 'Fehlerprotokoll', 'warn', 'error_log nicht gefunden'));
    } else {
      const roh = await ftpEnde(ftp, (ftp.logPfad ?? '/logs/') + 'error_log', ctx.cfg.schwellen.logBytes ?? 400000, log.groesse);
      // Der erste Brocken ist meist eine angeschnittene Zeile — weg damit.
      zeilen = roh.split('\n').slice(1).filter((z) => z.trim());
      ctx.merken('log.groesse', log.groesse);
    }
  } catch (e) {
    out.push(befund('log', 'Fehlerprotokoll', 'warn', `nicht lesbar: ${e.message}`));
  }

  if (zeilen.length) {
    const mitZeit = zeilen.filter((z) => zeitVon(z));
    // Wenn kaum eine Zeile einen lesbaren Zeitstempel hat, hat sich das
    // Format geändert — dann sagt dieser Check nichts mehr aus und muss das
    // zugeben, statt beruhigend "keine Fehler" zu melden.
    if (mitZeit.length < zeilen.length * 0.5) {
      out.push(befund('logformat', 'Fehlerprotokoll', 'warn',
        `nur ${mitZeit.length} von ${zeilen.length} Zeilen lesbar — Logformat hat sich geändert, die Fehlerprüfung greift nicht mehr`,
        [zeilen[zeilen.length - 1]?.slice(0, 160) || '']));
    }
    const frisch = mitZeit.filter((z) => zeitVon(z).getTime() >= seit);
    const stunden = ctx.cfg.schwellen.logFensterStunden ?? 24;

    for (const art of SCHWER) {
      const treffer = frisch.filter((z) => art.re.test(z));
      if (treffer.length) {
        out.push(befund(art.id, art.titel, 'alarm',
          `${art.text} — ${treffer.length}× in ${stunden} h`,
          [...new Set(treffer.map(kern))].slice(0, 3)));
      }
    }

    const fatale = frisch.filter((z) => /PHP Fatal error|Uncaught (Error|Exception|TypeError)/i.test(z));
    const gruppen = [...fatale.reduce((m, z) => m.set(kern(z), (m.get(kern(z)) || 0) + 1), new Map())]
      .sort((a, b) => b[1] - a[1]);
    out.push(fatale.length
      ? befund('fatal', 'PHP-Abstürze', 'alarm',
          `${fatale.length} Fatal error(s) in ${stunden} h`,
          gruppen.slice(0, 3).map(([t, n]) => `${n}× ${t}`))
      : befund('fatal', 'PHP-Abstürze', 'ok', `keine Fatal errors unter ${frisch.length} Logzeilen der letzten ${stunden} h`));

    // Warnungen sind Alltag. Interessant ist erst der Ausschlag nach oben.
    const warnungen = frisch.filter((z) => /PHP (Warning|Notice|Deprecated)/i.test(z)).length;
    const d = ctx.drift('server.warnungen', warnungen);
    const vorher = Number(d.vorher);
    const sprung = Number.isFinite(vorher) && vorher > 0 && warnungen > Math.max(50, vorher * 3);
    out.push(befund('warnungen', 'PHP-Warnungen', sprung ? 'warn' : 'ok',
      sprung ? `${warnungen} Warnungen in ${stunden} h — gestern waren es ${vorher}`
             : `${warnungen} Warnungen in ${stunden} h${Number.isFinite(vorher) ? ` (gestern ${vorher})` : ''}`));
  }

  // ---- Dateien auf dem Server -------------------------------------------------
  const wpRoot = ftp.docroot ?? '/httpdocs';
  try {
    const root = await ftpListe(ftp, wpRoot);
    if (root.some((d) => d.name === '.maintenance')) {
      out.push(befund('wartung', 'Wartungsmodus', 'alarm',
        '.maintenance liegt im Web-Verzeichnis — Besucher sehen die Wartungsseite'));
    }

    const pluginOrdner = `${wpRoot}/wp-content/plugins/likoer24-konfigurator/`;
    const plugin = await ftpListe(ftp, pluginOrdner);
    const haupt = plugin.find((d) => d.name === 'likoer24-konfigurator.php');
    if (!haupt) {
      out.push(befund('plugindatei', 'Plugin auf dem Server', 'alarm',
        'likoer24-konfigurator.php fehlt im Plugin-Ordner'));
    } else {
      // Der Zeitstempel allein sagt wenig: ein erneuter Upload derselben Datei
      // setzt ihn neu, ohne dass sich etwas geändert hätte. Deshalb zählt der
      // Inhalt. (Die Zeit im FTP-Listing ist UTC, im Sommer also zwei Stunden
      // hinter der Uhr hier — sie steht nur als Anhaltspunkt dabei.)
      const inhalt = await ftpDatei(ftp, pluginOrdner + 'likoer24-konfigurator.php');
      const hash = createHash('sha256').update(inhalt).digest('hex').slice(0, 12);
      const version = (inhalt.match(/^\s*\*\s*Version:\s*([0-9.]+)/m) || [])[1] || '?';
      const dh = ctx.drift('server.pluginHash', hash);
      const dz = ctx.drift('server.pluginZeit', `${haupt.groesse}@${haupt.zeitRoh}`);

      if (dh.geaendert && dh.vorher) {
        out.push(befund('plugindatei', 'Plugin auf dem Server', 'info',
          `likoer24-konfigurator.php hat einen neuen Inhalt (Version ${version}, ${haupt.groesse} Bytes, ${haupt.zeitRoh} UTC)`));
      } else if (dz.geaendert && dz.vorher) {
        out.push(befund('plugindatei', 'Plugin auf dem Server', 'ok',
          `neu hochgeladen, Inhalt unverändert (Version ${version})`));
      } else {
        out.push(befund('plugindatei', 'Plugin auf dem Server', 'ok',
          `Version ${version}, unverändert seit ${haupt.zeitRoh} UTC`));
      }
    }
  } catch (e) {
    out.push(befund('dateien', 'Dateien auf dem Server', 'warn', `Verzeichnis nicht lesbar: ${e.message}`));
  }

  // ---- Aufräumen im Upload-Ordner ---------------------------------------------
  // Kundenfotos werden nach einer Woche gelöscht. Bleibt der Ordner voll,
  // läuft entweder das Aufräumen nicht — oder die Platte wieder voll.
  try {
    const uploads = await ftpListe(ftp, `${wpRoot}/wp-content/uploads/konfigurator/`);
    if (ctx.notizen) ctx.notizen.uploads = uploads; // der Funnel-Check zählt darin die Druckfreigaben
    const lose = uploads.filter((d) => !d.istOrdner).length;
    const grenze = ctx.cfg.schwellen.uploadsWarn ?? 4000;
    out.push(lose > grenze
      ? befund('uploads', 'Upload-Ordner', 'warn',
          `${lose} lose Dateien im Konfigurator-Upload — das Aufräumen scheint zu hängen`)
      : befund('uploads', 'Upload-Ordner', 'ok', `${lose} lose Dateien, ${uploads.length - lose} Bestellordner`));
    ctx.merken('uploads.lose', lose);
  } catch (e) {
    out.push(befund('uploads', 'Upload-Ordner', 'warn', `nicht lesbar: ${e.message}`));
  }

  return out;
}
