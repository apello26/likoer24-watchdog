/**
 * Ein echter Browser für den Watchdog — ohne npm-Paket.
 *
 * Warum überhaupt ein Browser: Der Ausfall vom 03.–06.09.2026 war für alle
 * bisherigen Prüfungen unsichtbar. HTTP 200, LK24_BOOT stimmig, Dateien da,
 * Server ruhig — und trotzdem kam kein Handy-Kunde über Schritt 2 hinaus,
 * weil eine Layout-Heuristik den Weiter-Knopf ausgeblendet hatte. So etwas
 * sieht man nur, wenn man die Seite wie ein Kunde bedient: Viewport eines
 * Handys, tippen, schauen, ob der Knopf noch da ist und ob er den Tipp
 * überhaupt bekommt.
 *
 * Warum kein puppeteer/playwright: Der Watchdog soll ohne `npm install`
 * laufen und darf nicht an einem Paket-Update sterben (siehe kern.mjs).
 * Chromium bringt sein DevTools-Protokoll aber selbst mit — über
 * `--remote-debugging-pipe` spricht es JSON über zwei Pipes, mit einem
 * Nullbyte als Trenner. Das reicht für alles, was wir brauchen: Seite laden,
 * Viewport setzen, tippen, Skript auswerten. Etwa 150 Zeilen statt 300 MB.
 *
 * Voraussetzung: ein Chromium/Chrome auf dem Rechner. Auf dem Pi
 * `sudo apt install chromium`, auf dem Mac reicht Google Chrome. Fehlt beides,
 * meldet der Klickpfad-Check das als Hinweis und der Rest läuft weiter.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KANDIDATEN = [
  process.env.LK_CHROME,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

/** Erster vorhandener Browser — oder null. */
export function chromiumFinden() {
  return KANDIDATEN.find((p) => { try { return existsSync(p); } catch { return false; } }) || null;
}

/** Kennung, an der man den Wächter in Logs und Analytics erkennt. */
export const UA_HANDY = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 likoer24-watchdog';
export const UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 likoer24-watchdog';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Startet Chromium headless und liefert einen kleinen DevTools-Client:
 *   send(method, params, sessionId)  → Promise mit dem Ergebnis
 *   on(method, cb, sessionId)        → Ereignisse abonnieren, gibt Abmelder zurück
 *   warteAuf(method, sessionId, ms)  → Promise auf das nächste Ereignis
 *   schliessen()                     → Prozess beenden, Profilordner wegräumen
 */
export async function browserStarten(opt = {}) {
  const bin = opt.bin || chromiumFinden();
  if (!bin) throw new Error('kein Chromium/Chrome gefunden — LK_CHROME setzen oder auf dem Pi `sudo apt install chromium`');
  const profil = mkdtempSync(join(tmpdir(), 'lk24-watchdog-'));
  const befehlMs = opt.befehlTimeoutMs ?? 20000;

  const kind = spawn(bin, [
    '--headless=new', '--remote-debugging-pipe',
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--disable-component-update',
    '--mute-audio', '--hide-scrollbars', '--force-color-profile=srgb', '--lang=de-DE',
    `--user-data-dir=${profil}`, `--window-size=${opt.width ?? 390},${opt.height ?? 740}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });

  const rein = kind.stdio[3];   // wir → Browser
  const raus = kind.stdio[4];   // Browser → wir
  let stderr = '';
  kind.stderr.on('data', (c) => { stderr = (stderr + c).slice(-3000); });

  let naechsteId = 1;
  const offen = new Map();
  const hoerer = [];
  let puffer = '';
  let beendet = false;

  const alleAbbrechen = (grund) => {
    for (const { reject } of offen.values()) reject(new Error(grund));
    offen.clear();
  };

  raus.setEncoding('utf8');
  raus.on('data', (chunk) => {
    puffer += chunk;
    let i;
    while ((i = puffer.indexOf('\0')) >= 0) {
      const roh = puffer.slice(0, i);
      puffer = puffer.slice(i + 1);
      let msg;
      try { msg = JSON.parse(roh); } catch { continue; }
      if (msg.id && offen.has(msg.id)) {
        const { resolve, reject } = offen.get(msg.id);
        offen.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message || 'DevTools-Fehler'}`));
        else resolve(msg.result || {});
      } else if (msg.method) {
        for (const h of [...hoerer]) {
          if (h.method === msg.method && (!h.sessionId || h.sessionId === msg.sessionId)) {
            try { h.cb(msg.params || {}, msg.sessionId); } catch { /* Hörer-Fehler kippen nichts */ }
          }
        }
      }
    }
  });

  kind.on('exit', () => {
    beendet = true;
    const letzte = stderr.trim().split('\n').pop() || '';
    alleAbbrechen('Browser hat sich beendet' + (letzte ? `: ${letzte.slice(0, 160)}` : ''));
  });
  kind.on('error', (e) => { beendet = true; alleAbbrechen(`Browser-Start: ${e.message}`); });

  function send(method, params = {}, sessionId, timeoutMs) {
    if (beendet) return Promise.reject(new Error('Browser beendet'));
    const id = naechsteId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const frist = timeoutMs ?? befehlMs;
    return new Promise((resolve, reject) => {
      const wecker = setTimeout(() => {
        if (offen.has(id)) { offen.delete(id); reject(new Error(`${method}: keine Antwort in ${frist} ms`)); }
      }, frist);
      offen.set(id, {
        resolve: (v) => { clearTimeout(wecker); resolve(v); },
        reject: (e) => { clearTimeout(wecker); reject(e); },
      });
      try { rein.write(JSON.stringify(msg) + '\0'); }
      catch (e) { offen.delete(id); clearTimeout(wecker); reject(e); }
    });
  }

  function on(method, cb, sessionId) {
    const h = { method, cb, sessionId };
    hoerer.push(h);
    return () => { const i = hoerer.indexOf(h); if (i >= 0) hoerer.splice(i, 1); };
  }

  function warteAuf(method, sessionId, ms = 30000, filter) {
    let ab = null, w = null;
    const p = new Promise((resolve, reject) => {
      ab = on(method, (params) => {
        if (filter && !filter(params)) return;
        ab(); clearTimeout(w); resolve(params);
      }, sessionId);
      w = setTimeout(() => { ab(); reject(new Error(`${method}: nicht eingetreten in ${ms} ms`)); }, ms);
    });
    // Abbrechen können — wer nicht mehr wartet, darf keinen Wecker zurücklassen,
    // der später als unbehandelte Zurückweisung den ganzen Lauf reißt.
    p.abbrechen = () => { if (ab) ab(); clearTimeout(w); };
    p.catch(() => {});
    return p;
  }

  function schliessen() {
    if (beendet) return;
    beendet = true;
    try { kind.kill('SIGKILL'); } catch { /* schon weg */ }
    // Pipes loslassen — sonst hält der offene Schreibkanal den Node-Prozess am Leben.
    for (const s of [rein, raus, kind.stderr]) { try { s.destroy(); } catch { /* egal */ } }
    try { kind.unref(); } catch { /* egal */ }
    alleAbbrechen('Browser geschlossen');
    setTimeout(() => { try { rmSync(profil, { recursive: true, force: true }); } catch { /* egal */ } }, 800);
  }

  // Erster Befehl = Handschlag. Antwortet Chromium nicht, ist es nicht startbar
  // (fehlende Bibliothek, falscher Pfad) — das soll hier klar scheitern.
  try {
    await send('Target.getTargets');
  } catch (e) {
    schliessen();
    throw new Error(`Chromium (${bin}) antwortet nicht: ${e.message}`);
  }

  return { send, on, warteAuf, schliessen, bin, pid: kind.pid };
}

