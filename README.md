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
checks/*.mjs        die fünf Gruppen
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
