#!/bin/bash
#
# Richtet den eigenen Telegram-Bot für den Watchdog ein.
#
# Vorher bei @BotFather in Telegram:
#   /newbot  →  Name z. B. "Likoer24 Watchdog", Benutzername z. B. likoer24_watchdog_bot
#   BotFather antwortet mit einem Token der Form 123456789:AA…
# Danach dem neuen Bot einmal /start schreiben — sonst darf er nicht antworten.
#
# Aufruf:
#   ./bot-einrichten.sh 123456789:AA…
#   ./bot-einrichten.sh            (fragt den Token verdeckt ab)
#
# Der Token wandert direkt in ~/.likoer24-watchdog-env (nur für dich lesbar).
# Die Chat-ID holt das Skript selbst von Telegram.
#
set -u

ENV_DATEI="$HOME/.likoer24-watchdog-env"

TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  read -r -s -p "Bot-Token von BotFather: " TOKEN
  echo
fi

if ! printf '%s' "$TOKEN" | grep -qE '^[0-9]{6,}:[A-Za-z0-9_-]{30,}$'; then
  echo "Das sieht nicht nach einem Bot-Token aus (erwartet: 123456789:AA…)." >&2
  exit 1
fi

# Gehört der Token zu einem echten Bot?
NAME=$(curl -sS --max-time 15 "https://api.telegram.org/bot${TOKEN}/getMe" \
  | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
if [ -z "$NAME" ]; then
  echo "Telegram kennt diesen Token nicht. Stimmt er?" >&2
  exit 1
fi
echo "Bot erkannt: @${NAME}"

# Die Chat-ID steht in der Nachricht, die du dem Bot geschickt hast. Wir
# nehmen die zuletzt gesehene — so landet die Meldung dort, wo du zuletzt
# geschrieben hast (privat oder in einer Gruppe).
CHAT=$(curl -sS --max-time 15 "https://api.telegram.org/bot${TOKEN}/getUpdates" \
  | grep -o '"chat":{"id":-\?[0-9]\+' | tail -1 | grep -o '\-\?[0-9]\+$')

if [ -z "$CHAT" ]; then
  echo
  echo "Noch keine Nachricht von dir an @${NAME} gefunden."
  echo "Öffne den Bot in Telegram, schicke ihm /start — und ruf dieses Skript"
  echo "danach noch einmal auf."
  exit 1
fi
echo "Chat gefunden: ${CHAT}"

umask 077
cat > "$ENV_DATEI" <<EOF
# Eigener Telegram-Bot für den Likoer24-Watchdog (@${NAME}).
# Angelegt von bot-einrichten.sh — nicht ins Git, nicht auf FTP.
WATCHDOG_TELEGRAM_BOT_TOKEN=${TOKEN}
WATCHDOG_TELEGRAM_CHAT_ID=${CHAT}
EOF
chmod 600 "$ENV_DATEI"
echo "Zugang gespeichert in ${ENV_DATEI} (nur für dich lesbar)."

ANTWORT=$(curl -sS --max-time 15 -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT}" \
  --data-urlencode "text=Likoer24-Watchdog ist eingerichtet. Ab jetzt melde ich mich hier, wenn sich am Shop etwas ändert — und nur dann.")
if printf '%s' "$ANTWORT" | grep -q '"ok":true'; then
  echo "Testnachricht zugestellt. Fertig."
else
  echo "Testnachricht ging nicht durch: ${ANTWORT}" >&2
  exit 1
fi
