# Likoer24-Watchdog

Täglicher Rundgang durch den Live-Shop. Er prüft, ob verkauft werden kann,
ob jede bezahlte Bestellung sauber durch Druck, Bestand und Versand läuft,
ob der Server sich beschwert und ob die Türen für Google und KI-Antwort-
maschinen offen stehen.

**Er liest nur.** Kein Deploy, kein Schreibzugriff, keine Änderung an
Bestellungen oder Dateien. Ein Wächter, der nachts selbst eingreifen darf,
kann nachts auch selbst etwas kaputt machen.

## Betrieb

Läuft auf dem Pi (`thomas-hub`) als systemd-Timer, täglich 07:00, 13:00 und 19:00.

```bash
systemctl --user status likoer24-watchdog.timer   # läuft er?
systemctl --user start likoer24-watchdog.service  # jetzt sofort laufen lassen
tail -n 60 ~/likoer24-watchdog/state/lauf.log     # letzter Lauf im Klartext
```

(Das Benutzer-Journal ist auf dem Pi nicht dauerhaft, deshalb die eigene
Logdatei — `journalctl --user` liefert nichts.)

Der Mac ist die Arbeitskopie, der Pi der Betrieb — wie beim Dashboard:

```bash
rsync -av --exclude 'state/' ~/Documents/Likoer24/likoer24-watchdog/ thomas@thomas-hub.local:~/likoer24-watchdog/
```

## Von Hand aufrufen

```bash
node watchdog.mjs                 # voller Lauf, meldet Änderungen per Telegram
node watchdog.mjs --kein-push     # dasselbe ohne Meldung (zum Ausprobieren)
node watchdog.mjs --nur=server    # nur eine Gruppe
node watchdog.mjs --json          # Ergebnis als JSON auf stdout
```

Ein Lauf dauert etwa 30 Sekunden — der Klickpfad-Test mit echtem Browser macht
den Löwenanteil aus.

```bash
node watchdog.mjs --nur=klickpfad --kein-push                         # nur den Bedien-Test gegen den Live-Shop
LK24_KLICKPFAD_URL=http://127.0.0.1:8767/dev-tools/ui-verify/index.html \
  node watchdog.mjs --nur=klickpfad --kein-push                       # gegen den lokalen UI-Harness (Deploy-Gate)
```

