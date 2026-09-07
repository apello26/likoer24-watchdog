/**
 * Werkzeugkasten für den Watchdog.
 *
 * Bewusst ohne Abhängigkeiten (wie proxy.js im Dashboard): Node 20 bringt
 * fetch mit, FTP macht curl. Damit läuft das Ding auf dem Pi ohne npm install
 * und kann nicht durch ein kaputtes Paket-Update ausfallen — ein Wachhund,
 * der selbst Wartung braucht, ist keiner.
 */

import { spawn } from 'node:child_process';

/** Statusränge — höher ist schlimmer. Bestimmt den Gesamtstatus eines Laufs. */
export const RANG = { ok: 0, info: 1, warn: 2, alarm: 3 };

export function schlimmster(...status) {
  return status.reduce((a, b) => (RANG[b] > RANG[a] ? b : a), 'ok');
}

/** Einen Befund bauen. Kurzform, damit die Check-Module lesbar bleiben. */
export function befund(id, titel, status, text, details) {
  return { id, titel, status, text, ...(details ? { details } : {}) };
}

// ---- HTTP --------------------------------------------------------------------

const UA = 'likoer24-watchdog/1.0 (+intern; kein Crawler)';

/**
 * GET mit Timeout. Wirft nie wegen HTTP-Status — der Aufrufer entscheidet,
 * ob eine 404 ein Fehler ist. Wirft nur bei Netzproblem/Timeout.
 */
export async function holen(url, opt = {}) {
  const ms = opt.timeoutMs ?? 30000;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  const start = Date.now();
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: opt.redirect ?? 'follow',
      method: opt.method ?? 'GET',
      headers: { 'User-Agent': UA, ...(opt.headers || {}) },
    });
    const text = opt.kopfOnly ? '' : await r.text();
    return {
      url,
      status: r.status,
      ok: r.ok,
      dauerMs: Date.now() - start,
      ziel: r.url,
      headers: r.headers,
      text,
      groesse: text.length,
    };
  } finally {
    clearTimeout(t);
  }
}

/** Wie holenWeich(), aber ohne Redirect-Folgen — für Weiterleitungs-Prüfungen. */
export function holenOhneFolgen(url, opt = {}) {
  return holenWeich(url, { ...opt, redirect: 'manual' });
}

/**
 * GET, das Netzfehler in ein Ergebnis-Objekt verwandelt statt zu werfen — und
 * einen Aussetzer verzeiht.
 *
 * Beides ist für einen Wächter entscheidend: Eine einzelne Zeitüberschreitung
 * ist auf einem geteilten Hoster Alltag und darf um sieben Uhr früh kein
 * "Shop nicht erreichbar" auslösen. Erst wenn auch der zweite Versuch nach
 * einer Pause scheitert, gilt etwas als kaputt. Zwischen allen Anfragen liegt
 * eine kurze Pause, damit der Rundgang den Shop nicht selbst ausbremst.
 */
let letzteAnfrage = 0;
const PAUSE_MS = 200;

async function drosseln() {
  const wartenMs = letzteAnfrage + PAUSE_MS - Date.now();
  if (wartenMs > 0) await new Promise((r) => setTimeout(r, wartenMs));
  letzteAnfrage = Date.now();
}

export async function holenWeich(url, opt = {}) {
  const versuche = opt.versuche ?? 2;
  let letzterFehler = null;
  for (let i = 0; i < versuche; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000));
    await drosseln();
    try {
      return await holen(url, opt);
    } catch (e) {
      letzterFehler = e.name === 'AbortError' ? 'Zeitüberschreitung' : e.message;
    }
  }
  return { url, status: 0, ok: false, fehler: `${letzterFehler} (${versuche} Versuche)`, text: '', groesse: 0, dauerMs: -1 };
}

// ---- HTML-Krümel -------------------------------------------------------------

export function ersterTreffer(html, regex) {
  const m = html.match(regex);
  return m ? (m[1] ?? m[0]).trim() : null;
}

