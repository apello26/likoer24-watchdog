/**
 * Stimmt im Konfigurator noch alles?
 *
 * Der Konfigurator ist der einzige Bestellweg. Alles, was er dem Kunden
 * anzeigt, kommt aus LK24_BOOT — Sorten, Preisstaffel, Versandkosten,
 * Lieferzeit. Genau das prüfen wir hier: nicht "lädt die Seite", sondern
 * "sind die Zahlen darin plausibel und unverändert".
 *
 * Zwei Sorten von Befunden:
 *   - Fehler:  etwas ist in sich unstimmig (Preise nicht monoton, Los fehlt)
 *   - Drift:   etwas hat sich seit gestern geändert (Version, Preise, Sorten)
 * Drift ist kein Fehler — aber wenn du nichts hochgeladen hast, willst du es wissen.
 */

import { createHash } from 'node:crypto';
import { befund, holenWeich, bootVon, eur } from '../lib/kern.mjs';

export const name = 'Konfigurator';

/**
 * Etikett-Schriften (seit Konfigurator 1.0.222 selbst gehostet statt Google Fonts).
 *
 * Fehlt nach einem Upload auch nur eine Schriftdatei, rendern Vorschau UND Druck-Snapshot
 * still in einer Ersatzschrift — keine Fehlermeldung, die Bestellung läuft durch. Den
 * hinted/-Satz (Windows, Linux, ChromeOS) lädt der Klickpfad nie, weil er mit Android- und
 * Mac-Kennung surft — darum hier beide Ordner direkt: fonts.css lesen, jede darin genannte
 * woff2 per HEAD (HTTP 200, font/woff2, nicht leer). Solange live noch Google Fonts lädt
 * (vor 1.0.222), nur ein Hinweis — so darf dieser Check schon vor dem Deploy auf den Pi.
 * Vollständiger Byte-Vergleich nach einem Deploy: dev-tools/_fonts-live-check.mjs im Plugin.
 */
