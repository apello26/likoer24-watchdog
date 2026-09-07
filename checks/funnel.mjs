/**
 * Funnel-Vitalzeichen — kommt noch jemand bis zum Warenkorb?
 *
 * Der Bestellstrom allein ist ein träges Signal: bei einer Bestellung pro Tag
 * dauert es Tage, bis „nichts kommt" statistisch auffällt. Vom 03. bis
 * 06.09.2026 hat genau das vier Tage gekostet. Dieser Check schaut eine Stufe
 * früher hin, und zwar an zwei Stellen, die sich gegenseitig absichern:
 *
 *  1. Warenkorb-Anlagen aus dem Upload-Ordner. Jede Druckfreigabe lädt ein
 *     Vorschau-Bild hoch (preview-<uuid>.png). Die Zeitstempel im FTP-Listing
 *     zeigen also ohne Consent, ohne Cookie und ohne Tracker, wie viele Kunden
 *     heute bis zur Druckfreigabe gekommen sind — verglichen mit den Tagen davor.
 *
 *  2. Schrittquoten je Gerät aus dem eigenen Analytics-Plugin: Wie viele
 *     Handy-Sessions, die Schritt 1 abgeschlossen haben, kommen über Schritt 2
 *     hinaus? Der Vergleich mit den zwei Wochen davor zeigt einen Einbruch
 *     lange bevor er sich in Bestellungen niederschlägt. (Nur Sessions mit
 *     Consent, deshalb kleinere Zahlen — für die Quote reicht das.)
 *
 * Nach einem Deploy schaut er genauer hin: Alles, was seit dem Versionswechsel
 * passiert ist, wird gesondert gegen die Zeit davor gehalten. So bekommt ein
 * Deploy, der den Funnel bricht, innerhalb von 12 bis 24 Stunden einen Namen.
 */

import { befund, ftpListe } from '../lib/kern.mjs';

export const name = 'Funnel';

const MONATE = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/**
 * FTP-Zeitstempel („Sep  6 19:00" oder „May 31  2025") → Date (UTC). Ohne Jahr
 * meint der Server das laufende Jahr; liegt das in der Zukunft, war es letztes Jahr.
 */
export function ftpZeit(roh) {
  const m = String(roh).match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(?:(\d{2}):(\d{2})|(\d{4}))$/);
  if (!m || !(m[1] in MONATE)) return null;
  const jetzt = new Date();
  if (m[5]) return new Date(Date.UTC(Number(m[5]), MONATE[m[1]], Number(m[2])));
  let d = new Date(Date.UTC(jetzt.getUTCFullYear(), MONATE[m[1]], Number(m[2]), Number(m[3]), Number(m[4])));
  if (d.getTime() - jetzt.getTime() > 86400000) d = new Date(Date.UTC(jetzt.getUTCFullYear() - 1, MONATE[m[1]], Number(m[2]), Number(m[3]), Number(m[4])));
  return d;
}

/** P(X ≤ k) für X ~ Binomial(n, p) — ohne Bibliothek, für n bis ein paar Hundert. */
export function binomialBis(k, n, p) {
  if (n <= 0) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let pmf = Math.pow(1 - p, n);
  let summe = pmf;
  for (let i = 0; i < k && i < n; i++) {
    pmf *= ((n - i) / (i + 1)) * (p / (1 - p));
    summe += pmf;
  }
  return Math.min(1, summe);
}

const prozent = (x) => `${Math.round(x * 100)} %`;
const wahrsch = (p) => (p < 0.001 ? '< 0,1 %' : `${(p * 100).toFixed(p < 0.01 ? 1 : 0).replace('.', ',')} %`);

/** Zeit als 'YYYY-MM-DD HH:MM:SS' in Europe/Berlin — so will es die Analytics-Schnittstelle. */
function anZeit(d) {
  const teile = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((o, t) => (o[t.type] = t.value, o), {});
  return `${teile.year}-${teile.month}-${teile.day} ${teile.hour === '24' ? '00' : teile.hour}:${teile.minute}:${teile.second}`;
}

async function geraeteQuoten(an, von, bis) {
  const url = `${an.base.replace(/\/+$/, '')}/stats/devices?from=${encodeURIComponent(anZeit(von))}&to=${encodeURIComponent(anZeit(bis))}`;
  const auth = Buffer.from(`${an.user}:${an.appPassword}`).toString('base64');
  const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`Analytics antwortet mit HTTP ${r.status}`);
  const j = await r.json();
  const out = {};
  for (const z of j.rows || []) {
    out[z.device] = Object.fromEntries(Object.entries(z).map(([k, v]) => [k, k === 'device' ? v : Number(v) || 0]));
  }
  return out;
}

