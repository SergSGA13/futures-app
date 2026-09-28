#!/bin/bash
# Запуск пульта на Маке одной командой: исполнитель + туннель.
#   ./start.sh
# Печатает адрес панели и готовый адрес вебхука для Apps Script.
# Ctrl+C останавливает и исполнитель, и туннель.
cd "$(dirname "$0")" || exit 1
mkdir -p logs

if ! command -v node >/dev/null; then echo "Нет node - поставь Node.js (см. MAC.md, шаг 1)"; exit 1; fi
if ! command -v cloudflared >/dev/null; then echo "Нет cloudflared - brew install cloudflared"; exit 1; fi
if [ ! -f config.json ]; then echo "Нет config.json - положи его из архива сюда: $(pwd)"; exit 1; fi

PORT=$(node -p "require('./config.json').port || 8787") || exit 1
SECRET=$(node -p "require('./config.json').secret || ''")

# Туннель - в фоне, его вывод в logs/tunnel.log: оттуда берём адрес.
: > logs/tunnel.log
cloudflared tunnel --url "http://127.0.0.1:$PORT" > logs/tunnel.log 2>&1 &
TUNNEL=$!
trap 'kill $TUNNEL 2>/dev/null' EXIT INT TERM

URL=""
for _ in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' logs/tunnel.log | head -1)
  [ -n "$URL" ] && break
  sleep 1
done

echo
echo "  Панель:  http://127.0.0.1:$PORT/panel/$SECRET"
if [ -n "$URL" ]; then
  echo "  Вебхук:  $URL/signal?secret=$SECRET"
  echo "  (адрес туннеля новый при каждом запуске - впиши его в Apps Script)"
else
  echo "  Туннель не дал адрес за 30 с - смотри logs/tunnel.log"
fi
echo

# caffeinate не даёт Маку уснуть, пока работает исполнитель.
caffeinate -dimsu node executor.js
