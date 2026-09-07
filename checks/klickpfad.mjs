/**
 * Klickpfad — kann ein Kunde den Konfigurator wirklich bis zum Warenkorb bedienen?
 *
 * Alle anderen Prüfungen schauen von außen auf den Shop: HTTP-Status, Daten,
 * Dateien, Logs. Vom 03. bis 06.09.2026 war davon alles grün — und trotzdem
 * kam kein einziger Handy-Kunde über Schritt 2 hinaus. Eine Tastatur-Heuristik
 * (Version 1.0.192) hatte auf Handys die untere Leiste mit dem Weiter-Knopf
 * ausgeblendet, sobald Zoom oder Browserleisten den Viewport verkleinerten.
 * Vier Tage ohne Bestellung, und der einzige Hinweis war der ruhige
 * Bestellstrom — ein Signal, das bei einer Bestellung pro Tag erst nach
 * Tagen anspricht.
 *
 * Deshalb bedient dieser Check den Konfigurator wie ein Kunde: in einem
 * echten Chromium mit Handy-Viewport, per Fingertipp, und prüft nach jedem
 * Schritt nicht nur „ist der Knopf im DOM", sondern „ist er sichtbar, liegt er
 * im sichtbaren Bereich und bekommt er den Tipp" (elementFromPoint). Dazu
 * genau die Situationen, die damals gefehlt haben: kleinerer Viewport
 * (eingeblendete Browserleisten) und Pinch-Zoom.
 *
 * Er kauft nichts. Der Weg endet bei der Bestellübersicht vor dem Warenkorb.
 * Consent wird abgelehnt (kein Tracking), der User-Agent trägt die Kennung
 * „likoer24-watchdog".
 */

import { befund } from '../lib/kern.mjs';
import { browserStarten, seiteOeffnen, chromiumFinden, pause } from '../lib/browser.mjs';

export const name = 'Klickpfad';

// Trifft ein Tipp auf das Element? Sichtbar, innerhalb des sichtbaren Bereichs
// (visualViewport, also auch bei Zoom korrekt) und nicht von etwas anderem verdeckt.
const JS_TREFFER = `(function (sel, mussText, deaktiviertOk, scrollen) {
  const alle = [...document.querySelectorAll(sel)];
  // Beschriftung = aria-label oder Text: die Mengen-Knöpfe tragen ihr „mehr" nur im aria-label.
  const label = (e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).replace(/\\s+/g, ' ').trim();
  const el = alle.find((e) => !mussText || new RegExp(mussText, 'i').test(label(e))) || null;
  const kbd = document.documentElement.getAttribute('data-lk-kbd');
  if (!el) return { ok: false, grund: 'Element fehlt (' + sel + (mussText ? ' „' + mussText + '“' : '') + ')', kbd };
  const cs = getComputedStyle(el);
  // Wer blendet aus — das Element selbst oder ein Vorfahr (z. B. die ganze Leiste)?
  const ausgeblendetVon = () => {
    let k = el;
    while (k && k !== document.body) {
      const c = getComputedStyle(k);
      if (c.display === 'none' || c.visibility === 'hidden') return k.tagName.toLowerCase() + (k.className ? '.' + String(k.className).split(' ')[0] : '') + ' ausgeblendet';
      k = k.parentElement;
    }
    return '';
  };
  const kbdText = kbd ? ', data-lk-kbd=' + kbd : '';
  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) {
    return { ok: false, grund: 'unsichtbar (' + (ausgeblendetVon() || 'display ' + cs.display) + kbdText + ')', kbd };
  }
  if (el.disabled && !deaktiviertOk) return { ok: false, grund: 'deaktiviert', kbd };
  // Inhalt darf unter dem Fold liegen — ein Kunde scrollt hin. Die feste
  // Aktionsleiste (scrollen=false) muss dagegen ohne Scrollen erreichbar sein.
  if (scrollen) {
    try {
      // Sofort scrollen, nicht „smooth" — sonst ist die Position beim Messen noch die alte.
      const de = document.documentElement, alt = de.style.scrollBehavior;
      de.style.scrollBehavior = 'auto';
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      de.style.scrollBehavior = alt;
    } catch (e) {}
  }
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return { ok: false, grund: 'unsichtbar (' + (ausgeblendetVon() || 'ohne Ausdehnung') + kbdText + ')', kbd };
  const vv = window.visualViewport;
  const vw = vv ? vv.width : innerWidth, vh = vv ? vv.height : innerHeight;
  const ox = vv ? vv.offsetLeft : 0, oy = vv ? vv.offsetTop : 0;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  if (cx < ox || cx > ox + vw || cy < oy || cy > oy + vh) {
    return { ok: false, grund: 'außerhalb des sichtbaren Bereichs (Mitte bei ' + Math.round(cy) + ' px, sichtbar bis ' + Math.round(oy + vh) + ' px)', x: cx, y: cy, kbd };
  }
  const hit = document.elementFromPoint(cx, cy);
  if (!hit || !(hit === el || el.contains(hit))) {
    return { ok: false, grund: 'verdeckt von ' + (hit ? hit.tagName.toLowerCase() + (hit.className ? '.' + String(hit.className).split(' ')[0] : '') : 'nichts'), x: cx, y: cy, kbd };
  }
  return { ok: true, x: cx, y: cy, deaktiviert: !!el.disabled, text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40), kbd };
})`;