/**
 * Eine Seite (Tab) im Browser — mit den Handgriffen, die der Klickpfad braucht.
 * Alle Koordinaten sind CSS-Pixel im Viewport, so wie elementFromPoint sie sieht.
 */
export async function seiteOeffnen(browser, opt = {}) {
  const width = opt.width ?? 390, height = opt.height ?? 740, mobil = opt.mobil ?? true;
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => browser.send(m, p, sessionId);

  const seite = {
    sessionId, targetId, fehler: [], width, height,
    send: s,
    on: (m, cb) => browser.on(m, cb, sessionId),

    async oeffnen(url, ms = 45000) {
      const geladen = browser.warteAuf('Page.loadEventFired', sessionId, ms);
      try {
        // Die Antwort auf Page.navigate kommt erst, wenn die Navigation steht —
        // auf dem Pi mit kaltem Cache dauert das gern länger als ein normaler Befehl.
        await browser.send('Page.navigate', { url }, sessionId, ms);
      } catch (e) {
        geladen.abbrechen();
        throw e;
      }
      await geladen;
      await pause(300);
    },

    /** Ausdruck in der Seite auswerten; Promises werden abgewartet. */
    async eval(ausdruck) {
      const r = await s('Runtime.evaluate', { expression: ausdruck, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error('Seiten-Skript: ' + String(d.exception?.description || d.text || 'Fehler').split('\n')[0].slice(0, 200));
      }
      return r.result?.value;
    },

    /** Warten, bis ein Ausdruck wahr wird (Polling, weil ohne Bibliothek). */
    async warten(ausdruck, ms = 15000, schritt = 250) {
      const ende = Date.now() + ms;
      let letzter;
      while (Date.now() < ende) {
        try { letzter = await this.eval(ausdruck); if (letzter) return letzter; } catch { /* Seite lädt vielleicht gerade um */ }
        await pause(schritt);
      }
      return null;
    },

    async viewport(w, h) {
      this.width = w; this.height = h;
      await s('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: mobil ? 2 : 1, mobile: mobil,
        screenWidth: w, screenHeight: h,
      });
    },

    /** Pinch-Zoom nachstellen: skaliert den sichtbaren Ausschnitt wie ein Finger-Zoom. */
    async zoom(faktor) {
      await s('Emulation.setPageScaleFactor', { pageScaleFactor: faktor });
    },

    /** Echter Fingertipp (Touch-Ereignisse, daraus macht Chromium den Klick). */
    async tippen(x, y) {
      await s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await pause(40);
      await s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },

    /** Mausklick — für Desktop und als zweiter Versuch, wenn ein Tipp nichts bewirkt. */
    async klicken(x, y) {
      await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await s('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await pause(30);
      await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },

    async tippeText(text) { await s('Input.insertText', { text }); },

    async schliessen() { try { await browser.send('Target.closeTarget', { targetId }); } catch { /* egal */ } },
  };

  await s('Page.enable');
  await s('Runtime.enable');
  await s('Log.enable');
  await s('Network.enable');
  seite.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    seite.fehler.push(String(d.exception?.description || d.text || 'Fehler').split('\n')[0].slice(0, 160));
  });
  seite.on('Log.entryAdded', (p) => {
    const e = p.entry || {};
    if (e.level === 'error' && !/Failed to load resource|net::ERR_|ERR_BLOCKED_BY_CLIENT/.test(e.text || '')) {
      seite.fehler.push(String(e.text).slice(0, 160));
    }
  });

  await seite.viewport(width, height);
  if (mobil) await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await s('Network.setUserAgentOverride', { userAgent: opt.userAgent || (mobil ? UA_HANDY : UA_DESKTOP) });
  return seite;
}

export { pause };
