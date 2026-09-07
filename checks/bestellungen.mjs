/**
 * Läuft der Bestellstrom — und läuft er durch?
 *
 * Zwei Fragen: Kommt überhaupt noch etwas rein (ein Funnel, der still
 * ausfällt, sieht von außen aus wie ein ruhiger Tag)? Und wandert jede
 * bezahlte Bestellung sauber durch die Kette Druck-PDF → Bestandsbuchung
 * → Versand? Die Meta-Felder der Bestellung verraten das genau.
 */

import { befund, stundenSeit } from '../lib/kern.mjs';

export const name = 'Bestellungen';

const OFFEN = ['pending', 'on-hold'];
const BEZAHLT = ['processing', 'completed'];

async function wcHolen(cfg, pfad) {
  const url = `${cfg.woocommerce.url}/wp-json/wc/v3${pfad}`;
  const auth = Buffer.from(`${cfg.woocommerce.ck}:${cfg.woocommerce.cs}`).toString('base64');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 45000);
  try {
    const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` }, signal: ac.signal });
    if (!r.ok) throw new Error(`WooCommerce antwortet mit HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const meta = (o, key) => (o.meta_data || []).find((m) => m.key === key)?.value ?? null;
const wahrsch = (p) => (p < 0.001 ? '< 0,1 %' : `${(p * 100).toFixed(p < 0.01 ? 1 : 0).replace('.', ',')} %`);
const gesetzt = (o, key) => { const v = meta(o, key); return v !== null && v !== '' && v !== '0'; };
const idListe = (arr, max = 8) =>
  arr.slice(0, max).map((o) => `#${o.number || o.id}`).join(', ') + (arr.length > max ? ` … (+${arr.length - max})` : '');

export async function run(ctx) {
  const out = [];
  const s = ctx.cfg.schwellen;
  const felder = '_fields=id,number,status,date_created,date_paid,date_modified,total,payment_method_title,created_via,billing,meta_data';
  const bestellungen = await wcHolen(ctx.cfg, `/orders?per_page=60&status=any&orderby=date&order=desc&${felder}`);

  // Entwürfe zählen nicht — das sind angefangene Warenkörbe, keine Bestellungen.
  const echte = bestellungen.filter((o) => o.status !== 'checkout-draft' && o.status !== 'trash');
  if (!echte.length) {
    return [befund('strom', 'Bestellstrom', 'warn', 'keine Bestellungen in der Antwort der Schnittstelle')];
  }

  // ---- Kommt noch etwas rein? -----------------------------------------------
  const letzte = echte[0];
  const stillH = stundenSeit(letzte.date_created);

  // Was "normal" ist, ergibt sich aus dem eigenen Verlauf: der mittlere Abstand
  // der letzten 30 Bestellungen. Eine feste Stundenzahl wäre im Sommer ständig
  // rot und im Dezember blind. Das Mittel, nicht der Median: Bestellungen
  // kommen wie zufällige Ereignisse, und der Median unterschätzt die normale
  // Pause dann systematisch — der alte Alarm bei 8× Median sprang erst nach
  // fünf Tagen an (03.–06.09.2026: 95 h Stille blieben eine gelbe Warnung).
  const n = Math.min(echte.length, 31);
  const spanneH = n > 1 ? stundenSeit(echte[n - 1].date_created) - stundenSeit(echte[0].date_created) : 24;
  const mittel = n > 1 ? Math.max(1, spanneH / (n - 1)) : 24;
  // Wie wahrscheinlich ist eine Pause dieser Länge, wenn alles normal läuft?
  // (Poisson: exp(−Pause / mittlerer Abstand)). Warnung ab 10 %, Alarm ab 5 %,
  // nie vor den Mindeststunden aus der Konfiguration.
  const pPause = Math.exp(-stillH / mittel);
  const warnAb = Math.max(s.stilleWarnStunden ?? 36, -Math.log(s.stilleWarnP ?? 0.10) * mittel);
  const alarmAb = Math.max(s.stilleAlarmStunden ?? 72, -Math.log(s.stilleAlarmP ?? 0.05) * mittel);
  const deploy = ctx.notizen?.deploy;
  const deployHinweis = deploy && !deploy.unsicher && deploy.stunden <= 120 && deploy.stunden > stillH - 24
    ? ` — die Pause begann ${Math.round(Math.max(0, deploy.stunden - stillH))} h nach dem Deploy von ${deploy.version}`
    : '';
  ctx.merken('bestellungen.stilleH', Math.round(stillH));
  ctx.merken('bestellungen.mittelH', Math.round(mittel * 10) / 10);

  out.push(
    stillH > alarmAb
      ? befund('strom', 'Bestellstrom', 'alarm',
          `seit ${Math.round(stillH)} h keine Bestellung (zuletzt etwa alle ${mittel.toFixed(1)} h; so eine Pause: ${wahrsch(pPause)})${deployHinweis} — Funnel und Klickpfad prüfen`)
      : stillH > warnAb
        ? befund('strom', 'Bestellstrom', 'warn',
            `seit ${Math.round(stillH)} h keine Bestellung (zuletzt etwa alle ${mittel.toFixed(1)} h; so eine Pause: ${wahrsch(pPause)})${deployHinweis}`)
        : befund('strom', 'Bestellstrom', 'ok',
            `letzte Bestellung vor ${stillH < 1 ? Math.round(stillH * 60) + ' min' : Math.round(stillH) + ' h'} (#${letzte.number || letzte.id}), zuletzt etwa alle ${mittel.toFixed(1)} h`));

  // ---- Hängengebliebene ------------------------------------------------------
  const haengend = echte.filter((o) => OFFEN.includes(o.status) && stundenSeit(o.date_created) > (s.haengendStunden ?? 48));
  out.push(haengend.length
    ? befund('haengend', 'Unbezahlte Bestellungen', 'warn',
        `${haengend.length} seit über ${s.haengendStunden ?? 48} h offen: ${idListe(haengend)}`,
        haengend.map((o) => ({ id: o.id, nummer: o.number, status: o.status, alterH: Math.round(stundenSeit(o.date_created)), betrag: o.total })))
    : befund('haengend', 'Unbezahlte Bestellungen', 'ok', 'keine Altlasten offen'));

  // ---- Druck-PDF -------------------------------------------------------------
  // Karenzzeit, weil das PDF erst nach der Zahlung erzeugt wird und das ein
  // paar Minuten dauern darf.
  const reif = echte.filter((o) => BEZAHLT.includes(o.status) && o.date_paid && stundenSeit(o.date_paid) > (s.pdfKarenzStunden ?? 1));
  const ohnePdfRoh = reif.filter((o) => !gesetzt(o, '_lk24_pdf_generated_at'));

  // Von Hand im Backend angelegte Bestellungen (Großkunden, Angebote) sind nie
  // durch den Konfigurator gelaufen und haben deshalb gar keine Etikettdaten —
  // für sie kann es kein PDF geben. Sie sind kein Fehler, aber sie brauchen
  // Handarbeit, also gehören sie sichtbar auf die Liste statt in den Papierkorb.
  // Zur Sicherheit sehen wir für jede solche Bestellung einmal nach, ob doch
  // eine Konfiguration daranhängt — dann wäre das fehlende PDF ein echter Fehler.
  const ohnePdf = [], sonder = [];
  for (const o of ohnePdfRoh) {
    if (o.created_via !== 'admin') { ohnePdf.push(o); continue; }
    let hatKonfig = false;
    try {
      const voll = await wcHolen(ctx.cfg, `/orders/${o.id}?_fields=line_items`);
      hatKonfig = (voll.line_items || []).some((li) => (li.meta_data || []).some((m) => m.key === '_lk24_konfig_raw' && m.value));
    } catch (_) { /* im Zweifel als Sonderbestellung führen, nicht als Alarm */ }
    (hatKonfig ? ohnePdf : sonder).push(o);
  }

  out.push(ohnePdf.length
    ? befund('pdf', 'Druck-PDF', 'alarm',
        `${ohnePdf.length} Konfigurator-Bestellung(en) ohne Druck-PDF: ${idListe(ohnePdf)}`,
        ohnePdf.map((o) => ({ id: o.id, nummer: o.number, bezahltVorH: Math.round(stundenSeit(o.date_paid)) })))
    : befund('pdf', 'Druck-PDF', 'ok', `alle ${reif.length - sonder.length} Konfigurator-Bestellungen haben ihr PDF`));

  if (sonder.length) {
    out.push(befund('sonder', 'Sonderbestellungen', 'info',
      `${sonder.length} von Hand angelegte Bestellung(en) — Etiketten laufen außerhalb des Konfigurators: ${idListe(sonder)}`,
      sonder.map((o) => ({
        id: o.id, nummer: o.number,
        kunde: o.billing?.company || [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(' ') || '—',
        betrag: o.total,
      }))));
  }

  // Marker, die das Plugin selbst setzt, wenn beim Etikett etwas schiefging.
  const snapshotKaputt = reif.filter((o) => gesetzt(o, '_lk24_snapshot_failed'));
  if (snapshotKaputt.length) {
    out.push(befund('snapshot', 'Etikett-Vorschau', 'alarm',
      `${snapshotKaputt.length} Bestellung(en) mit fehlgeschlagenem Snapshot (Foto fehlt womöglich im Druck): ${idListe(snapshotKaputt)}`,
      snapshotKaputt.map((o) => ({ id: o.id, nummer: o.number }))));
  }
  const drift = reif.filter((o) => gesetzt(o, '_lk24_bg_drift'));
  if (drift.length) {
    out.push(befund('bgdrift', 'Hintergrundfarbe', 'warn',
      `${drift.length} Bestellung(en) mit Farb-Drift im Snapshot (Dark-Mode-Verdacht) — vor dem Druck ansehen: ${idListe(drift)}`,
      drift.map((o) => ({ id: o.id, nummer: o.number }))));
  }
  const geheilt = reif.filter((o) => gesetzt(o, '_lk24_preview_healed'));
  if (geheilt.length) {
    out.push(befund('healed', 'Vorschau repariert', 'info',
      `${geheilt.length} Bestellung(en) wurden automatisch geheilt: ${idListe(geheilt)}`));
  }

  // ---- Bestandsbuchung -------------------------------------------------------
  const ungebucht = reif.filter((o) => !gesetzt(o, '_lk24vt_logged'));
  out.push(ungebucht.length
    ? befund('bestand', 'Bestandsbuchung', 'warn',
        `${ungebucht.length} bezahlte Bestellung(en) nicht im Verkaufstracker — Lagerzahlen laufen auseinander: ${idListe(ungebucht)}`,
        ungebucht.map((o) => ({ id: o.id, nummer: o.number })))
    : befund('bestand', 'Bestandsbuchung', 'ok', 'alle bezahlten Bestellungen sind gebucht'));

  // ---- Liegengebliebener Versand --------------------------------------------
  const liegt = echte.filter((o) =>
    o.status === 'processing' && o.date_paid
    && stundenSeit(o.date_paid) > 24 * (s.versandTage ?? 5)
    && !gesetzt(o, '_lk24_versand_uebergeben_at'));
  out.push(liegt.length
    ? befund('versand', 'Versand offen', 'warn',
        `${liegt.length} Bestellung(en) seit über ${s.versandTage ?? 5} Tagen bezahlt, aber nicht übergeben: ${idListe(liegt)}`,
        liegt.map((o) => ({ id: o.id, nummer: o.number, bezahltVorTagen: Math.round(stundenSeit(o.date_paid) / 24) })))
    : befund('versand', 'Versand offen', 'ok', 'nichts liegt zu lange'));

  // ---- Fehlgeschlagene Zahlungen --------------------------------------------
  const gescheitert = echte.filter((o) => o.status === 'failed' && stundenSeit(o.date_created) < 48);
  if (gescheitert.length >= (s.failedWarn ?? 3)) {
    out.push(befund('failed', 'Zahlungsabbrüche', 'warn',
      `${gescheitert.length} fehlgeschlagene Zahlungen in 48 h — Zahlungsanbieter prüfen: ${idListe(gescheitert)}`));
  }

  return out;
}
