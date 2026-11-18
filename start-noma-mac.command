#!/bin/bash
# NOMA — локальный сервер для тестов (macOS / Linux). Остановка: закрыть окно или Ctrl+C.
cd "$(dirname "$0")"
PORT=8080
while lsof -i :$PORT >/dev/null 2>&1; do PORT=$((PORT+1)); done
echo ""; echo "  NOMA — локальный сервер: http://localhost:$PORT/"
for d in tours/*/; do [ -f "${d}tour.json" ] && echo "    http://localhost:$PORT/?tour=$(basename "$d")"; done
echo ""
(sleep 1; open "http://localhost:$PORT/" 2>/dev/null || xdg-open "http://localhost:$PORT/" 2>/dev/null) &
python3 -m http.server $PORT
