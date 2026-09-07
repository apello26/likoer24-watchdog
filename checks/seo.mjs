/**
 * Die Türen zur Seite — für Google und für KI-Antwortmaschinen.
 *
 * Hier geht es nicht um Rankings (die schwanken und brauchen Wochen), sondern
 * um die Dinge, die still kaputtgehen und dann monatelang Besucher kosten:
 * ein versehentliches noindex, eine 404 in der Sitemap, ein leergelaufenes
 * llms.txt, ein Redirect, der ins Nichts zeigt.
 *
 * Dazu ein Abgleich, den sonst niemand macht: Stimmen die Zahlen, die wir
 * Maschinen vorlegen (llms.txt), noch mit denen im Konfigurator überein?
 * Ein veraltetes llms.txt heißt, dass ChatGPT und Co. falsche Preise nennen.
 */

import { befund, holenWeich, holenOhneFolgen, bootVon, titelVon, h1Von, metaBeschreibung, canonicalVon, jsonLdVon, schemaTypen } from '../lib/kern.mjs';

export const name = 'Sichtbarkeit';

const KI_CRAWLER = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'OAI-SearchBot'];

export async function run(ctx) {
  const out = [];
  const basis = ctx.cfg.shop.basis;

  // Normalerweise hat der Konfigurator-Check die Seite schon geladen. Läuft
  // diese Gruppe einzeln (--nur=seo), holen wir sie selbst nach — sonst
  // fehlten stillschweigend der Faktenabgleich und die Schema-Prüfung.
  if (!ctx.konfHtml) {
    const r = await holenWeich(basis + '/konfigurator/', { timeoutMs: ctx.cfg.shop.timeoutMs });
    if (r.status === 200) ctx.konfHtml = r.text;
  }
  if (!ctx.boot && ctx.konfHtml) ctx.boot = bootVon(ctx.konfHtml);

  // ---- robots.txt ------------------------------------------------------------
  const robots = await holenWeich(basis + '/robots.txt');
  if (robots.status !== 200 || robots.groesse < 20) {
    out.push(befund('robots', 'robots.txt', 'alarm', `HTTP ${robots.status || robots.fehler}`));
  } else {
    const gruppen = robotsGruppen(robots.text);
    const probleme = [];

    // Nur ein "Disallow: /" in der Gruppe für alle sperrt wirklich die Seite.
    // Dieselbe Zeile bei SemrushBot & Co. ist gewollt und harmlos.
    const alle = gruppen.find((g) => g.agenten.includes('*'));
    if (!alle) probleme.push('keine Gruppe für "User-agent: *"');
    else if (alle.regeln.some((r) => /^Disallow:\s*\/\s*$/i.test(r))) probleme.push('sperrt die komplette Seite (Disallow: / für alle)');
    if (!/^\s*Sitemap:\s*http/mi.test(robots.text)) probleme.push('keine Sitemap-Zeile');

    out.push(probleme.length
      ? befund('robots', 'robots.txt', 'alarm', probleme.join('; '))
      : befund('robots', 'robots.txt', 'ok', 'Sitemap eingetragen, keine Aussperrung'));

    // KI-Crawler sollen unter "*" laufen. Eine eigene Gruppe für sie ersetzt
    // die *-Gruppe komplett — sperrt sie also entweder aus oder hebelt die
    // Schutzregeln für Warenkorb und Kasse aus. Beides will man wissen.
    const eigene = gruppen.filter((g) => g.agenten.some((a) => KI_CRAWLER.some((bot) => bot.toLowerCase() === a.toLowerCase())));
    const ausgesperrt = eigene.filter((g) => g.regeln.some((r) => /^Disallow:\s*\/\s*$/i.test(r)));
    if (ausgesperrt.length) {
      out.push(befund('kicrawler', 'KI-Crawler', 'alarm',
        `ausgesperrt: ${ausgesperrt.flatMap((g) => g.agenten).join(', ')} — keine Zitate mehr in KI-Antworten`));
    } else if (eigene.length) {
      out.push(befund('kicrawler', 'KI-Crawler', 'warn',
        `eigene robots-Gruppe für ${eigene.flatMap((g) => g.agenten).join(', ')} — sie ersetzt die *-Gruppe und hebelt deren Schutzregeln aus`));
    } else {
      out.push(befund('kicrawler', 'KI-Crawler', 'ok', 'laufen unter "User-agent: *" mit'));
    }
  }

  // ---- Sitemap ---------------------------------------------------------------
  const index = await holenWeich(basis + '/sitemap_index.xml');
  if (index.status !== 200) {
    out.push(befund('sitemap', 'Sitemap', 'alarm', `Index nicht erreichbar (HTTP ${index.status || index.fehler})`));
  } else {
    const unter = [...index.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    let urls = 0;
    const kaputt = [];
    for (const u of unter) {
      const s = await holenWeich(u);
      if (s.status !== 200) { kaputt.push(`${u} → HTTP ${s.status || s.fehler}`); continue; }
      urls += [...s.text.matchAll(/<loc>([^<]+)<\/loc>/g)].length;
    }
    const d = ctx.drift('seo.sitemapUrls', urls);
    const eingebrochen = Number.isFinite(Number(d.vorher)) && urls < Number(d.vorher) * 0.7;
    out.push(kaputt.length
      ? befund('sitemap', 'Sitemap', 'alarm', kaputt.join('; '))
      : eingebrochen
        ? befund('sitemap', 'Sitemap', 'warn', `nur noch ${urls} URLs (vorher ${d.vorher})`)
        : befund('sitemap', 'Sitemap', 'ok', `${unter.length} Teil-Sitemap(s), ${urls} URLs`));
  }

  // ---- llms.txt --------------------------------------------------------------
  const llms = await holenWeich(basis + '/llms.txt');
  if (llms.status !== 200 || llms.groesse < 300) {
    out.push(befund('llms', 'llms.txt', 'warn',
      llms.status === 200 ? `nur ${llms.groesse} Bytes — wirkt leer` : `HTTP ${llms.status || llms.fehler}`));
  } else {
    out.push(befund('llms', 'llms.txt', 'ok', `${Math.round(llms.groesse / 1024)} KB`));

    // Faktenabgleich gegen den Konfigurator.
    const boot = ctx.boot;
    if (boot?.tiers?.length) {
      const schief = [];
      const t0 = boot.tiers[0];
      const preisTexte = [...llms.text.matchAll(/(\d+[.,]\d{2})\s*€/g)].map((m) => Number(m[1].replace(',', '.')));
      if (!preisTexte.includes(Number(t0.packPrice.toFixed(2)))) {
        schief.push(`Einstiegspreis ${t0.packPrice.toFixed(2).replace('.', ',')} € steht nicht in llms.txt`);
      }
      const mindest = (llms.text.match(/Mindest(?:bestell)?menge:?\s*(\d+)/i) || [])[1];
      if (mindest && Number(mindest) !== t0.qty) {
        schief.push(`Mindestmenge: llms.txt sagt ${mindest}, Konfigurator ${t0.qty}`);
      }
      const sortenZahl = (llms.text.match(/\((\d+)\s+befüllte\s+Sorten/i) || [])[1];
      const echteSorten = (boot.sorten || []).filter((s) => s.abv > 0).length;
      if (sortenZahl && Number(sortenZahl) !== echteSorten) {
        schief.push(`Sorten: llms.txt sagt ${sortenZahl}, Konfigurator hat ${echteSorten} befüllte`);
      }
      const lz = String(boot.lieferzeit?.bullet || '').match(/(\d+\s*[–-]\s*\d+)\s*Werktag/);
      if (lz && !llms.text.includes(lz[1])) {
        schief.push(`Lieferzeit "${lz[1]} Werktage" fehlt in llms.txt`);
      }
      out.push(schief.length
        ? befund('fakten', 'Fakten für KI-Antworten', 'warn',
            `llms.txt weicht vom Konfigurator ab — KI-Assistenten nennen dann falsche Angaben`, schief)
        : befund('fakten', 'Fakten für KI-Antworten', 'ok', 'llms.txt deckt sich mit dem Konfigurator'));
    }
  }

  // ---- Landingpages ----------------------------------------------------------
  const kaputteSeiten = [];
  const maengel = [];
  const feinschliff = [];
  for (const pfad of ctx.cfg.seo.seiten) {
    const r = await holenWeich(basis + pfad, { timeoutMs: ctx.cfg.shop.timeoutMs });
    if (r.status !== 200) { kaputteSeiten.push(`${pfad} → HTTP ${r.status || r.fehler}`); continue; }

    // Ein versehentliches noindex ist der teuerste stille Fehler überhaupt.
    if (/<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(r.text)) {
      kaputteSeiten.push(`${pfad} steht auf noindex`);
      continue;
    }
    const titel = titelVon(r.text);
    const h1Zahl = (r.text.match(/<h1[\s>]/gi) || []).length;
    const beschreibung = metaBeschreibung(r.text);
    const canonical = canonicalVon(r.text);
    const ld = jsonLdVon(r.text);

    if (!titel) maengel.push(`${pfad}: kein Titel`);
    else if (titel.length > 65) feinschliff.push(`${pfad}: Titel ${titel.length} Zeichen (wird in den Suchergebnissen abgeschnitten)`);
    if (!beschreibung) maengel.push(`${pfad}: keine Meta-Description`);
    if (h1Zahl !== 1) maengel.push(`${pfad}: ${h1Zahl} H1-Überschriften`);
    if (!canonical) maengel.push(`${pfad}: kein Canonical`);
    else if (!canonical.replace(/\/$/, '').endsWith(pfad.replace(/\/$/, ''))) {
      maengel.push(`${pfad}: Canonical zeigt auf ${canonical}`);
    }
    if (ld.includes(null)) maengel.push(`${pfad}: kaputtes JSON-LD`);
  }
  out.push(kaputteSeiten.length
    ? befund('seiten', 'Landingpages', 'alarm', kaputteSeiten.join('; '))
    : maengel.length
      ? befund('seiten', 'Landingpages', 'warn', `${maengel.length} Mangel/Mängel auf ${ctx.cfg.seo.seiten.length} Seiten`, maengel)
      : befund('seiten', 'Landingpages', 'ok', `alle ${ctx.cfg.seo.seiten.length} Seiten sauber`));
  if (feinschliff.length) {
    out.push(befund('feinschliff', 'Feinschliff', 'info',
      `${feinschliff.length} Kleinigkeit(en) ohne Eile`, feinschliff));
  }

  // Strukturierte Daten auf dem Konfigurator — die Grundlage für Rich Results.
  if (ctx.konfHtml) {
    const typen = schemaTypen(jsonLdVon(ctx.konfHtml));
    const fehlt = (ctx.cfg.seo.schemaTypen ?? []).filter((t) => !typen.includes(t));
    out.push(fehlt.length
      ? befund('schema', 'Strukturierte Daten', 'warn', `fehlende Typen auf /konfigurator/: ${fehlt.join(', ')}`)
      : befund('schema', 'Strukturierte Daten', 'ok', typen.length ? typen.join(', ') : 'vorhanden'));
  }

  // ---- Weiterleitungen --------------------------------------------------------
  if (ctx.cfg.seo.weiterleitungen?.length) {
    const fehler = [];
    for (const { von, nach } of ctx.cfg.seo.weiterleitungen) {
      const r = await holenOhneFolgen(basis + von);
      const ziel = r.headers?.get?.('location') || '';
      if (r.status < 300 || r.status >= 400) fehler.push(`${von} → HTTP ${r.status} statt 301`);
      else if (nach && !ziel.replace(/\/$/, '').endsWith(nach.replace(/\/$/, ''))) fehler.push(`${von} → ${ziel} (erwartet ${nach})`);
    }
    out.push(fehler.length
      ? befund('weiterleitungen', 'Weiterleitungen', 'warn', fehler.join('; '))
      : befund('weiterleitungen', 'Weiterleitungen', 'ok', `${ctx.cfg.seo.weiterleitungen.length} Stichproben führen sauber ans Ziel`));
  }

  return out;
}

/**
 * robots.txt in Gruppen zerlegen: aufeinanderfolgende User-agent-Zeilen
 * gehören zusammen, danach folgen deren Regeln bis zur nächsten Gruppe.
 */
function robotsGruppen(text) {
  const gruppen = [];
  let aktuell = null;
  for (const roh of text.split('\n')) {
    const zeile = roh.replace(/#.*$/, '').trim();
    if (!zeile) continue;
    const ua = zeile.match(/^User-agent:\s*(.+)$/i);
    if (ua) {
      if (!aktuell || aktuell.regeln.length) { aktuell = { agenten: [], regeln: [] }; gruppen.push(aktuell); }
      aktuell.agenten.push(ua[1].trim());
    } else if (aktuell && /^(Dis)?allow:/i.test(zeile)) {
      aktuell.regeln.push(zeile);
    }
  }
  return gruppen;
}