export function titelVon(html) {
  const t = ersterTreffer(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? entities(t) : null;
}

export function h1Von(html) {
  const t = ersterTreffer(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return t ? entities(t.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : null;
}

export function metaBeschreibung(html) {
  const t = ersterTreffer(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    ?? ersterTreffer(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  return t ? entities(t) : null;
}

export function canonicalVon(html) {
  return ersterTreffer(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    ?? ersterTreffer(html, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
}

/** Alle JSON-LD-Blöcke einer Seite, geparst. Kaputte Blöcke kommen als null. */
export function jsonLdVon(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1].trim())); } catch { out.push(null); }
  }
  return out;
}

/** Die Typen aller JSON-LD-Knoten, flach — auch aus @graph. */
export function schemaTypen(bloecke) {
  const typen = new Set();
  const sammeln = (k) => {
    if (!k || typeof k !== 'object') return;
    if (Array.isArray(k)) return k.forEach(sammeln);
    if (k['@type']) [].concat(k['@type']).forEach((t) => typen.add(t));
    if (k['@graph']) sammeln(k['@graph']);
  };
  bloecke.filter(Boolean).forEach(sammeln);
  return [...typen];
}

function entities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#8211;/g, '–').replace(/&#8222;|&#8220;/g, '"').replace(/&shy;/g, '');
}

/** Das LK24_BOOT-Objekt aus der Konfigurator-Seite herausschneiden. */
export function bootVon(html) {
  const start = html.indexOf('var LK24_BOOT = ');
  if (start < 0) return null;
  const von = html.indexOf('{', start);
  if (von < 0) return null;
  // Klammern zählen, aber Strings überspringen — im BOOT stecken Texte mit { }.
  let tiefe = 0, imString = false, escape = false;
  for (let i = von; i < html.length; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (imString) {
      if (c === '\\') escape = true;
      else if (c === '"') imString = false;
      continue;
    }
    if (c === '"') { imString = true; continue; }
    if (c === '{') tiefe++;
    else if (c === '}' && --tiefe === 0) {
      try { return JSON.parse(html.slice(von, i + 1)); } catch { return null; }
    }
  }
  return null;
}

// ---- FTP (per curl) ----------------------------------------------------------

/**
 * FTP-Zugriff über curl. Bewusst kein lftp: der Pi hat keins, curl schon.
 * Das Passwort geht über --config von stdin, damit es nicht in der
 * Prozessliste (`ps aux`) landet, wo jeder Nutzer es mitlesen könnte.
 */
function curlFtp(cfg, pfad, extra = []) {
  const url = `ftp://${cfg.host}${pfad.startsWith('/') ? '' : '/'}${pfad}`;
  const sekunden = cfg.timeoutSek ?? 40;
  // Das Passwort geht über --config von stdin, damit es nicht in der
  // Prozessliste (`ps aux`) auftaucht, wo jeder Nutzer es mitlesen könnte.
  const konfig = `user = "${String(cfg.user).replace(/(["\\])/g, '\\$1')}:${String(cfg.pass).replace(/(["\\])/g, '\\$1')}"\n`;

  return new Promise((resolve, reject) => {
    const kind = spawn('curl', ['--config', '-', '--silent', '--show-error', '--max-time', String(sekunden), ...extra, url]);
    const aus = [], fehler = [];
    // Eigener Wecker: --max-time deckt nur den Transfer ab. Hängt curl aus
    // einem anderen Grund, muss der Lauf trotzdem weitergehen.
    const wecker = setTimeout(() => { kind.kill('SIGKILL'); reject(new Error('FTP-Zeitüberschreitung')); }, (sekunden + 10) * 1000);

    kind.stdout.on('data', (c) => aus.push(c));
    kind.stderr.on('data', (c) => fehler.push(c));
    kind.on('error', (e) => { clearTimeout(wecker); reject(e); });
    kind.on('close', (code) => {
      clearTimeout(wecker);
      if (code !== 0) return reject(new Error(`curl endet mit Code ${code}: ${Buffer.concat(fehler).toString().trim().slice(0, 200)}`));
      resolve(Buffer.concat(aus));
    });

    kind.stdin.on('error', () => { /* curl war schneller — kein Grund zur Panik */ });
    kind.stdin.end(konfig);
  });
}

/** Verzeichnis auflisten → [{ name, groesse, zeitRoh, istOrdner }]. */
export async function ftpListe(cfg, pfad) {
  const roh = (await curlFtp(cfg, pfad.endsWith('/') ? pfad : pfad + '/')).toString('utf8');
  return roh.split('\n').filter(Boolean).map((z) => {
    // Unix-Listing: Rechte Links Nutzer Gruppe Größe Monat Tag Zeit Name
    const m = z.match(/^([\w-]{10})\s+\S+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.+)$/);
    if (!m) return null;
    return { name: m[4].trim(), groesse: Number(m[2]), zeitRoh: m[3], istOrdner: m[1][0] === 'd' };
  }).filter(Boolean);
}

/** Eine entfernte Datei ganz holen. */
export async function ftpDatei(cfg, pfad) {
  return (await curlFtp(cfg, pfad)).toString('utf8');
}

/** Die letzten N Bytes einer entfernten Datei holen (ohne sie ganz zu ziehen). */
export async function ftpEnde(cfg, pfad, bytes, gesamtGroesse) {
  const ab = Math.max(0, (gesamtGroesse ?? 0) - bytes);
  const buf = await curlFtp(cfg, pfad, ab > 0 ? ['--range', `${ab}-`] : []);
  return buf.toString('utf8');
}

// ---- Kleinkram ---------------------------------------------------------------

export const eur = (n) => (Math.round(n * 100) / 100).toFixed(2).replace('.', ',') + ' €';

export function stundenSeit(iso) {
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}

/** Deutsches Datum/Zeit ohne Bibliothek, feste Zone Europe/Berlin. */
export function jetztText(d = new Date()) {
  return d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
}
