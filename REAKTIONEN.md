# Was tun, wenn der Watchdog meldet?

Nachschlagewerk für den Moment, in dem morgens um sieben eine Meldung auf dem
Handy liegt. Aufgebaut nach Dringlichkeit, nicht nach Prüfgruppe — die Frage
lautet ja nicht „woher kam das", sondern „muss ich jetzt aufstehen".

---

## Wie die Meldungen zu lesen sind

**Gemeldet wird die Veränderung, nicht der Zustand.** Bleibt das Handy still,
ist alles wie beim letzten Lauf. Kommt eine Meldung, ist seither etwas anders
geworden. Ein Problem, das gestern schon gemeldet wurde, schweigt heute — und
meldet sich wieder, wenn es behoben ist („Wieder in Ordnung").

Daraus folgt zweierlei:

- Eine Meldung heißt **nicht** automatisch „neu kaputt". Sie heißt „anders als
  vorher" — das kann auch die Rückmeldung auf deinen eigenen Deploy sein.
- Die Abwesenheit einer Meldung heißt **nicht** „alles grün". Sie heißt
  „unverändert". Der volle Stand steht immer im Dashboard.

| Farbe | Bedeutung | Zeithorizont |
|---|---|---|
| 🔴 Alarm | Etwas ist kaputt und kostet gerade Geld oder ist rechtlich heikel | heute |
| 🟡 Warnung | Etwas läuft schief, aber nichts brennt | diese Woche |
| 🔵 Hinweis | Etwas hat sich geändert | nur zur Kenntnis |
| 🟢 | Ein früherer Befund ist weg | abhaken |

Läuft dreimal täglich, 07:00, 13:00 und 19:00. Ein Alarm, der steht, wird alle
20 Stunden erinnert („Weiter offen").

---

> Die FTP-Zugangsdaten stehen in `config.json` (nicht im Repo). Für die
> Befehle unten vorher `FTP_PASS=$(python3 -c 'import json;print(json.load(open("config.json"))["ftp"]["pass"])')`
> setzen — das Passwort gehört in keine Datei, die versioniert wird.

## Die ersten drei Handgriffe — immer gleich

1. **Dashboard öffnen:** `/watchdog.html`. Dort steht der ganze Lauf, nach
   Schwere sortiert, mit Bestellnummern als Links ins WP-Admin. Die
   Telegram-Meldung ist nur der Auszug dessen, was sich geändert hat.
2. **Bei allem, was nach Server riecht:** Klartext-Log des letzten Laufs lesen.
   ```bash
   ssh thomas@thomas-hub.local 'tail -60 ~/likoer24-watchdog/state/lauf.log'
   ```
3. **Nach der Reparatur nicht auf den Timer warten** — Lauf von Hand anstoßen
   und sehen, ob der Befund verschwindet:
   ```bash
   ssh thomas@thomas-hub.local 'systemctl --user start likoer24-watchdog.service'
   ```

---

# 🔴 Alarme

## Startseite / Konfigurator / Warenkorb / Kasse nicht erreichbar

> `Konfigurator: HTTP 500` · `nicht erreichbar (Zeitüberschreitung, 2 Versuche)` ·
> `Seite lädt, aber der erwartete Inhalt fehlt` · `nur 12 KB statt mindestens 60 KB`

**Geprüft wird** mehr als HTTP 200: Pflichttexte, Mindestgröße und die üblichen
Katastrophenmeldungen im Quelltext (kritischer WP-Fehler, keine
Datenbankverbindung, „No space left on device", Wartungsmodus). Eine
WordPress-Fehlerseite kommt fröhlich mit Status 200 zurück — deshalb die
zusätzlichen Prüfungen.

**Warum das zählt:** Der Konfigurator ist der einzige Bestellweg. Jede Stunde
Ausfall ist verlorener Umsatz, und von außen sieht ein toter Shop aus wie ein
ruhiger Tag.

**Handlung:**

1. Seite selbst aufrufen. Geht sie bei dir, war es womöglich ein Aussetzer —
   der Watchdog wiederholt jede Anfrage einmal, ein einzelner Timeout löst also
   schon keinen Alarm mehr aus. Zweimal hintereinander gemeldet: ernst nehmen.
2. Fehlerprotokoll ansehen, die letzten Einträge zuerst:
   ```bash
   curl -s -u "thomaslikoer:$FTP_PASS" --range -20000 ftp://likoer24.de/logs/error_log | tail -40
   ```
3. Steht dort ein `PHP Fatal error` mit einem Pfad ins Konfigurator-Plugin, ist
   der letzte Deploy der Verdächtige → siehe *PHP-Abstürze*.
4. Nichts im Log, Seite trotzdem tot: Beim Hoster nachsehen (Plesk), ob PHP-FPM
   läuft. Das ist der Fall, in dem du beim Hoster anrufst.

**Kann Fehlalarm sein, wenn** du gerade selbst deployst — während eines
FTP-Uploads kann eine PHP-Datei für Sekunden unvollständig sein.

---

## PHP-Abstürze

> `3 Fatal error(s) in 24 h` — mit den drei häufigsten Meldungen im Klartext

**Geprüft wird** das Apache-/PHP-Fehlerprotokoll der letzten 24 Stunden über
FTP. Gruppiert nach Meldung, damit 200 gleiche Zeilen nicht wie 200 Probleme
aussehen.

**Handlung:**

1. Die Meldung im Detail nennt Datei und Funktion. Zeigt sie auf
   `likoer24-konfigurator` oder ein anderes Eigen-Plugin: dein Fehler, und
   meist der letzte Deploy.
2. Zeigt sie auf ein Fremd-Plugin (German Market, WooCommerce, Elementor): kam
   dort ein Auto-Update? Dann ist Zurückrollen die schnellste Lösung.
3. Bestellungen der letzten Stunden prüfen — ein Fatal error im Bestellprozess
   hinterlässt halb angelegte Bestellungen.
4. Nach dem Fix: Der Befund verschwindet erst, wenn 24 Stunden ohne neuen Fatal
   error vergangen sind. Nicht wundern.

**Sonderfall Rechnungs-Mail:** Ein `Call to a member function has_status() on
null` in `WC_Email_Customer_Invoice` entsteht, wenn eine Rechnungs-Mail zu einer
nicht mehr existierenden Bestellung ausgelöst wird. Einmalig und folgenlos.

---

## Speicherplatz · Arbeitsspeicher · Laufzeit · Datenbank

> `Server meldet volle Platte — 4× in 24 h` · `PHP-Speicherlimit gesprengt` ·
> `Skript in die Zeitbegrenzung gelaufen` · `Datenbankfehler`

**Warum das zählt:** Die volle Platte ist das bekannte Nachtproblem — MySQL kann
keine temporären Tabellen mehr schreiben, und Bestellungen bleiben mitten im
Bezahlvorgang hängen. Der Watchdog sieht es im Log, bevor du es am Umsatz siehst.

**Handlung bei voller Platte:**

1. **Zuerst die Bestellungen**, nicht die Platte: Gibt es welche im Status
   „in Wartestellung" aus der Nacht? Die brauchen Handarbeit — Zahlung prüfen,
   Status korrigieren.
2. Platz schaffen. Die üblichen Verdächtigen:
   ```bash
   curl -s -u "thomaslikoer:$FTP_PASS" ftp://likoer24.de/logs/ | sort -k5 -n | tail
   ```
   Große `.processed`-Dateien und alte Backups im Home sind meist die Ursache.
3. Beim Hoster nachsehen, wie viel Platte die Subscription überhaupt hat.

**Bei Speicherlimit/Laufzeit:** Meist die PDF-Erzeugung bei großen Bestellungen.
Prüfen, ob die betroffene Bestellung ihr PDF bekommen hat — wenn nicht, PDF neu
erzeugen (siehe unten); das läuft dann allein und ohne die parallele Last der
Bestellabwicklung oft durch.

---

## Wartungsmodus aktiv

> `.maintenance liegt im Web-Verzeichnis — Besucher sehen die Wartungsseite`

**Warum:** WordPress legt diese Datei bei Updates an und löscht sie danach.
Bricht ein Update ab, bleibt sie liegen — und der komplette Shop zeigt nur noch
„Kurz nicht verfügbar". Das ist ein Totalausfall, der von außen harmlos aussieht.

**Handlung — sofort, dauert zehn Sekunden:**
```bash
curl -s -u "thomaslikoer:$FTP_PASS" ftp://likoer24.de/ -Q "DELE /httpdocs/.maintenance"
```
Danach prüfen, ob das abgebrochene Update durchgelaufen ist (WP-Admin →
Aktualisierungen).

---

## Druck-PDF fehlt

> `1 Konfigurator-Bestellung(en) ohne Druck-PDF: #19415`

**Geprüft wird:** Jede bezahlte Bestellung, die aus dem Konfigurator stammt und
älter als eine Stunde ist, muss `_lk24_pdf_generated_at` tragen. Von Hand im
Backend angelegte Bestellungen sind ausgenommen — die erscheinen als
*Sonderbestellungen* (siehe unten).

**Warum:** Ohne PDF kann nicht gedruckt werden. Fällt es dir erst beim Packen
auf, ist ein Tag verloren.

**Handlung:**

1. Bestellung im Admin öffnen (im Dashboard ist die Nummer ein Link).
2. In der Konfigurator-Metabox **„PDF neu erzeugen"** klicken.
3. Kommt wieder nichts, mit erzwungenem Server-Render versuchen — das umgeht
   einen kaputten Browser-Snapshot:
   ```
   POST https://likoer24.de/wp-json/likoer24/v1/regen-pdf/<ORDER-ID>?force_legacy=1
   ```
   (Anmeldung als WooCommerce-Verwalter nötig.)
4. Danach das PDF ansehen, bevor es in den Druck geht.

---

## Etikett-Vorschau fehlgeschlagen

> `2 Bestellung(en) mit fehlgeschlagenem Snapshot (Foto fehlt womöglich im Druck)`

**Warum:** Der Marker `_lk24_snapshot_failed` bedeutet, dass der Browser des
Kunden kein brauchbares Etikettbild geliefert hat — der bekannte iOS/WebKit-Fall.
Der Server heilt das inzwischen selbst, aber der Marker bleibt als Hinweis.

**Handlung:** Etikett dieser Bestellung im Admin ansehen. Ist ein Foto drauf,
hat die Heilung gegriffen und du kannst drucken. Ist keins drauf: PDF mit
`force_legacy=1` neu erzeugen (siehe oben) und erneut ansehen.

---

## Los-Kennzeichnung fehlt

> `2 Sorte(n) ohne Los im Pflichttext (§ 1 LKV): Erdbeerlimes, Wodka-Kirsch`

**Warum das oben steht:** Das ist keine Kosmetik, sondern
Lebensmittelkennzeichnungsrecht. Jede befüllte Flasche braucht ihre
Los-Kennzeichnung auf dem Etikett. Fehlt sie, sind die gedruckten Etiketten
nicht verkehrsfähig — und gedruckt ist gedruckt.

**Handlung:**

1. **Nichts mehr drucken**, bis das behoben ist.
2. WP-Admin → WooCommerce → Verkaufstracker → Lager: Ist ein Los aktiv?
   Nach einem Wareneingang muss das neue Los aktiviert werden.
3. Nach der Korrektur Watchdog von Hand laufen lassen und den Befund
   verschwinden sehen, bevor der Drucker wieder anläuft.
4. Bestellungen, die seit dem Fehler eingegangen sind, brauchen neue PDFs.

---

## Alkoholangaben widersprüchlich

> `Pflichttext und Feldwert weichen ab bei: Kräuter-Halbbitter`

**Warum:** Der Alkoholgehalt steht zweimal in den Stammdaten — als Zahl und im
Pflichttext des Etiketts. Weichen sie ab, ist eine der beiden Angaben falsch
gedruckt. Auch das ist Kennzeichnungsrecht.

**Handlung:** `data/sorten.php` prüfen, beide Werte angleichen, deployen.
Etiketten, die seit der Abweichung gedruckt wurden, prüfen.

---

## Preisstaffel oder Versandkosten unstimmig

> `Paketpreis fällt bei 150 Flaschen` · `Flaschenpreis steigt bei 100 Flaschen` ·
> `Mindestmenge ist 20 statt 25` · `DE: Stufen überlappen bei 225`

**Warum:** Eine nicht-monotone Staffel heißt, dass jemand bei größerer Menge
weniger zahlt als bei kleinerer — oder umgekehrt. Beides kostet Geld oder
Vertrauen, je nach Richtung.

**Handlung:** `data/` im Plugin prüfen (Preisstaffel und Versandtabelle),
korrigieren, deployen. Bestellungen seit der Änderung durchsehen: Wurde zu
wenig berechnet?

---

## Konfigurator-Daten nicht lesbar

> `LK24_BOOT nicht lesbar — der Konfigurator bekommt keine Sorten/Preise`

Der schwerste Befund der Gruppe: Die Seite lädt, aber der Konfigurator hat keine
Daten. Meist ein PHP-Fehler in `data/*.php` nach einem Deploy. Fehlerprotokoll
lesen, letzte Änderung zurückrollen.

---

## robots.txt sperrt die Seite · KI-Crawler ausgesperrt

> `sperrt die komplette Seite (Disallow: / für alle)` ·
> `ausgesperrt: GPTBot, ClaudeBot — keine Zitate mehr in KI-Antworten`

**Warum:** Ein `Disallow: /` in der `*`-Gruppe nimmt dich komplett aus Google.
Der Effekt kommt schleichend über Wochen und ist mühsam rückgängig zu machen.

**Handlung:** `httpdocs/robots.txt` per FTP ansehen und korrigieren. Wichtig zu
wissen: `Disallow: /` bei SemrushBot, AhrefsBot, MJ12bot und DotBot ist
**gewollt** und löst keinen Alarm aus — nur die `*`-Gruppe zählt.

Beim Befund *KI-Crawler*: Eine eigene `User-agent`-Gruppe für GPTBot & Co.
ersetzt die `*`-Gruppe komplett und hebelt damit deren Schutzregeln für
Warenkorb und Kasse aus. Diese Bots sollen ohne eigene Gruppe unter `*`
mitlaufen — genau so steht es im Kommentar der robots.txt.

---

## Landingpage auf noindex

> `/hochzeit/ steht auf noindex`

**Warum:** Der teuerste stille Fehler, den es gibt. Die Seite ist da, sieht gut
aus, verkauft — und verschwindet innerhalb von Wochen aus Google, ohne dass
irgendetwas kaputt aussieht.

**Handlung:** Rank Math auf der betroffenen Seite prüfen (Erweitert →
Robots-Meta). Meist versehentlich beim Bearbeiten gesetzt. Nach der Korrektur
in der Search Console eine erneute Indexierung anstoßen.

---

# 🟡 Warnungen

## Bestellstrom still

> `seit 61 h keine Bestellung (üblich ist etwa alle 8,4 h)`

**Geprüft wird gegen deinen eigenen Verlauf** — den mittleren Abstand der
letzten 30 Bestellungen — nicht gegen eine feste Stundenzahl. Eine starre
Schwelle wäre im Sommer dauerrot und im Dezember blind.

**Handlung:** Einmal selbst durch den Bestellvorgang klicken, bis zur Kasse
(nicht abschicken). Geht das, ist es Nachfrage und kein Defekt — dann ist das
eine Marketing-Frage, keine Technik-Frage. Bricht es irgendwo ab, hast du den
Fehler gefunden, den sonst niemand meldet.

---

## Unbezahlte Bestellungen

> `1 seit über 48 h offen: #19391` — mit Alter und Betrag im Detail

**Handlung:** Bei Vorkasse/Überweisung ist das oft normal, besonders bei
Großbestellungen. Bei größeren Beträgen lohnt eine freundliche Erinnerung; nach
zwei Wochen ohne Zahlung stornieren, sonst blockiert die Bestellung deine
Bestandsrechnung.

**Schwelle:** `haengendStunden` (Standard 48).

---

## Versand offen

> `1 Bestellung(en) seit über 5 Tagen bezahlt, aber nicht übergeben: #19368`

**Geprüft wird** `_lk24_versand_uebergeben_at`. Der Befund kommt also auch dann,
wenn das Paket längst raus ist, aber die Markierung fehlt.

**Handlung:** Erst prüfen, ob wirklich nichts rausging. Wenn doch: die
Versand-Markierung nachziehen — sonst meldet es sich jede Woche wieder und du
gewöhnst dir an, darüber hinwegzulesen.

**Schwelle:** `versandTage` (Standard 5). Wenn deine Bearbeitungszeit real
länger ist, hochsetzen — lieber eine ehrliche Schwelle als eine ignorierte.

---

## Bestandsbuchung fehlt

> `2 bezahlte Bestellung(en) nicht im Verkaufstracker — Lagerzahlen laufen auseinander`

**Warum:** Ohne `_lk24vt_logged` fehlt die Bestellung in der Bestandsführung.
Der Fehler summiert sich lautlos, bis die Inventur nicht mehr aufgeht und der
Lieferanten-Forecast falsche Mengen vorschlägt.

**Handlung:** WooCommerce → Verkaufstracker öffnen und nachbuchen. Häuft sich
das, hakt der Hook — dann ist die Ursache im Plugin zu suchen, nicht in den
einzelnen Bestellungen.

---

## Hintergrundfarbe / Farb-Drift

> `1 Bestellung(en) mit Farb-Drift im Snapshot (Dark-Mode-Verdacht) — vor dem Druck ansehen`

**Warum:** Ein erzwungener Dunkelmodus im Browser des Kunden färbt den
Etikett-Schnappschuss um. Im schlimmsten Fall druckst du vollflächig dunkel —
teuer in Tinte und Nerven.

**Handlung:** Etikett im Admin ansehen. Sieht es falsch aus, PDF mit
`force_legacy=1` neu erzeugen. Vor dem Druck immer selbst draufschauen.

---

## Verfügbarkeit / Nachproduktion

> `knapper Sofort-Bestand: Wodka-Kirsch (350)` ·
> `2 Sorte(n) in Nachproduktion` ·
> 🔴 `alle Sorten stehen auf Nachproduktion`

**Warum:** Steht eine Sorte auf Nachproduktion, kommuniziert der Shop 2–4 Wochen
statt 3–7 Werktagen und schaltet Express ab. Das kostet Bestellungen. Stehen
*alle* Sorten so, ist es ein Alarm — dann verkauft der Shop faktisch nichts mehr
mit normaler Lieferzeit.

**Handlung:** Nachbestellung bei Brackmann terminieren. Denk an den Kipppunkt
bei etwa 4.000 Flaschen zwischen Paketversand und Spedition. Nach dem
Wareneingang: einbuchen und das neue Los aktivieren — sonst schlägt der
Los-Alarm zu.

**Schwelle:** `sofortKnapp` (Standard 400 Flaschen).

---

## Zahlungsabbrüche

> `4 fehlgeschlagene Zahlungen in 48 h — Zahlungsanbieter prüfen`

Einzelne fehlgeschlagene Zahlungen sind Alltag. Eine Häufung deutet auf ein
Problem beim Zahlungsanbieter oder eine kaputte Konfiguration. Erst im
Zahlungs-Dashboard nachsehen (PayPal/WooPayments), dann eine Testzahlung.

**Schwelle:** `failedWarn` (Standard 3 in 48 h).

---

## configurator.js/css: Inhalt geändert, Version nicht

> `Inhalt hat sich geändert, die Version (1.0.184) aber nicht — Browser-Cache wird
> die alte Datei weiter ausliefern`

**Warum:** Du hast hochgeladen, aber den Versions-Bump vergessen. Browser und
Cache liefern tagelang die alte Datei aus — dein Fix ist live und wirkt trotzdem
nicht. Ein Fehler, der sich sonst nur zufällig zeigt.

**Handlung:** Version in `likoer24-konfigurator.php` erhöhen (beides: den
Kommentar-Header und `LK24_KONFIG_VERSION`), hochladen. Bei CSS der
Landingpages zusätzlich den `-lpNN`-Suffix in `LK24_LP_CSS_VER` hochzählen und
die Seiten-Caches leeren:
```bash
for s in taufe hochzeit jga geburtstag firmengeschenke weihnachten vereine sorten so-gehts ueber-uns; do
  curl -s -u "thomaslikoer:$FTP_PASS" ftp://likoer24.de/ -Q "DELE /httpdocs/wp-content/cache/all/$s/index.html"
done
```

---

## Fakten für KI-Antworten weichen ab

> `llms.txt weicht vom Konfigurator ab — KI-Assistenten nennen dann falsche Angaben`

**Warum:** `llms.txt` ist die Datei, aus der ChatGPT, Claude und Perplexity ihre
Fakten über dich ziehen. Steht dort ein alter Preis, erzählen sie ihn wochenlang
weiter — und Kunden kommen mit falschen Erwartungen.

**Handlung:** `Likoer24/llms.txt` an den Konfigurator angleichen und nach
`httpdocs/llms.txt` hochladen. Immer wenn du Preise, Mindestmenge, Sortenzahl
oder Lieferzeit änderst, gehört diese Datei mit angefasst.

---

## Weiterleitungen · Sitemap · Strukturierte Daten · llms.txt leer

Alles im selben Muster: Etwas, das lange still funktioniert hat, tut es nicht
mehr — meist nach einem Plugin-Update oder einer `.htaccess`-Änderung.

- **Weiterleitungen:** Die Stichproben stehen in `config.json` unter
  `seo.weiterleitungen`. Schlagen sie fehl, den Block in `httpdocs/.htaccess`
  prüfen (dort liegen die 301er, nicht im Redirection-Plugin).
- **Sitemap:** Rank Math neu erzeugen lassen. Ein Einbruch auf unter 70 % der
  URLs deutet auf ein Problem beim Erzeugen.
- **Strukturierte Daten:** Fehlt `Product` oder `HowTo` auf dem Konfigurator,
  verlierst du Rich Results. Nach Änderungen am LP-Renderer prüfen.

---

## Upload-Ordner läuft voll

> `5.200 lose Dateien im Konfigurator-Upload — das Aufräumen scheint zu hängen`

Kundenfotos werden nach sieben Tagen gelöscht. Bleibt der Ordner voll, läuft
entweder der Aufräum-Job nicht — oder die Platte füllt sich, und du landest
wieder beim nächtlichen Ausfall. Prüfen, ob der WP-Cron läuft.

**Schwelle:** `uploadsWarn` (Standard 4.000).

---

## Fehlerprotokoll nicht lesbar / Logformat geändert

> `nur 12 von 340 Zeilen lesbar — Logformat hat sich geändert, die Fehlerprüfung
> greift nicht mehr`

**Das ist der wichtigste unauffällige Befund im ganzen System.** Er bedeutet:
Die Serverüberwachung ist blind geworden. Sie meldet dann nicht mehr „keine
Fehler", weil sie keine mehr erkennt — sie sagt es dir. Ursache ist meist ein
Hoster-seitiger Wechsel des Logformats. Melden, dann passe ich den Parser an.

---

# 🔵 Hinweise

| Meldung | Was sie bedeutet | Wann du hinschaust |
|---|---|---|
| `Plugin-Version: live jetzt 1.0.185 (vorher 1.0.184)` | Deploy ist angekommen | Nur wenn du nicht deployt hast |
| `likoer24-konfigurator.php hat einen neuen Inhalt` | Datei auf dem Server geändert | **Immer, wenn du es nicht warst** |
| `neu hochgeladen, Inhalt unverändert` | Datei erneut hochgeladen, gleicher Inhalt | Nie |
| `Preisänderung: 25 Fl.: 39,99 € → 42,99 €` | Preisstaffel hat sich geändert | Nur wenn ungeplant |
| `Lieferzeit geändert` | Urlaubsmodus oder Nachproduktion greift | Zur Kenntnis |
| `Sonderbestellungen: #19415 (Musikfest Rottenbuch, 3.650 €)` | Von Hand angelegte Bestellung — Etiketten laufen außerhalb des Konfigurators | Als Erinnerung: hier musst du selbst ran |
| `Vorschau repariert` | Server hat eine kaputte Vorschau selbst geheilt | Nie — das ist die Automatik bei der Arbeit |
| `Feinschliff: 4 Kleinigkeiten ohne Eile` | Zu lange Seitentitel u. Ä. | Wenn du ohnehin an SEO sitzt |

**Die Faustregel für Blau:** Wenn du die Ursache selbst warst, ist es eine
Empfangsbestätigung. Wenn nicht, ist es die interessanteste Meldung des Tages.

---

# Wenn der Watchdog selbst schweigt

Kein Alarm heißt nicht automatisch „alles gut" — es kann auch heißen, dass er
nicht mehr läuft. Das Dashboard zeigt einen Warnstreifen, sobald der letzte Lauf
älter als 26 Stunden ist. Prüfen:

```bash
ssh thomas@thomas-hub.local 'systemctl --user list-timers likoer24-watchdog.timer --no-pager'
ssh thomas@thomas-hub.local 'tail -20 ~/likoer24-watchdog/state/lauf.log'
```

Bleibt die Telegram-Meldung aus, obwohl Läufe stattfinden, fehlt der Bot-Zugang:
`~/.likoer24-watchdog-env` prüfen, notfalls `./bot-einrichten.sh` erneut.

---

# Schwellen anpassen

Alle in `config.json` unter `schwellen`, danach `rsync` auf den Pi.

| Schlüssel | Standard | Bedeutung |
|---|---|---|
| `haengendStunden` | 48 | ab wann eine unbezahlte Bestellung auffällt |
| `versandTage` | 5 | ab wann eine bezahlte Bestellung als liegengeblieben gilt |
| `pdfKarenzStunden` | 1 | Schonfrist nach der Zahlung, bevor das PDF da sein muss |
| `sofortKnapp` | 400 | ab welchem Sofort-Bestand gewarnt wird |
| `stilleWarnStunden` | 36 | Untergrenze für „Bestellstrom still" (der Verlauf kann sie erhöhen) |
| `failedWarn` | 3 | fehlgeschlagene Zahlungen in 48 h bis zur Warnung |
| `uploadsWarn` | 4000 | lose Dateien im Upload-Ordner bis zur Warnung |
| `logFensterStunden` | 24 | Zeitfenster für die Logauswertung |

**Wann anpassen:** Wenn derselbe gelbe Befund dreimal kommt und du ihn jedes Mal
achselzuckend wegwischst. Dann ist entweder die Schwelle falsch gesetzt oder der
Befund für deinen Betrieb irrelevant — beides ist ein Grund, ihn zu ändern, und
keiner, ihn zu ertragen. Ein Wächter, dessen Meldungen man ignoriert, ist
schlimmer als keiner.


---

## Funnel und Klickpfad (seit 07.09.2026)

### 🔴 Klickpfad Handy: „Kunde kommt auf dem Handy nicht durch: …"

Der echte Browser ist auf dem Handy-Weg an einem Knopf gescheitert. Der Text
nennt den Schritt und den Grund, z. B. „Weiter-Knopf bei 560 px Höhe:
unsichtbar (div.cfg-bottombar ausgeblendet, data-lk-kbd=1)".

1. Sofort selbst am Handy nachstellen (Chrome oder Safari, Konfigurator bis
   Schritt 2, dann ein Stück scrollen und zoomen). Bestätigt es sich: **der
   letzte Deploy ist der erste Verdächtige** — vorherige Version wieder
   hochladen (`git checkout <tag> -- dist/ likoer24-konfigurator.php`, FTP).
2. Kommt der Alarm ohne Deploy, ist meist ein Theme-/Plugin-Update oder ein
   Elementor-Overlay schuld (Consent-Banner, Cookie-Hinweis, Sticky-Header).
3. „Test nicht auswertbar" (gelb) ist kein Kundenproblem: Browser fehlt oder
   Zeitlimit — `state/lauf.log` lesen, auf dem Pi `chromium --version`.
4. „reagieren nicht auf Fingertipp, nur auf programmatischen Klick" heißt: der
   Knopf ist da, aber ein unsichtbares Element fängt die Berührung ab. Mit
   `elementFromPoint` im Browser-Inspector suchen.

### 🔴 Warenkorb-Anlagen: „seit 48 h keine einzige Druckfreigabe"

Kein Kunde hat in zwei Tagen ein Etikett freigegeben, obwohl der Schnitt der
Tage davor deutlich darüber liegt. Das ist die Ground Truth ohne Tracker.
Zuerst den Klickpfad-Befund im selben Lauf lesen — meldet der auch rot, ist
die Bedienung kaputt. Ist er grün, sind es die Besucher: Google Ads
(Kampagne pausiert? Budget?), Search Console, Erreichbarkeit vom Handy aus.
Bei „Warenkorb seit Deploy" mit demselben Text gilt Punkt 1 vom Klickpfad.

### 🔴/🟡 Schrittquoten: „Schritt 2 überstanden Handy: 2 von 15 (13 %), üblich 40 %"

Die Quote der Handy-Sessions, die über Schritt 2 hinauskommen, ist gegenüber
den vier Wochen davor eingebrochen; „Zufall: 3 %" ist die Wahrscheinlichkeit,
dass das nur Streuung ist. Rot ab 3 %, gelb ab 12 %. Reagieren wie beim
Klickpfad. Bleibt der Klickpfad grün und nur eine Quote fällt, den Schritt im
Analytics-Dashboard (konfigurator.html, Funnel je Gerät) ansehen — oft ist es
eine einzelne Stelle, etwa der Foto-Upload auf iOS.

Nach dem Hotfix am 06.09.2026 steht dieser Befund erwartungsgemäß noch ein
bis zwei Tage auf Rot: das 48-Stunden-Fenster reicht in die kaputte Zeit
zurück. Verschwindet er nicht von selbst, greift der Fix nicht.

### 🟡 Bestellstrom: „seit 55 h keine Bestellung (zuletzt etwa alle 23 h; so eine Pause: 9 %)"

Gelb ab 10 %, rot ab 5 % Wahrscheinlichkeit (nie vor 36 bzw. 72 Stunden).
Erst Funnel und Klickpfad im selben Lauf lesen — sind beide grün, ist es ein
ruhiger Tag. Steht dahinter „die Pause begann N h nach dem Deploy von …", dann
war es kein ruhiger Tag.