const JS_KLICK = `(function (sel, mussText) {
  const label = (e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).replace(/\\s+/g, ' ').trim();
  const el = [...document.querySelectorAll(sel)].find((e) => !mussText || new RegExp(mussText, 'i').test(label(e)));
  if (!el) return false; el.click(); return true;
})`;

const treffer = (seite, sel, text, deaktiviertOk = false, scrollen = false) =>
  seite.eval(`${JS_TREFFER}(${JSON.stringify(sel)}, ${JSON.stringify(text || '')}, ${deaktiviertOk ? 'true' : 'false'}, ${scrollen ? 'true' : 'false'})`);
// Inhaltselemente (Kacheln, Mengen-Knöpfe) dürfen erst nach dem Scrollen im Bild sein.
// Nach dem Scrollen kurz zur Ruhe kommen lassen und neu messen — sonst tippt man
// auf eine Position, die sich gerade noch bewegt.
const trefferInhalt = async (seite, sel, text) => {
  let letzter = null;
  // Bis zu dreimal: scrollen, kurz warten, ohne Scrollen nachmessen. Spät ladende
  // Bilder und Schriften verschieben das Layout auf einem langsamen Rechner
  // auch nach dem load-Ereignis noch — dann sitzt das Ziel wieder woanders.
  for (let i = 0; i < 3; i++) {
    const gescrollt = await treffer(seite, sel, text, false, true);
    if (!gescrollt.ok) return gescrollt;
    await pause(400);
    letzter = await treffer(seite, sel, text, false, false);
    if (letzter.ok) return letzter;
  }
  return letzter;
};
const jsKlick = (seite, sel, text) => seite.eval(`${JS_KLICK}(${JSON.stringify(sel)}, ${JSON.stringify(text || '')})`);

/**
 * Ein Bedienelement betätigen, wie ein Kunde es täte: erst Fingertipp, dann
 * Mausklick, zuletzt ein programmatischer Klick. Wichtig ist, WOMIT es
 * geklappt hat — reagiert der Knopf nur auf den programmatischen Klick, ist
 * er für echte Finger tot.
 */
async function betaetigen(seite, ziel, fertig, opt = {}) {
  const wege = opt.mobil === false ? ['klick', 'js'] : ['tipp', 'klick', 'js'];
  let punkt = ziel;
  for (const weg of wege) {
    // Vor jedem Versuch neu messen: hat der erste Tipp die Seite bewegt, säße
    // der zweite sonst auf einer alten Position und träfe etwas anderes.
    if (weg !== 'tipp' && opt.sel) {
      const neu = await treffer(seite, opt.sel, opt.text, true, true);
      if (neu.ok) punkt = neu;
    }
    if (weg === 'tipp') await seite.tippen(punkt.x, punkt.y);
    else if (weg === 'klick') await seite.klicken(punkt.x, punkt.y);
    else await jsKlick(seite, opt.sel, opt.text);
    if (await seite.warten(fertig, opt.ms ?? 4000, 200)) return weg;
  }
  return null;
}