export async function schriftenPruefen(html, basis, timeoutMs) {
  const titel = 'Etikett-Schriften';
  if (/fonts\.googleapis\.com\/css2/.test(html)) {
    return befund('schriften', titel, 'info', 'kommen noch von Google Fonts (Konfigurator vor 1.0.222)');
  }
  if (!/<link[^>]+id=['"]lk24-fonts-css['"]/.test(html)) {
    return befund('schriften', titel, 'alarm', 'Schrift-Stylesheet lk24-fonts fehlt im Konfigurator — Etiketten rendern in Ersatzschrift');
  }
  const ordner = `${basis}/wp-content/plugins/likoer24-konfigurator/assets/fonts/web/`;
  const fehler = [];
  let dateien = 0;
  for (const dir of ['', 'hinted/']) {
    const css = await holenWeich(`${ordner}${dir}fonts.css`, { timeoutMs });
    const namen = css.status === 200
      ? [...new Set([...css.text.matchAll(/url\(([^)"']+\.woff2)\)/g)].map((m) => m[1]))]
      : [];
    if (!namen.length) {
      fehler.push(`web/${dir}fonts.css: ${css.status ? `HTTP ${css.status}` : css.fehler}${css.status === 200 ? ' ohne Schriftdateien' : ''}`);
      continue;
    }
    for (const n of namen) {
      dateien++;
      const r = await holenWeich(`${ordner}${dir}${n}`, { method: 'HEAD', kopfOnly: true, timeoutMs });
      const typ = (r.headers && r.headers.get('content-type')) || '';
      const laenge = r.headers ? r.headers.get('content-length') : null; // nginx liefert sie; fehlt sie, nicht werten
      if (r.status !== 200 || !/^font\/woff2/.test(typ) || (laenge !== null && Number(laenge) < 1000)) {
        fehler.push(`web/${dir}${n}: ${r.status ? `HTTP ${r.status}` : r.fehler}${r.status === 200 ? ` ${typ || 'ohne Typ'}, ${laenge} Bytes` : ''}`);
      }
    }
  }
  return fehler.length
    ? befund('schriften', titel, 'alarm',
        `${fehler.length} Problem(e) mit den Schriftdateien — betroffene Etiketten drucken in Ersatzschrift (hinted/ = Windows/Linux/ChromeOS). Upload von assets/fonts/web/ prüfen (httpdocs/!)`,
        fehler)
    : befund('schriften', titel, 'ok', `web/ und web/hinted/ vollständig (${dateien} Schriftdateien)`);
}

export async function run(ctx) {
  const out = [];
  const basis = ctx.cfg.shop.basis;

  const html = ctx.konfHtml
    ?? (await holenWeich(basis + '/konfigurator/', { timeoutMs: ctx.cfg.shop.timeoutMs })).text;

  const boot = bootVon(html);
  if (!boot) {
    return [befund('boot', 'Konfigurator-Daten', 'alarm',
      'LK24_BOOT nicht lesbar — der Konfigurator bekommt keine Sorten/Preise und kann nichts verkaufen')];
  }

  // ---- Version & ausgelieferte Dateien --------------------------------------
  const version = (html.match(/likoer24-konfigurator\/dist\/configurator\.js\?ver=([0-9.]+)/) || [])[1] || null;
  if (!version) {
    out.push(befund('version', 'Plugin-Version', 'warn', 'Version am configurator.js nicht erkennbar'));
  } else {
    const d = ctx.drift('konf.version', version);
    out.push(d.geaendert && d.vorher
      ? befund('version', 'Plugin-Version', 'info', `live jetzt ${version} (vorher ${d.vorher})`)
      : befund('version', 'Plugin-Version', 'ok', `${version} live`));
    // Seit wann läuft diese Version? Funnel- und Bestellstrom-Check halten
    // „seit dem Deploy" gegen „davor" — so bekommt ein Deploy, der den Funnel
    // bricht, innerhalb eines Tages einen Namen. Ohne gespeicherten Zeitpunkt
    // (erster Lauf nach dieser Änderung) gilt der Wert als unsicher.
    const seitAlt = ctx.gemerkt ? ctx.gemerkt('konf.versionSeit') : null;
    const frisch = d.geaendert && !!d.vorher;
    const seit = frisch ? new Date().toISOString() : (seitAlt || new Date().toISOString());
    ctx.drift('konf.versionSeit', seit);
    if (ctx.notizen) {
      ctx.notizen.deploy = { version, seit, stunden: (Date.now() - new Date(seit).getTime()) / 3600000, unsicher: !frisch && !seitAlt };
    }
  }

  for (const datei of ['configurator.js', 'configurator.css']) {
    const url = `${basis}/wp-content/plugins/likoer24-konfigurator/dist/${datei}${version ? '?ver=' + version : ''}`;
    const r = await holenWeich(url, { timeoutMs: ctx.cfg.shop.timeoutMs });
    if (r.status !== 200 || r.groesse < 5000) {
      out.push(befund(`asset.${datei}`, datei, 'alarm',
        r.status !== 200 ? `HTTP ${r.status || r.fehler}` : `nur ${r.groesse} Bytes — Datei wirkt leer oder ist eine Fehlerseite`));
      continue;
    }
    // Ein geänderter Datei-Inhalt bei gleicher Version bedeutet: hochgeladen,
    // aber die Version nicht gebumpt. Dann liefern Browser und Cache tagelang
    // die alte Datei aus — ein Fehler, der sich sonst nur zufällig zeigt.
    const hash = createHash('sha256').update(r.text).digest('hex').slice(0, 12);
    const dh = ctx.drift(`konf.hash.${datei}`, hash);
    const dv = ctx.drift(`konf.version.fuer.${datei}`, version || '?');
    if (dh.geaendert && dh.vorher && !dv.geaendert) {
      out.push(befund(`asset.${datei}`, datei, 'warn',
        `Inhalt hat sich geändert, die Version (${version}) aber nicht — Browser-Cache wird die alte Datei weiter ausliefern`));
    } else {
      out.push(befund(`asset.${datei}`, datei, 'ok', `${Math.round(r.groesse / 1024)} KB, HTTP 200`));
    }
  }
  out.push(await schriftenPruefen(html, basis, ctx.cfg.shop.timeoutMs));

  // ---- Sorten ---------------------------------------------------------------
  const sorten = Array.isArray(boot.sorten) ? boot.sorten : [];
  if (!sorten.length) {
    out.push(befund('sorten', 'Sorten', 'alarm', 'keine einzige Sorte im Konfigurator — es lässt sich nichts bestellen'));
  } else {
    const dS = ctx.drift('konf.sortenZahl', sorten.length);
    out.push(dS.geaendert && dS.vorher != null
      ? befund('sorten', 'Sorten', 'info', `${sorten.length} Sorten (vorher ${dS.vorher})`)
      : befund('sorten', 'Sorten', 'ok', `${sorten.length} Sorten verfügbar`));

    // § 1 LKV: jede befüllte Sorte braucht eine Los-Kennzeichnung im Pflichttext.
    const ohneLos = sorten.filter((s) => s.abv > 0 && !/•\s*L\d+\s*$/.test(String(s.legalRight || '')));
    if (ohneLos.length) {
      out.push(befund('los', 'Los-Kennzeichnung', 'alarm',
        `${ohneLos.length} Sorte(n) ohne Los im Pflichttext (§ 1 LKV): ${ohneLos.map((s) => s.name).join(', ')}`));
    } else {
      const lose = [...new Set(sorten.filter((s) => s.abv > 0).map((s) => (String(s.legalRight).match(/L\d+\s*$/) || [''])[0].trim()))];
      out.push(befund('los', 'Los-Kennzeichnung', 'ok', `alle Sorten gekennzeichnet (${lose.join(', ')})`));
    }

    // Der Pflichttext trägt den Alkoholgehalt doppelt — er muss zum Feld passen.
    const abvSchief = sorten.filter((s) => {
      const m = String(s.legalRight || '').match(/([\d,.]+)\s*%\s*vol/i);
      return m && Math.abs(parseFloat(m[1].replace(',', '.')) - Number(s.abv)) > 0.01;
    });
    if (abvSchief.length) {
      out.push(befund('abv', 'Alkoholangaben', 'alarm',
        `Pflichttext und Feldwert weichen ab bei: ${abvSchief.map((s) => s.name).join(', ')}`));
    }

    // Nachproduktion: der Shop verspricht dann 2–4 Wochen statt 3–7 Tagen.
    const nach = sorten.filter((s) => s.nachproduktion);
    if (nach.length === sorten.length) {
      out.push(befund('nachproduktion', 'Verfügbarkeit', 'alarm',
        'alle Sorten stehen auf Nachproduktion — jede Bestellung wird mit 2–4 Wochen kommuniziert'));
    } else if (nach.length) {
      out.push(befund('nachproduktion', 'Verfügbarkeit', 'warn',
        `${nach.length} Sorte(n) in Nachproduktion: ${nach.map((s) => s.name).join(', ')}`));
    } else {
      const knapp = sorten.filter((s) => Number.isFinite(s.sofortQty) && s.sofortQty > 0 && s.sofortQty < (ctx.cfg.schwellen.sofortKnapp ?? 400));
      out.push(knapp.length
        ? befund('nachproduktion', 'Verfügbarkeit', 'warn',
            `knapper Sofort-Bestand: ${knapp.map((s) => `${s.name} (${s.sofortQty})`).join(', ')}`)
        : befund('nachproduktion', 'Verfügbarkeit', 'ok', 'alle Sorten sofort lieferbar'));
    }
  }

  // ---- Preisstaffel ---------------------------------------------------------
  const tiers = Array.isArray(boot.tiers) ? boot.tiers : [];
  if (tiers.length < 2) {
    out.push(befund('preise', 'Preisstaffel', 'alarm', 'Preisstaffel fehlt oder hat weniger als zwei Stufen'));
  } else {
    const fehler = [];
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i].qty <= tiers[i - 1].qty) fehler.push(`Menge nicht aufsteigend bei ${tiers[i].qty}`);
      if (tiers[i].packPrice <= tiers[i - 1].packPrice) fehler.push(`Paketpreis fällt bei ${tiers[i].qty} Flaschen`);
      if (tiers[i].perBottle > tiers[i - 1].perBottle + 1e-9) fehler.push(`Flaschenpreis steigt bei ${tiers[i].qty} Flaschen`);
    }
    const einstieg = tiers[0];
    if (einstieg.qty !== (ctx.cfg.schwellen.mindestmenge ?? 25)) {
      fehler.push(`Mindestmenge ist ${einstieg.qty} statt ${ctx.cfg.schwellen.mindestmenge ?? 25}`);
    }
    out.push(fehler.length
      ? befund('preise', 'Preisstaffel', 'alarm', fehler.join('; '))
      : befund('preise', 'Preisstaffel', 'ok',
          `${tiers.length} Stufen, ${einstieg.qty} Fl. ab ${eur(einstieg.packPrice)}, günstigste ${eur(tiers[tiers.length - 1].perBottle)}/Fl.`));

    const dP = ctx.drift('konf.preise', tiers.map((t) => `${t.qty}:${t.packPrice}`).join('|'));
    if (dP.geaendert && dP.vorher) {
      const alt = Object.fromEntries(dP.vorher.split('|').map((x) => x.split(':')));
      const geaendert = tiers.filter((t) => alt[t.qty] !== undefined && Number(alt[t.qty]) !== t.packPrice)
        .map((t) => `${t.qty} Fl.: ${eur(Number(alt[t.qty]))} → ${eur(t.packPrice)}`);
      out.push(befund('preise.drift', 'Preisänderung', 'info',
        geaendert.length ? geaendert.join(', ') : 'Staffel hat sich geändert (Stufen hinzugefügt oder entfernt)'));
    }
  }

  // ---- Versandstaffel -------------------------------------------------------
  const versand = boot.versand || {};
  const versandFehler = [];
  for (const [land, stufen] of Object.entries(versand)) {
    if (!Array.isArray(stufen) || !stufen.length) { versandFehler.push(`${land}: keine Stufen`); continue; }
    const sortiert = [...stufen].sort((a, b) => a.from - b.from);
    for (let i = 1; i < sortiert.length; i++) {
      if (sortiert[i].from <= sortiert[i - 1].to) versandFehler.push(`${land}: Stufen überlappen bei ${sortiert[i].from}`);
    }
    if (sortiert.some((s) => !(s.cost > 0))) versandFehler.push(`${land}: Stufe ohne Preis`);
  }
  out.push(versandFehler.length
    ? befund('versand', 'Versandkosten', 'alarm', versandFehler.join('; '))
    : befund('versand', 'Versandkosten', 'ok',
        Object.entries(versand).map(([l, s]) => `${l} ab ${eur(Math.min(...s.map((x) => x.cost)))}`).join(', ')));

  // ---- Lieferzeit (Trusted-Shops-relevant) ----------------------------------
  const lz = boot.lieferzeit || {};
  const erwartet = ctx.cfg.shop.lieferzeitMuster ?? '\\d+\\s*[–-]\\s*\\d+\\s*Werktag';
  out.push(new RegExp(erwartet).test(String(lz.bullet || ''))
    ? befund('lieferzeit', 'Lieferzeit', 'ok', lz.bullet)
    : befund('lieferzeit', 'Lieferzeit', 'warn',
        `Lieferzeit-Text weicht vom erwarteten Muster ab: "${lz.bullet || '(leer)'}"`));

  const dL = ctx.drift('konf.lieferzeit', String(lz.bullet || ''));
  if (dL.geaendert && dL.vorher) {
    out.push(befund('lieferzeit.drift', 'Lieferzeit geändert', 'info', `"${dL.vorher}" → "${lz.bullet}"`));
  }

  ctx.boot = boot; // die Faktenprüfung in seo.mjs vergleicht dagegen
  return out;
}