export async function run(ctx) {
  const out = [];
  const cfg = ctx.cfg.funnel || {};
  const jetzt = Date.now();
  const deploy = ctx.notizen?.deploy;
  const deployAktiv = deploy && !deploy.unsicher && deploy.stunden >= (cfg.deployAbStunden ?? 6) && deploy.stunden <= (cfg.deployFensterStunden ?? 96);
  const deployText = deployAktiv ? `seit dem Deploy von ${deploy.version} vor ${Math.round(deploy.stunden)} h` : '';

  // ---- 1. Warenkorb-Anlagen (Vorschau-Uploads) ------------------------------------
  let liste = ctx.notizen?.uploads || null;
  if (!liste) {
    try {
      liste = await ftpListe(ctx.cfg.ftp, `${ctx.cfg.ftp.docroot ?? '/httpdocs'}/wp-content/uploads/konfigurator/`);
    } catch (e) {
      out.push(befund('anlagen', 'Warenkorb-Anlagen', 'warn', `Upload-Ordner nicht lesbar: ${e.message}`));
    }
  }
  if (liste) {
    const zeiten = liste
      .filter((d) => !d.istOrdner && /^preview-[a-f0-9-]{20,}\.png$/i.test(d.name))
      .map((d) => ftpZeit(d.zeitRoh)).filter(Boolean).map((d) => d.getTime());
    const zwischen = (vonH, bisH) => zeiten.filter((t) => jetzt - t >= vonH * 3600000 && jetzt - t < bisH * 3600000).length;

    const basisTage = cfg.basisTage ?? 5;                 // 2–7 Tage zurück: alles noch da (Aufräumen greift nach 7 Tagen)
    const proTag = zwischen(48, 48 + basisTage * 24) / basisTage;
    const h24 = zwischen(0, 24), h48 = zwischen(0, 48);
    const erwartet48 = proTag * 2;
    const p0 = Math.exp(-erwartet48);                     // Poisson: Wahrscheinlichkeit für null Anlagen in 48 h
    ctx.merken('funnel.anlagen24h', h24);
    ctx.merken('funnel.anlagenProTag', Math.round(proTag * 10) / 10);

    const lage = `${h24} in 24 h, ${h48} in 48 h — üblich ${proTag.toFixed(1)} pro Tag`;
    if (proTag >= (cfg.mindestProTag ?? 1) && h48 === 0 && p0 < (cfg.alarmWahrscheinlichkeit ?? 0.05)) {
      out.push(befund('anlagen', 'Warenkorb-Anlagen', 'alarm',
        `seit 48 h keine einzige Druckfreigabe — ${lage} (so eine Pause: ${wahrsch(p0)}) — Konfigurator auf dem Handy prüfen`));
    } else if (erwartet48 >= 4 && h48 < erwartet48 * (cfg.warnAnteil ?? 0.35)) {
      out.push(befund('anlagen', 'Warenkorb-Anlagen', 'warn', `deutlich weniger Druckfreigaben als sonst: ${lage}`));
    } else {
      out.push(befund('anlagen', 'Warenkorb-Anlagen', 'ok', lage));
    }

    if (deployAktiv) {
      const seitDeploy = zwischen(0, deploy.stunden);
      const erwartet = proTag * deploy.stunden / 24;
      const pNull = Math.exp(-erwartet);
      if (seitDeploy === 0 && erwartet >= (cfg.deployErwartetMin ?? 2) && pNull < (cfg.alarmWahrscheinlichkeit ?? 0.05)) {
        out.push(befund('anlagen.deploy', 'Warenkorb seit Deploy', 'alarm',
          `${deployText} keine einzige Druckfreigabe, erwartet wären etwa ${erwartet.toFixed(1)} (so eine Pause: ${wahrsch(pNull)}) — der Deploy ist der erste Verdächtige`));
      } else if (erwartet >= 4 && seitDeploy < erwartet * (cfg.warnAnteil ?? 0.35)) {
        out.push(befund('anlagen.deploy', 'Warenkorb seit Deploy', 'warn',
          `${deployText} nur ${seitDeploy} Druckfreigabe(n), erwartet wären etwa ${erwartet.toFixed(1)}`));
      } else {
        out.push(befund('anlagen.deploy', 'Warenkorb seit Deploy', 'ok', `${deployText} ${seitDeploy} Druckfreigabe(n), erwartet etwa ${erwartet.toFixed(1)}`));
      }
    }
  }

  // ---- 2. Schrittquoten je Gerät (Analytics) --------------------------------------
  const an = ctx.cfg.analytics;
  if (!an?.appPassword || !an?.base) {
    out.push(befund('quoten', 'Schrittquoten', 'info', 'keine Analytics-Zugangsdaten — Quoten-Vergleich läuft nicht (dashboardConfig prüfen)'));
    return out;
  }

  try {
    const fensterH = cfg.fensterStunden ?? 48;
    const basisTageQ = cfg.basisTageQuoten ?? 14;
    const aktuell = await geraeteQuoten(an, new Date(jetzt - fensterH * 3600000), new Date(jetzt));
    const basis = await geraeteQuoten(an, new Date(jetzt - (basisTageQ + 2) * 86400000), new Date(jetzt - fensterH * 3600000));

    // Die Übergänge, die den Ausfall damals sichtbar gemacht hätten — allen voran
    // „Schritt 2 überstanden" (Handy: 35 % → 3 %). step2_done liefert das
    // Analytics-Plugin ab 0.7.4; fehlt das Feld, wird die Stufe übersprungen.
    const stufen = [
      { id: 'schritt2',      titel: 'Schritt 2 überstanden',      von: 'step1_done',   nach: 'step2_done' },
      { id: 'druckfreigabe', titel: 'Bis zur Druckfreigabe',      von: 'step1_done',   nach: 'step3_done' },
      { id: 'warenkorb',     titel: 'Druckfreigabe → Warenkorb',  von: 'step3_done',   nach: 'cart_added' },
      { id: 'einstieg',      titel: 'Erster Schritt',             von: 'konfigurator', nach: 'step1_done' },
    ];
    const geraete = ['mobile', 'desktop'];
    const mindest = cfg.mindestSessions ?? 8;
    const zeilen = [];
    let schlimmster = 'ok';
    const rang = { ok: 0, warn: 1, alarm: 2 };

    for (const st of stufen) {
      for (const g of geraete) {
        const a = aktuell[g] || {}, b = basis[g] || {};
        if (a[st.nach] === undefined && b[st.nach] === undefined) continue; // Feld gibt es (noch) nicht
        const n = a[st.von] || 0, k = a[st.nach] || 0;
        const nB = b[st.von] || 0, kB = b[st.nach] || 0;
        if (nB < 20 || n < mindest) continue;          // zu wenig Daten für eine Aussage
        const p = kB / nB;
        if (p < (cfg.mindestQuote ?? 0.08)) continue;   // eine Stufe, die ohnehin fast niemand nimmt, sagt nichts
        const pv = binomialBis(k, n, p);
        const erwartet = n * p;
        let status = 'ok';
        if (pv < (cfg.alarmP ?? 0.03) && k <= erwartet * 0.4) status = 'alarm';
        else if (pv < (cfg.warnP ?? 0.12) && k <= erwartet * 0.6) status = 'warn';
        if (rang[status] > rang[schlimmster]) schlimmster = status;
        const geraet = g === 'mobile' ? 'Handy' : 'Desktop';
        zeilen.push({ status, text: `${st.titel} ${geraet}: ${k} von ${n} (${prozent(k / n)}), üblich ${prozent(p)} — Zufall: ${wahrsch(pv)}` });
      }
    }

    if (!zeilen.length) {
      out.push(befund('quoten', 'Schrittquoten', 'ok', `zu wenig Sessions in ${fensterH} h für einen Vergleich (unter ${mindest} je Stufe)`));
    } else {
      const auffaellig = zeilen.filter((z) => z.status !== 'ok');
      out.push(befund('quoten', 'Schrittquoten', schlimmster,
        schlimmster === 'ok'
          ? `alle Stufen im üblichen Rahmen (${fensterH} h gegen ${basisTageQ} Tage davor)`
          : `${auffaellig.length} Stufe(n) eingebrochen: ${auffaellig.map((z) => z.text).join(' · ')}`,
        zeilen.map((z) => `${z.status === 'ok' ? 'ok' : z.status.toUpperCase()}: ${z.text}`)));
    }

    if (deployAktiv && deploy.stunden >= (cfg.deployQuotenAbStunden ?? 12)) {
      const seit = await geraeteQuoten(an, new Date(jetzt - deploy.stunden * 3600000), new Date(jetzt));
      const a = seit.mobile || {}, b = basis.mobile || {};
      // Schritt 2 überstanden (ab Analytics 0.7.4), sonst „bis zur Druckfreigabe".
      const feld = a.step2_done !== undefined ? 'step2_done' : 'step3_done';
      const n = a.step1_done || 0, k = a[feld] || 0, nB = b.step1_done || 0, kB = b[feld] || 0;
      if (nB >= 20 && n >= (cfg.deployMindestSessions ?? 6)) {
        const p = kB / nB, pv = binomialBis(k, n, p);
        const status = pv < (cfg.alarmP ?? 0.03) && k <= n * p * 0.4 ? 'alarm' : pv < (cfg.warnP ?? 0.12) && k <= n * p * 0.6 ? 'warn' : 'ok';
        const was = feld === 'step2_done' ? 'über Schritt 2 hinaus' : 'bis zur Druckfreigabe';
        out.push(befund('quoten.deploy', 'Handy-Funnel seit Deploy', status,
          `${deployText}: ${k} von ${n} Handy-Sessions ${was} (${prozent(k / n)}), davor ${prozent(p)} — Zufall: ${wahrsch(pv)}`
          + (status === 'alarm' ? ' — Deploy zurücknehmen oder Klickpfad-Befund lesen' : '')));
      }
    }
  } catch (e) {
    out.push(befund('quoten', 'Schrittquoten', 'warn', `Analytics nicht lesbar: ${e.message}`));
  }

  return out;
}