class Abbruch extends Error {}

/** Der Handy-Weg: Stil → Sorten/Menge → Text → Druckfreigabe → Bestellübersicht. */
async function handyPfad(browser, url, cfg) {
  const schritte = [];
  const merke = (ok, was, detail) => { schritte.push(`${ok ? '✓' : '✗'} ${was}${detail ? ' — ' + detail : ''}`); if (!ok) throw new Abbruch(`${was}: ${detail}`); };
  const hoehen = cfg.hoehen ?? [640, 560];
  const zoomFaktor = cfg.zoom ?? 1.5;
  const seite = await seiteOeffnen(browser, { width: cfg.breite ?? 390, height: cfg.hoehe ?? 740, mobil: true });
  let tippWeg = [];

  try {
    await seite.oeffnen(url, 45000);
    const da = await seite.warten(`!!document.querySelector('button[aria-label^="Etikett-Stil"]')`, 25000);
    merke(!!da, 'Konfigurator geladen', da ? '' : 'keine Stil-Auswahl innerhalb von 25 s');
    // Schriften und späte Bilder abwarten, damit das Layout beim Messen steht.
    await seite.warten(`document.readyState === 'complete' && (!document.fonts || document.fonts.status === 'loaded')`, 10000, 250);
    await pause(700);

    // Consent ablehnen — der Wächter darf keine Statistik erzeugen. Danach kann
    // die Seite kurz neu aufbauen, also noch einmal auf die Stil-Auswahl warten.
    if (await jsKlick(seite, 'button', '^Ablehnen$')) {
      await pause(600);
      merke(!!(await seite.warten(`!!document.querySelector('button[aria-label^="Etikett-Stil"]')`, 15000)), 'Consent abgelehnt', '');
    }

    // ---- Schritt 1: Stil wählen -------------------------------------------------
    const stil = await trefferInhalt(seite, 'button[aria-label^="Etikett-Stil"]');
    merke(stil.ok, 'Stil-Kachel tippbar', stil.grund);
    const w1 = await betaetigen(seite, stil, `document.querySelectorAll('.cfg-sortrow').length > 0`, { sel: 'button[aria-label^="Etikett-Stil"]', ms: 5000 });
    if (!w1) {
      // Kein Auto-Weiter? Dann über den regulären Knopf.
      const weiter = await treffer(seite, 'button', 'Weiter zu Sorte');
      merke(weiter.ok, 'Weiter zu Sorte & Menge', weiter.grund);
      const w1b = await betaetigen(seite, weiter, `document.querySelectorAll('.cfg-sortrow').length > 0`, { sel: 'button', text: 'Weiter zu Sorte' });
      merke(!!w1b, 'Schritt 2 erreicht', w1b ? '' : 'Sortenliste erscheint nicht');
      tippWeg.push(w1b);
    } else {
      tippWeg.push(w1);
      merke(true, 'Schritt 2 erreicht', `nach Stil-Wahl per ${w1}`);
    }

    // ---- Schritt 2: Menge setzen -----------------------------------------------
    const mehr = await trefferInhalt(seite, '.cfg-sortrow button', 'mehr');
    merke(mehr.ok, 'Mengen-Knopf „mehr“ tippbar', mehr.grund);
    const w2 = await betaetigen(seite, mehr, `/\\b25 Flaschen/.test((document.querySelector('.cfg-sheet__sum')||{}).textContent||'') || !document.querySelector('.cfg-actions__cta')?.disabled`, { sel: '.cfg-sortrow button', text: 'mehr' });
    merke(!!w2, 'Menge auf 25 gesetzt', w2 ? `per ${w2}` : 'Summe bleibt bei 0');
    tippWeg.push(w2);

    // Der Weiter-Knopf: sichtbar und tippbar — und zwar auch, wenn der Viewport
    // kleiner wird (Browserleisten, eingeblendete Toolbar) oder gezoomt ist.
    const pruefeCta = async (lage) => {
      const t = await treffer(seite, '.cfg-actions__cta', 'Weiter zur Personalisierung');
      merke(t.ok && !t.kbd, `Weiter-Knopf ${lage}`, t.ok ? (t.kbd ? 'Tastatur-Modus aktiv ohne Textfeld (data-lk-kbd)' : '') : t.grund);
      return t;
    };
    let cta = await pruefeCta(`bei ${seite.height} px Höhe`);
    for (const h of hoehen) {
      await seite.viewport(cfg.breite ?? 390, h);
      await pause(600);
      await pruefeCta(`bei ${h} px Höhe`);
    }
    await seite.viewport(cfg.breite ?? 390, cfg.hoehe ?? 740);
    await pause(500);
    await seite.zoom(zoomFaktor);
    await pause(600);
    const gezoomt = await seite.eval(`(function(){ const bb=document.querySelector('.cfg-bottombar'); return { kbd: document.documentElement.getAttribute('data-lk-kbd'), leiste: bb ? getComputedStyle(bb).display : 'fehlt', scale: window.visualViewport ? window.visualViewport.scale : 1 }; })()`);
    merke(!gezoomt.kbd && gezoomt.leiste !== 'none', `Leiste bei Zoom ${zoomFaktor}×`, gezoomt.kbd ? 'Zoom wird als Tastatur gewertet (data-lk-kbd)' : gezoomt.leiste === 'none' ? 'Leiste ausgeblendet' : `Skalierung ${gezoomt.scale}`);
    await seite.zoom(1);
    await pause(500);
    cta = await pruefeCta('nach dem Zoom');

    const w3 = await betaetigen(seite, cta, `!!document.querySelector('.cfg-form--controls')`, { sel: '.cfg-actions__cta', text: 'Weiter zur Personalisierung', ms: 5000 });
    merke(!!w3, 'Schritt 3 erreicht', w3 ? `per ${w3}` : 'Personalisierung erscheint nicht');
    tippWeg.push(w3);

    // ---- Schritt 3: Text, Tastatur, Druckfreigabe --------------------------------
    const cta3 = await treffer(seite, '.cfg-actions__cta', 'Druckfreigabe', true);
    merke(cta3.ok, 'Druckfreigabe-Knopf sichtbar', cta3.grund);

    const feld = `document.querySelector('.cfg-form--controls input:not([type]), .cfg-form--controls input[type="text"]')`;
    merke(!!(await seite.eval(`!!${feld}`)), 'Textfeld vorhanden', '');
    // Tastatur: Feld fokussieren, Viewport schrumpft wie bei offener Tastatur.
    await seite.eval(`${feld}.focus()`);
    await seite.viewport(cfg.breite ?? 390, 400);
    await pause(700);
    await seite.tippeText('Watchdog');
    const eingetippt = await seite.eval(`${feld}.value`);
    merke(/Watchdog/.test(eingetippt || ''), 'Text eingegeben', eingetippt ? '' : 'Feld bleibt leer');
    // Feld verlassen, Tastatur weg — jetzt muss der Knopf wieder da sein.
    await seite.eval(`${feld}.blur()`);
    await seite.viewport(cfg.breite ?? 390, cfg.hoehe ?? 740);
    const zurueck = await seite.warten(`${JS_TREFFER}('.cfg-actions__cta', 'Druckfreigabe', false).ok`, 4000, 200);
    const cta3b = await treffer(seite, '.cfg-actions__cta', 'Druckfreigabe');
    merke(!!zurueck && cta3b.ok, 'Druckfreigabe-Knopf nach der Tastatur wieder tippbar', cta3b.grund || '');

    const w4 = await betaetigen(seite, cta3b, `!!document.querySelector('.cfg-proof')`, { sel: '.cfg-actions__cta', text: 'Druckfreigabe', ms: 8000 });
    merke(!!w4, 'Druckfreigabe geöffnet', w4 ? `per ${w4}` : 'Dialog erscheint nicht');
    tippWeg.push(w4);

    // Ohne Foto weiter zur Bestellübersicht — nur bis zum Warenkorb-Knopf, nicht hinein.
    if (await jsKlick(seite, '.cfg-proof button', 'ohne Foto weiter')) await pause(1000);
    const korb = await seite.warten(`${JS_TREFFER}('.cfg-proof button', 'In den Warenkorb', false).ok`, 6000, 250);
    const korbT = await treffer(seite, '.cfg-proof button', 'In den Warenkorb');
    merke(!!korb && korbT.ok, 'Bestellübersicht mit Warenkorb-Knopf', korbT.grund || '');
  } finally {
    await seite.schliessen().catch(() => {});
  }
  return { schritte, fehler: seite.fehler, tippWeg };
}

