#!/bin/bash
#
# Aufrufer für den Timer.
#
# Das Benutzer-Journal ist auf dem Pi nicht dauerhaft — ein `journalctl --user`
# liefert nichts. Deshalb schreibt der Lauf in eine eigene Logdatei, so wie es
# die anderen Dienste hier auch halten. Sie wird bei 2 MB einmal umgelegt;
# mehr Verwaltung braucht es für zwei Läufe am Tag nicht.
#
set -u
cd "$(dirname "$0")" || exit 1

LOG="state/lauf.log"
mkdir -p state
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 2000000 ]; then
  mv -f "$LOG" "$LOG.1"
fi

# Zugang zum eigenen Watchdog-Bot (siehe bot-einrichten.sh). Bewusst nicht
# der Bot der anderen Pi-Dienste.
set -a
# shellcheck source=/dev/null
[ -f "$HOME/.likoer24-watchdog-env" ] && . "$HOME/.likoer24-watchdog-env"
set +a

{
  echo
  echo "===== $(date '+%d.%m.%Y %H:%M:%S') ====="
} >> "$LOG"

node watchdog.mjs "$@" >> "$LOG" 2>&1
ende=$?
echo "(Ende mit Code $ende)" >> "$LOG"
exit $ende
