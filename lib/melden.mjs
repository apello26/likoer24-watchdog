/**
 * Meldung an Thomas — über einen eigenen Telegram-Bot.
 *
 * Bewusst nicht der Bot der anderen Pi-Dienste: eine Shop-Störung soll in
 * einem eigenen Gesprächsfaden aufschlagen, nicht zwischen Redaktionsmeldungen
 * untergehen — und ein Bot pro Zweck heißt auch, dass man ihn einzeln
 * stummschalten kann, ohne die anderen mit zu verlieren.
 *
 * Zugang steht in ~/.likoer24-watchdog-env (siehe bot-einrichten.sh):
 *   WATCHDOG_TELEGRAM_BOT_TOKEN=…
 *   WATCHDOG_TELEGRAM_CHAT_ID=…
 *
 * Grundregel gegen Alarmmüdigkeit: gemeldet wird die VERÄNDERUNG, nicht der
 * Zustand. Ein Problem, das gestern schon gemeldet wurde, schweigt heute —
 * sonst lernt man, die Nachrichten wegzuwischen, und übersieht die eine, die
 * zählt. Das Dashboard zeigt jederzeit den vollen Stand.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ENV_DATEI = join(homedir(), '.likoer24-watchdog-env');

function umgebung() {
  let token = process.env.WATCHDOG_TELEGRAM_BOT_TOKEN;
  let chat = process.env.WATCHDOG_TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    try {
      const env = readFileSync(ENV_DATEI, 'utf8');
      token ||= (env.match(/WATCHDOG_TELEGRAM_BOT_TOKEN=["']?([^"'\n]+)/) || [])[1];
      chat  ||= (env.match(/WATCHDOG_TELEGRAM_CHAT_ID=["']?([^"'\n]+)/) || [])[1];
    } catch { /* noch nicht eingerichtet — dann eben stumm */ }
  }
  return { token, chat };
}

const ZEICHEN = { alarm: '🔴', warn: '🟡', info: '🔵', ok: '🟢' };

/**
 * Was hat sich gegenüber dem letzten Lauf geändert?
 * Liefert { neu, behoben, veraendert } — jeweils Listen von Befunden.
 */
export function unterschied(jetzt, vorher) {
  const alt = new Map(), altText = new Map(), altNummern = new Map();
  for (const g of vorher?.gruppen || []) {
    for (const b of g.befunde) {
      const k = `${g.id}.${b.id}`;
      alt.set(k, b.status);
      altText.set(k, b.text);
      altNummern.set(k, nummern(b));
    }
  }

  const neu = [], behoben = [], veraendert = [], weiterhin = [];
  const gesehen = new Set();
  for (const g of jetzt.gruppen) {
    for (const b of g.befunde) {
      const schluessel = `${g.id}.${b.id}`;
      gesehen.add(schluessel);
      const vorherStatus = alt.get(schluessel);
      const eintrag = { ...b, gruppe: g.titel };
      if (b.status === 'alarm' || b.status === 'warn') {
        // Gleicher Status, aber eine weitere Bestellung dazugekommen? Dann ist
        // das neu — sonst verschwindet z. B. ein zweites fehlendes PDF still
        // unter dem schon stehenden Alarm.
        const dazu = nummern(b).some((n) => !(altNummern.get(schluessel) || []).includes(n));
        if (vorherStatus !== b.status || dazu) neu.push(eintrag);
        else if (b.status === 'alarm') weiterhin.push(eintrag); // steht seit dem letzten Lauf
      } else if (b.status === 'info') {
        // Hinweise nur melden, wenn sie neu sind oder sich ihr Text geändert
        // hat — sonst ging bei jedem Lauf eine Nachricht raus, und die
        // 20-h-Erinnerung an stehende Alarme wurde nie fällig.
        if (vorherStatus !== 'info' || altText.get(schluessel) !== b.text) veraendert.push(eintrag);
      } else if (vorherStatus === 'alarm' || vorherStatus === 'warn') {
        behoben.push(eintrag);
      }
    }
  }
  // Ein Befund, der ganz verschwindet (z. B. der Snapshot-Fehler taucht nicht
  // mehr auf), gilt ebenfalls als behoben.
  for (const [schluessel, status] of alt) {
    if (!gesehen.has(schluessel) && (status === 'alarm' || status === 'warn')) {
      behoben.push({ id: schluessel, titel: schluessel.split('.').pop(), status: 'ok', text: 'tritt nicht mehr auf', gruppe: '' });
    }
  }
  return { neu, behoben, veraendert, weiterhin };
}

/** Bestellnummern bzw. IDs aus den Details eines Befunds (Strings zählen nicht). */
function nummern(b) {
  return (b.details || []).filter((d) => d && typeof d === 'object' && (d.nummer || d.id)).map((d) => String(d.nummer || d.id));
}

export function nachrichtBauen(lauf, diff, opt = {}) {
  const zeilen = [];
  const erinnerung = opt.erinnerung && (diff.weiterhin || []).length;
  const kopf = diff.neu.some((b) => b.status === 'alarm') ? '🔴 Likoer24'
    : diff.neu.length ? '🟡 Likoer24'
    : erinnerung ? '🔴 Likoer24 — Alarm steht weiter'
    : '🔵 Likoer24';
  zeilen.push(`${kopf} — ${lauf.zeitText}`);

  if (diff.neu.length) {
    zeilen.push('', 'Neu:');
    for (const b of diff.neu.slice(0, 10)) {
      zeilen.push(`${ZEICHEN[b.status]} ${b.gruppe} · ${b.titel}: ${b.text}`);
      for (const d of (b.details || []).slice(0, 3)) {
        zeilen.push(`   – ${typeof d === 'string' ? d : JSON.stringify(d)}`);
      }
    }
  }
  if (diff.veraendert.length) {
    zeilen.push('', 'Verändert:');
    for (const b of diff.veraendert.slice(0, 8)) zeilen.push(`🔵 ${b.titel}: ${b.text}`);
  }
  if (erinnerung) {
    zeilen.push('', 'Weiter offen (Erinnerung):');
    for (const b of diff.weiterhin.slice(0, 6)) zeilen.push(`🔴 ${b.gruppe} · ${b.titel}: ${b.text}`);
  }
  if (diff.behoben.length) {
    zeilen.push('', 'Wieder in Ordnung:');
    for (const b of diff.behoben.slice(0, 8)) zeilen.push(`🟢 ${b.titel}`);
  }
  zeilen.push('', `Gesamt: ${lauf.status} · ${lauf.zahlen.ok} ok, ${lauf.zahlen.warn} Warnung(en), ${lauf.zahlen.alarm} Alarm(e)`);
  return zeilen.join('\n');
}

/** Schickt die Nachricht. Wirft nie — eine verlorene Meldung kippt keinen Lauf. */
export async function senden(text) {
  const { token, chat } = umgebung();
  if (!token || !chat) return { gesendet: false, grund: `kein eigener Bot eingerichtet — ${ENV_DATEI} fehlt oder ist unvollständig (./bot-einrichten.sh)` };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok ? { gesendet: true } : { gesendet: false, grund: `Telegram antwortet mit HTTP ${r.status}` };
  } catch (e) {
    return { gesendet: false, grund: e.message };
  }
}