/** Desktop kurz gegenprüfen: Stil → Sorten → Weiter sichtbar. */
async function desktopPfad(browser, url, cfg) {
  const schritte = [];
  const merke = (ok, was, detail) => { schritte.push(`${ok ? '✓' : '✗'} ${was}${detail ? ' — ' + detail : ''}`); if (!ok) throw new Abbruch(`${was}: ${detail}`); };
  const seite = await seiteOeffnen(browser, { width: cfg.desktopBreite ?? 1280, height: cfg.desktopHoehe ?? 800, mobil: false });
  try {
    await seite.oeffnen(url, 45000);
    const da = await seite.warten(`!!document.querySelector('button[aria-label^="Etikett-Stil"]')`, 25000);
    merke(!!da, 'Konfigurator geladen', da ? '' : 'keine Stil-Auswahl innerhalb von 25 s');
    if (await jsKlick(seite, 'button', '^Ablehnen$')) {
      await pause(500);
      await seite.warten(`!!document.querySelector('button[aria-label^="Etikett-Stil"]')`, 15000);
    }
    const stil = await trefferInhalt(seite, 'button[aria-label^="Etikett-Stil"]');
    merke(stil.ok, 'Stil-Kachel klickbar', stil.grund);
    let w = await betaetigen(seite, stil, `document.querySelectorAll('.cfg-sortrow').length > 0`, { mobil: false, sel: 'button[aria-label^="Etikett-Stil"]' });
    if (!w) {
      const weiter = await treffer(seite, 'button', 'Weiter zu Sorte');
      merke(weiter.ok, 'Weiter zu Sorte & Menge', weiter.grund);
      w = await betaetigen(seite, weiter, `document.querySelectorAll('.cfg-sortrow').length > 0`, { mobil: false, sel: 'button', text: 'Weiter zu Sorte' });
    }
    merke(!!w, 'Schritt 2 erreicht', '');
    const mehr = await trefferInhalt(seite, '.cfg-sortrow button', 'mehr');
    merke(mehr.ok, 'Mengen-Knopf „mehr“ klickbar', mehr.grund);
    const w2 = await betaetigen(seite, mehr, `!document.querySelector('.cfg-totalbar__next, .cfg-actions__cta')?.disabled`, { mobil: false, sel: '.cfg-sortrow button', text: 'mehr' });
    merke(!!w2, 'Menge auf 25 gesetzt', '');
    const weiter = await treffer(seite, '.cfg-totalbar__next, .cfg-actions__cta', 'Weiter');
    merke(weiter.ok, 'Weiter-Knopf sichtbar und klickbar', weiter.grund);
  } finally {
    await seite.schliessen().catch(() => {});
  }
  return { schritte, fehler: seite.fehler };
}