Der zweite Aufruf ist der Griff vor jedem Konfigurator-Deploy: erst den
Harness starten (launch.json „konfig-verify"), dann den Klickpfad dagegen
laufen lassen. Ein Build, der auf dem Handy den Weiter-Knopf verliert, fällt
hier durch, bevor er hochgeladen wird.

```bash
node watchdog.mjs --nur=consent --kein-push                           # Consent-Leck-Test gegen den Live-Shop (~3 min)
```

Der Griff nach jedem Deploy, der Consent, Tracking, GTM, WooCommerce-Einstellungen
oder ein Plugin mit Frontend-Skripten berührt (und nach dem Löschen des
WPFC-Caches), ebenso nach jedem Update von Brevo oder PayPal Payments (deren
Abschaltung hängt an Handles und Methodennamen): Ein neues Leck steht dann
sofort als roter oder gelber Befund da — und umgekehrt fällt auf, wenn die
PayPal-Abschaltung zu breit greift und im Warenkorb nichts mehr lädt
(`kauf-paypal`, rot).

## Was geprüft wird

**Erreichbarkeit** — Startseite, Konfigurator, Warenkorb, Kasse, REST-Schnittstelle.
Nicht nur "HTTP 200": eine WordPress-Fehlerseite kommt fröhlich als 200 zurück,
deshalb zusätzlich Pflichttexte, Mindestgrößen und die üblichen Verdächtigen
(kritischer Fehler, keine Datenbank, Wartungsmodus, volle Platte).

**Konfigurator** — die Zahlen, die der Kunde sieht, kommen aus `LK24_BOOT`:
Sorten mit Los-Kennzeichnung (§ 1 LKV) und stimmigem Alkoholgehalt, monotone
Preisstaffel, lückenlose Versandstaffel, Lieferzeit-Text, Nachproduktions-Lage.
Dazu die ausgelieferten Dateien: ändert sich `configurator.js` ohne Versions-Bump,
liefern Browser und Cache tagelang die alte Fassung aus — genau das meldet er.

**Bestellungen** — kommt noch etwas rein (gemessen am eigenen üblichen Abstand,
nicht an einer festen Stundenzahl), und läuft jede bezahlte Bestellung durch:
Druck-PDF erzeugt, im Verkaufstracker gebucht, rechtzeitig übergeben. Die
Marker des Plugins werden mitgelesen — fehlgeschlagener Snapshot, Farb-Drift
im Etikett (Dark-Mode-Verdacht), automatisch geheilte Vorschau.

**Server** — das Apache-/PHP-Fehlerprotokoll der letzten 24 Stunden über FTP:
Fatal errors, gesprengtes Speicherlimit, Datenbankfehler und der bekannte
nächtliche `No space left on device`. Dazu Wartungsmodus, Änderungen an der
Plugin-Datei auf dem Server und ein voll laufender Upload-Ordner.

**Funnel** — kommt noch jemand bis zum Warenkorb? Zwei Signale, die sich
gegenseitig absichern: Die Zeitstempel der Vorschau-Uploads im Upload-Ordner
zählen die Druckfreigaben der letzten 24 und 48 Stunden gegen die Tage davor —
ohne Consent, ohne Tracker, für jeden Kunden. Dazu die Schrittquoten je Gerät
aus dem Analytics-Plugin: Wie viele Handy-Sessions kommen über Schritt 2
hinaus, wie viele bis zur Druckfreigabe, wie viele in den Warenkorb — verglichen
mit den vier Wochen davor (Binomialtest, gemeldet wird die Wahrscheinlichkeit,
dass so ein Einbruch Zufall ist). Nach einem Versionswechsel hält er zusätzlich
„seit dem Deploy" gegen „davor", damit ein Deploy, der den Funnel bricht,
binnen eines Tages einen Namen bekommt.

**Klickpfad** — der einzige Check, der den Shop bedient statt ihn anzusehen.
Ein echtes Chromium (headless, Handy-Viewport, Fingertipp) geht den Weg Stil →
Sorten/Menge → Text → Druckfreigabe → Bestellübersicht und prüft nach jedem
Schritt, ob der nächste Knopf sichtbar ist, im sichtbaren Bereich liegt und den
Tipp bekommt (`elementFromPoint`). Dazu die Fälle, die am 03.–06.09.2026 vier
Tage lang unentdeckt blieben: kleinerer Viewport (eingeblendete Browserleisten),
Pinch-Zoom und die Rückkehr des Knopfs nach der Tastatur. Der Weg endet vor dem
Warenkorb — gekauft wird nichts. Consent wird abgelehnt, der User-Agent trägt
„likoer24-watchdog". Braucht `/usr/bin/chromium` (Pi: `sudo apt install
chromium`) oder Google Chrome auf dem Mac; fehlt der Browser, gibt es einen
Hinweis statt eines Alarms. Kein npm-Paket: der Browser wird über seine eigene
DevTools-Pipe gesteuert (`lib/browser.mjs`).

**Consent-Leck** — lädt der Shop Tracker, bevor jemand „Ok" gesagt hat?
Ein echtes Chromium lädt Startseite, `/konfigurator/` und `/hochzeit/` als
Erstbesucher (je Seite ein frischer Browser-Kontext ohne Cookies, Handy und
Desktop, ohne Query-String — also die WPFC-Cache-Fassung, die echte Besucher
bekommen; `/konfigurator/` ist ohnehin ungecacht) und schreibt jeden Request
mit, auch aus Iframes, dazu jeden Cookie — auch einen, der per JavaScript
gesetzt und gleich wieder gelöscht wird. Dann tippt er „Ablehnen" und schaut
weiter zu; lädt consent.js dabei nicht selbst neu (ab Consent 0.2.0), ruft er
die Seite als Ablehner noch einmal frisch auf. Die Treffer landen in drei Töpfen,
die oben in `checks/consent-leck.mjs` stehen:

- **FEHLER** (Alarm): googletagmanager.com, google-analytics.com /
  analytics.google.com, googleadservices.com, doubleclick.net,
  googlesyndication.com, Ads-Pings an google.<tld> (ccm/pagead/rmkt/ads),
  connect.facebook.net, facebook.com/tr, reCAPTCHA, Bing/Clarity/TikTok/
  Pinterest/Hotjar/LinkedIn; Cookies `_ga*`, `_gid`, `_gcl*`, `_fbp`/`_fbc`,
  `sbjs_*`, `lk24a_sid`/`lk24a_vid`; Sessions/Events des eigenen Trackers.
  Die cookielosen Zähler (reach-hit, reach-consent, konfig-agg) sind erlaubt.
  Seit Consent 0.2.0 außerdem (per Code abgeschaltet, `class-fremd-haertung.php`
  im Consent-Plugin):
  - **Brevo**: `cdn.brevo.com/js/sdk-loader.js`, `sibautomation.com`,
    `in-automate.brevo.com`, Cookies `sib_cuid`, `tracking_email`, `email_id` —
    und der **E-Mail-Mitleser** (Footer-Listener, der jede eingetippte Adresse
    ins Cookie `tracking_email` schreibt und per admin-ajax an Brevo meldet).
    Der sendet erst, wenn jemand ein E-Mail-Feld verlässt; deshalb erkennt der
    Check ihn am HTML (Inline-Skript, das `tracking_email` schreibt und per
    `the_ajax_hook` meldet), ebenso den Brevo-Init (`window.Brevo … init`).
  - **PayPal Payments** auf Nicht-Kaufseiten: `paypal.com`, `paypalobjects.com`,
    Google Pay (`pay.google.com/gp/p/js/pay.js`), Apple Pay
    (`applepay.cdn-apple.com`) und die Plugin-Skripte selbst
    (`/wp-content/plugins/woocommerce-paypal-payments/…js`). Wo PayPal hingehört,
    zählt es nicht (`KAUFSEITE` im Check) — genau die Freigabeliste der Härtung:
    Warenkorb, Kasse (`/check-out/`, samt order-pay und Danke-Seite) und im Konto
    **nur** die Zahlungsmethoden (`payment-methods`, `add-payment-method`, auch
    deutsche Slugs wie `zahlungsmethoden`). Konto-Dashboard und Bestellungen sind
    keine Kaufseiten — lädt PayPal dort, ist das ein Alarm. Die German-Market-
    Prüfseite (nur mit „Bestellung prüfen" aktiv) hat keinen festen Slug; ihren
    Pfad bei Bedarf in `consentLeck.kaufSeitenExtra` eintragen.

  Der Alarm nennt bei Brevo/PayPal gleich, wo man nachsieht: Kill-Switch-Filter
  (`lk24c_fremd_*`) an, alte WPFC-Cache-Datei, Plugin-Update mit neuem Handle.
- **BEKANNT** (gelb, „wartet auf Thomas"): Trusted Shops (Entscheidung des DSB)
  und Google Fonts im Konfigurator (selbst hosten). Ist eins abgestellt, dort
  `art: 'fehler'` setzen — ein Rückfall wird dann rot. Bewusst Hingenommenes
  (z. B. nach Entscheidung des DSB) bekommt `art: 'erlaubt'`.
- **fremd** (gelb): jeder andere Drittanbieter vor der Einwilligung — damit ein
  neues Leck (wie Brevo um den 28.09.2026) beim ersten Lauf auffällt. Harmloses
  kommt in `ERLAUBT`, Tracker in `FEHLER`.

Dazu: öffnet sich das Banner, reagiert „Ablehnen" auf Fingertipp/Mausklick,
wird die Entscheidung gespeichert, bleibt das Banner beim nächsten Aufruf zu —
und löst das Ablehnen selbst etwas aus? Ein Reload nach „Ablehnen" ist bis
Consent 0.1.9 normal und nur ein Hinweis.

Dann die **Gegenprobe „Ok"** (Handy, `/konfigurator/`, frischer Kontext). Seit
Consent 0.2.0 lädt die Seite nach „Ok" **nicht** mehr neu; die Gates schalten
in derselben Seitenansicht frei. Erwartet wird dort, ohne weiteren
Seitenaufruf:

- eigener Tracker: `session-init` mit 2xx (ab Analytics 0.8.0 verwirft der
  Server die Wächter-Session still — 200 mit `X-LK24A-Drop: bot`, die Details
  sagen „vom Server als Bot verworfen"), genau ein `page_view` der aktuellen
  Seite, `landing` = diese Seite;
- GTM (`gtm.js` 200/304) und GA4: Site Kits Google-Tag lädt, und schon der
  **erste** GA4-Hit trägt die Zustimmung (`gcs=G111`) — kein denied-Ping vorneweg;
- Meta-Pixel (`fbevents.js`), sofern die Meta-Brücke eingebunden ist;
- Google-Ads-Tag (`gtag/js?id=AW-…`), sofern der Ads-Loader (`#lk24a-gads`) im
  HTML steht;
- `likoer24-consent-updated` mit `detail.reload=false` — genau das, worauf sich
  die Gates verlassen.

Fehlt dort etwas, ruft er die Seite noch einmal auf: läuft es dann, ist das gelb
(„startet erst beim nächsten Seitenaufruf" — die erste Seitenansicht fehlt);
läuft es auch dann nicht, ist es rot (Tracker startet nicht, `session-init` mit
4xx/5xx, GTM lädt nicht, GA4 lädt gar nicht). Wurde `session-init` in derselben
Ansicht gesendet, kam die Antwort aber nur zu spät (langsamer Server), sagt der
Befund genau das — und nicht „startet erst beim nächsten Seitenaufruf".

Gelb sind außerdem:

- „Ok" reagiert nicht auf Tipp/Klick, nur programmatisch (verdeckt von …) — ein
  Overlay oder eine Bottom-Bar über dem Knopf kostet Einwilligungen, auch wenn
  danach alles sauber misst;
- **doppelt gestartet** in derselben Seitenansicht: `gtm.js` je Container,
  GA4-`page_view` je Property, `fbevents.js`, Meta-`PageView` je Pixel oder
  `session-init` (2xx) mehr als einmal — das heißt Doppelzählung in GA4, Ads,
  Meta und Sessions (Ladepfad und Listener starten beide). `gtag/js` zählt nicht:
  der AW-Tag holt den GT-Tag nach und umgekehrt, zweimal ist dort normal;
- `landing` im `session-init` ist nicht die Seite, auf der zugestimmt wurde
  (Kanalzuordnung falsch);
- kein `likoer24-consent-updated` nach „Ok" (daran hängen alle Gates);
- ein Reload nach „Ok": der Befund nennt den Grund — alte Inline-Gates ohne
  Listener im HTML (WPFC-Cache von vor Analytics 0.8.0, consent.js lädt dann
  absichtlich neu → Cache der Seite leeren) oder noch die alte consent.js 0.1.9;
- ein erster GA4-Hit ohne `G111`, ein doppelter `page_view`, ein Event, das etwas
  anderes ankündigt als passiert (`reload=true`, aber kein Reload — oder
  umgekehrt), und Brevo/PayPal, die erst nach der Zustimmung auftauchen.

Optional (`zustimmungGclid: true`) läuft die Gegenprobe auf
`/konfigurator/?gclid=lk24-watchdog-probe`; dann muss nach „Ok" das Cookie
`_gcl_aw` stehen, sonst geht der Ads-Klick für die Kauf-Conversion verloren (gelb).
Erst einschalten, wenn Analytics 0.8.0 live ist — vorher zählt der
Reichweitenzähler den Wächter-Besuch sonst als Ads-Klick.

Dann die **Teil-Einwilligungen** (`TEIL_PROFILE` im Check) auf einer
gecachten Landingpage (Desktop, `/hochzeit/`), je Profil zweimal — genau dort
lagen Lecks, die „Ablehnen" und „Ok" nie sehen:

- als **Wiederkehrer** (`teil-statistik`, `teil-marketing`): `lk24_consent`-Cookie
  vorbelegt (Version wie eben von consent.js geschrieben), das Gate greift beim
  Laden;
- **im Banner gewählt** (`teil-statistik-banner`, `teil-marketing-banner`):
  Erstbesucher tippt „Einstellungen" → Schalter → „Auswahl speichern". Kein
  Reload — hier schalten die Gates per Listener in der laufenden Seite frei,
  und jeder Listener muss seine eigene Kategorie prüfen. Ausgewertet wird ab
  dem Speichern. Gespeichert wird etwas anderes als gewählt → rot; die Auswahl
  klappt nicht per Tipp/Klick („Einstellungen", ein Schalter oder „Auswahl
  speichern" reagiert nur programmatisch — die Details nennen je Schritt den Weg
  und was den Knopf verdeckt), das Banner bleibt offen, die Seite lädt neu oder
  etwas startet doppelt → gelb.

Regeln je Profil:

- **„Nur Statistik"**: erlaubt sind Site Kits Google-Tag (`gtag/js?id=GT-…`),
  GA4-Hits mit `gcs=G101` (schon der erste), der eigene Tracker und sbjs. Alarm
  bei `gtm.js` (Entscheidung E1: GTM erst mit Marketing), `gtag/js?id=AW-…`,
  Ads/DoubleClick/googlesyndication/google.<tld>-Pings, Meta, `_gcl*`/`_fbp`-
  Cookies und bei GA4 mit `ad_storage` granted (`gcs=G11x`). Kein GA4-Hit ist
  gelb, im Banner-Fall auch ein fehlendes `session-init`.
- **„Nur Marketing"**: GTM, Ads und Meta sind erlaubt. Alarm bei jedem GA4-Hit
  (`*/g/collect`, auch über den AW-gtag, der Site Kits vorgemerktes
  `config GT-…` abarbeitet), `_ga*`-Cookies, eigenem Tracker (lk24a, Sessions/
  Events) und sbjs. Lädt GTM nicht, ist das gelb (Ads-Messung fehlt).

Öffnet sich trotz vorbelegtem Cookie das Banner (neue `CONSENT_VERSION`?), ist
der Befund gelb „nicht auswertbar" statt fälschlich grün. Fällt E1 bei einem
späteren Deploy zurück — beim Laden oder erst im Listener nach der Banner-Wahl —,
wird „Nur Statistik" rot.

Dann der **Widerruf** (`widerruf`, Handy, `/hochzeit/`, frischer Kontext): „Ok",
die Tags ein paar Sekunden laufen lassen, dann den „Datenschutz"-Knopf (mobil das
Schloss unten rechts) tippen und im Dialog „Ablehnen". Das ist seit Consent
0.2.0 der einzige Weg, auf dem consent.js noch neu lädt — nur so sind laufende
Tags wirklich weg. Erwartet: Event `reload=true`, binnen 2,5 s ein neues
Dokument, Cookie mit allen Kategorien aus, danach kein Tracker (Requests und
per JavaScript gesetzte Cookies, gezählt ab dem Dokumentwechsel). Rot sind: der
„Datenschutz"-Knopf fehlt oder öffnet nichts, „Ablehnen" im Dialog wirkt nicht,
der Widerruf wird nicht gespeichert, die Seite lädt **nicht** neu (dann laufen
GTM, GA4, Meta und Tracker in der Ansicht weiter) oder nach dem Reload lädt
wieder ein Tracker. Gelb ist, was die sterbende Seite nach dem Klick noch sendet
(mit Ereignisnamen, z. B. `facebook.com/tr ev=SubscribedButtonClick` oder ein
GA4-Ping), ein Knopf, der nur programmatisch reagiert, ein Event, das nicht zum
Verhalten passt, und ein Banner, das nach dem Widerruf wieder aufgeht. Brevo und
PayPal zählen hier nicht (seitenbasiert, stehen schon beim Erstbesuch). Die
Details nennen, was vorher lief, und welche Cookies aus der Zustimmung im
Browser liegen bleiben (`_ga`, `_gcl_au`, `_fbp` — reine Info).

Zum Schluss die **Positivprobe Warenkorb** (`kauf-paypal`, Desktop, `/cart/`,
leer, frischer Kontext, nur lesend): Dort **muss** PayPal Payments laden — das
Plugin-Skript (`ppcp-smart-button`) und das PayPal-SDK (`paypal.com/sdk/js`).
Fehlt eins davon, ist das rot: Die Abschaltung auf Nicht-Kaufseiten greift zu
breit (Seitentyp beim Hook falsch erkannt, Filter
`lk24c_fremd_paypal_seite_erlaubt`, PayPal-Update mit neuer Abhängigkeit), und
PayPal-Kunden können nicht zahlen. Antwortet nur das SDK mit einem Fehler, ist
es gelb (Störung bei PayPal?). Leitet `/cart/` woandershin um, ist der Befund
„nicht auswertbar" (`consentLeck.kaufSeite` anpassen). Die Kasse (`/check-out/`)
leitet mit leerem Warenkorb auf `/cart/` um und lässt sich ohne Artikel — also
ohne Schreibzugriff — nicht prüfen; sie läuft in der Härtung aber durch denselben
`is_cart()`/`is_checkout()`-Zweig. FraudNet- und Statistik-Beacons von PayPal
fängt der Browser ab.

Der Wächter füttert dabei niemanden: Die Messpunkte von GA4, Ads, Meta & Co.
(collect, pagead, facebook.com/tr, GTM-Diagnose-Pings), Brevos Besucher-Ping
(`in-automate.brevo.com`), PayPals FraudNet-/Statistik-Beacons (`c.paypal.com/v1/r`,
`b.stats.paypal.com`, Client-Logger) und die eigenen Events/Funnel/Vitals fängt
der Browser ab (`SENKEN` im Check); nur das eigene session-init der Gegenprobe
läuft durch, als Beweis. In den Teil-Einwilligungen, im Widerruf und in der
Warenkorb-Probe ist alles Eigene abgefangen (`SENKEN_TEIL`). Der Versuch steht
trotzdem im Protokoll („N× vom Wächter abgefangen"). Loader wie gtm.js, Brevos
sdk-loader.js/sa.js oder PayPals sdk/js laufen durch, sonst sähe man nicht, was
sie tun.
Der User-Agent trägt „likoer24-watchdog"; Reichweitenzähler und Sessions filtern
ihn heraus (Analytics ≥ 0.8.0). Ein Lauf dauert etwa drei Minuten. Einstellungen
optional in `config.json` unter `consentLeck`: `aktiv`, `seiten`, `geraete`
(`mobil`/`desktop`), `zustimmung`, `zustimmungSeite`, `zustimmungGeraet`,
`zustimmungGclid` (Gegenprobe mit `?gclid`, Standard aus — siehe oben),
`teilEinwilligung` (Standard an), `teilBanner` (Banner-Variante der
Teil-Einwilligungen, Standard an), `teilSeite` (Standard `/hochzeit/`),
`teilGeraet` (Standard `desktop`), `widerruf` (Standard an), `widerrufSeite`
(Standard `/hochzeit/`), `widerrufGeraet` (Standard `mobil`), `kaufProbe`
(Standard an), `kaufSeite` (Standard `/cart/`), `kaufGeraet` (Standard
`desktop`), `kaufSeitenExtra` (weitere Kaufseiten als Pfad-Präfixe, z. B. die
German-Market-Prüfseite), `consentVersion` (nur falls die Gegenprobe keine
liefert und sich die Version geändert hat), `sperren` (Senken abfangen,
Standard an), `zeitlimitSek` (je Gerät, Standard 240), `basis` bzw.
`LK24_CONSENT_BASIS` für ein anderes Ziel.

Direkt nach dem Deploy von Consent 0.2.0 / Analytics 0.8.0 (und dem Leeren des
WPFC-Caches) muss der Lauf grün sein bis auf Trusted Shops und Google Fonts —
einschließlich `widerruf` und `kauf-paypal`. Kommt stattdessen „lädt nach „Ok"
neu", nennt der Befund den Grund: alte consent.js (Upload nach `httpdocs/…`?
Server-Cache?) oder alte Inline-Gates im gecachten HTML (Cache der Seite
leeren). Stehen Brevo oder PayPal noch da, fehlt
`includes/class-fremd-haertung.php` auf dem Server oder die Cache-Datei der
Seite ist alt; ist `kauf-paypal` rot, greift die Härtung zu breit — sofort per
Kill-Switch-Filter abschalten, das kostet Umsatz.

**Sichtbarkeit** — robots.txt (sperrt die `*`-Gruppe alles? haben KI-Crawler
eine eigene Gruppe, die die Schutzregeln aushebelt?), Sitemap, llms.txt,
Landingpages auf noindex/Titel/Canonical/JSON-LD, strukturierte Daten und
Weiterleitungs-Stichproben. Dazu ein Abgleich, den sonst niemand macht:
Stimmen die Zahlen in `llms.txt` noch mit dem Konfigurator überein? Ein
veraltetes llms.txt heißt, dass ChatGPT und Co. falsche Preise nennen.

## Meldungen

Gemeldet wird die **Veränderung**, nicht der Zustand — über einen **eigenen
Telegram-Bot**, nicht über den der anderen Pi-Dienste. Ein Problem, das gestern
schon gemeldet wurde, schweigt heute; dafür meldet er, wenn etwas wieder in
Ordnung ist. Sonst lernt man, die Nachrichten wegzuwischen, und übersieht die
eine, die zählt.

Eine Ausnahme: Ein **Alarm, der steht, wird alle 20 Stunden erinnert**
(„Weiter offen"). Ein Alarm kostet Geld, solange er offen ist — der darf nicht
nach der ersten Meldung zwischen den Warnungen verschwinden.

## Warum es Funnel und Klickpfad gibt

Vom 03. bis 06.09.2026 kam kein Handy-Kunde über Schritt 2 hinaus: Version
1.0.192 hatte eine Tastatur-Heuristik, die bei Zoom oder eingeblendeten
Browserleisten die untere Leiste samt Weiter-Knopf ausblendete. Vier Tage ohne
Bestellung — und der Watchdog sah nur einen ruhigen Bestellstrom, eine gelbe
Warnung zwischen anderen gelben Warnungen. HTTP 200, Daten stimmig, Server
ruhig: alles, was er damals prüfte, war in Ordnung. Der Fehler saß in der
Bedienung, und die hatte niemand geprüft.

Daraus folgen drei Änderungen: Der Bestellstrom rechnet jetzt mit der
tatsächlichen Wahrscheinlichkeit einer Pause (Alarm ab 5 %, nicht erst nach
achtfachem Median). Der Funnel-Check sieht den Einbruch eine Stufe früher, an
Druckfreigaben und Schrittquoten. Und der Klickpfad-Test hätte den Fehler beim
ersten Lauf nach dem Deploy gemeldet — gegen den alten Build 1.0.192 meldet er
heute: „Weiter-Knopf bei 560 px Höhe: unsichtbar (div.cfg-bottombar
ausgeblendet, data-lk-kbd=1)".

Den vollen Stand zeigt jederzeit das Dashboard unter `/watchdog.html`.

**Was tun, wenn eine Meldung kommt?** → [REAKTIONEN.md](REAKTIONEN.md):
jeder Befund einzeln, nach Dringlichkeit sortiert, mit Handgriffen und den
Fällen, in denen es ein Fehlalarm sein kann.

### Bot einrichten

Einmalig, dauert zwei Minuten:

1. In Telegram **@BotFather** öffnen → `/newbot` → Name z. B. „Likoer24 Watchdog",
   Benutzername z. B. `likoer24_watchdog_bot`. BotFather antwortet mit einem Token.
2. Den neuen Bot öffnen und ihm einmal **`/start`** schreiben — vorher darf er
   nicht antworten.
3. Auf dem Pi:

```bash
ssh thomas@thomas-hub.local
cd ~/likoer24-watchdog && ./bot-einrichten.sh
```

Das Skript fragt den Token verdeckt ab, prüft ihn bei Telegram, ermittelt die
Chat-ID selbst und legt `~/.likoer24-watchdog-env` an (nur für dich lesbar).
Zum Schluss schickt es eine Testnachricht.

Solange kein Bot eingerichtet ist, läuft der Watchdog normal weiter und
schreibt sein Ergebnis ins Dashboard — er meldet sich nur nicht von selbst.

## Dateien

```
run.sh              Aufrufer für den Timer (Umgebung, Logdatei)
bot-einrichten.sh   einmalige Einrichtung des eigenen Telegram-Bots
watchdog.mjs        Ablauf, Zustandsverwaltung, Meldung
lib/kern.mjs        HTTP (mit Wiederholung und Drosselung), FTP über curl, HTML-Krümel
lib/melden.mjs      Vergleich mit dem Vorlauf, Telegram
checks/*.mjs        die Gruppen (consent-leck.mjs: Tracker ohne Einwilligung)
config.json         Zugangsdaten und Schwellen (nicht im Git)
~/.likoer24-watchdog-env   Token und Chat-ID des eigenen Bots (nicht im Git)
state/latest.json   letzter Lauf — das liest das Dashboard
state/baseline.json Gedächtnis für Drift-Vergleiche
state/history.jsonl eine Zeile je Lauf, für den Verlauf
state/lauf.log      Klartext-Ausgabe der letzten Läufe
```

## Schwellen anpassen

Alles in `config.json` unter `schwellen`. Häufigster Fall: `versandTage`
(ab wann eine bezahlte Bestellung als liegengeblieben gilt) und
`sofortKnapp` (ab welchem Sofort-Bestand gewarnt wird).

## Grenzen

Er prüft die Seite von außen und die Daten über Schnittstellen — er klickt
sich nicht durch den Bestellvorgang und legt keine Testbestellung an. Ein
Fehler, der erst nach dem Absenden des Warenkorbs auftritt, fällt ihm nicht
auf; wohl aber die Folge davon (keine Bestellungen mehr, Fatal error im Log).