function mitZeitlimit(p, ms, was) {
  let wecker;
  const limit = new Promise((_, rej) => { wecker = setTimeout(() => rej(new Error(`${was}: Zeitlimit von ${Math.round(ms / 1000)} s überschritten`)), ms); });
  // Wecker wieder abstellen — sonst hält er den Prozess bis zum Ablauf am Leben.
  return Promise.race([p, limit]).finally(() => clearTimeout(wecker));
}

export async function run(ctx) {
  const cfg = ctx.cfg.klickpfad || {};
  if (cfg.aktiv === false) return [befund('handy', 'Klickpfad Handy', 'info', 'in config.json abgeschaltet')];
  if (!chromiumFinden()) {
    return [befund('handy', 'Klickpfad Handy', 'info',
      'kein Chromium gefunden — der Bedien-Test läuft nicht (Pi: sudo apt install chromium; Mac: Google Chrome oder LK_CHROME)')];
  }

  const out = [];
  // Ziel überschreibbar (Deploy-Gate gegen den lokalen UI-Harness, Regressionstest
  // gegen einen alten Build): LK24_KLICKPFAD_URL oder klickpfad.url in config.json.
  const ziel = process.env.LK24_KLICKPFAD_URL || cfg.url || `${ctx.cfg.shop.basis}/konfigurator/`;
  const url = `${ziel}${ziel.includes('?') ? '&' : '?'}lk24wd=${Date.now()}`;
  const t0 = Date.now();
  let browser = null;
  try {
    browser = await browserStarten({ width: cfg.breite ?? 390, height: cfg.hoehe ?? 740 });

    // ---- Handy ------------------------------------------------------------------
    // Ein Fehlschlag ohne Bedien-Befund (Zeitlimit, Browser stockt beim ersten
    // Laden) bekommt einen zweiten Versuch — ein Abbruch am Knopf nicht.
    const handyMitWiederholung = async () => {
      try { return await mitZeitlimit(handyPfad(browser, url, cfg), (cfg.zeitlimitSek ?? 120) * 1000, 'Klickpfad Handy'); }
      catch (e) { if (e instanceof Abbruch) throw e; await pause(2000); return mitZeitlimit(handyPfad(browser, url, cfg), (cfg.zeitlimitSek ?? 120) * 1000, 'Klickpfad Handy (2. Versuch)'); }
    };
    try {
      const r = await handyMitWiederholung();
      const nurJs = r.tippWeg.filter((w) => w === 'js').length;
      out.push(nurJs
        ? befund('handy', 'Klickpfad Handy', 'alarm',
            `${nurJs} Bedienschritt(e) reagieren nicht auf Fingertipp, nur auf programmatischen Klick — für echte Kunden tot`, r.schritte)
        : befund('handy', 'Klickpfad Handy', 'ok',
            `Stil → Sorten → Text → Druckfreigabe → Bestellübersicht bedienbar (Viewport ${cfg.hoehe ?? 740}/${(cfg.hoehen ?? [640, 560]).join('/')} px, Zoom ${cfg.zoom ?? 1.5}×, Tastatur)`));
      ctx.merken('klickpfad.handy.jsfehler', r.fehler.length);
      if (r.fehler.length) {
        out.push(befund('handy.js', 'JS-Fehler im Konfigurator (Handy)', 'warn',
          `${r.fehler.length} Fehler in der Browser-Konsole`, [...new Set(r.fehler)].slice(0, 3)));
      }
    } catch (e) {
      const details = e instanceof Abbruch ? undefined : [e.message];
      out.push(befund('handy', 'Klickpfad Handy', e instanceof Abbruch ? 'alarm' : 'warn',
        e instanceof Abbruch
          ? `Kunde kommt auf dem Handy nicht durch: ${e.message}`
          : `Test nicht auswertbar: ${e.message}`, details));
    }

    // ---- Desktop ----------------------------------------------------------------
    try {
      const r = await mitZeitlimit(desktopPfad(browser, url, cfg), 60000, 'Klickpfad Desktop');
      out.push(befund('desktop', 'Klickpfad Desktop', 'ok', 'Stil → Sorten → Weiter bedienbar'));
      if (r.fehler.length) {
        out.push(befund('desktop.js', 'JS-Fehler im Konfigurator (Desktop)', 'warn',
          `${r.fehler.length} Fehler in der Browser-Konsole`, [...new Set(r.fehler)].slice(0, 3)));
      }
    } catch (e) {
      out.push(befund('desktop', 'Klickpfad Desktop', e instanceof Abbruch ? 'alarm' : 'warn',
        e instanceof Abbruch ? `Kunde kommt am Desktop nicht durch: ${e.message}` : `Test nicht auswertbar: ${e.message}`));
    }
  } catch (e) {
    out.push(befund('handy', 'Klickpfad Handy', 'warn', `Browser startet nicht: ${e.message}`));
  } finally {
    try { browser?.schliessen(); } catch { /* egal */ }
  }
  ctx.merken('klickpfad.dauerMs', Date.now() - t0);
  return out;
}
