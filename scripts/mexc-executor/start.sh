#!/bin/bash
# Запуск пульта на Маке одной командой.
#   ./start.sh
# Если в config.json задан publicUrl (постоянный туннель на своём домене,
# он работает службой сам по себе) - запускается только исполнитель.
# Иначе рядом поднимается быстрый туннель, и его адрес печатается.
# Ctrl+C останавливает всё, что скрипт запустил.
cd "$(dirname "$0")" || exit 1
mkdir -p logs

if ! command -v node >/dev/null; then echo "Нет node - поставь Node.js (см. MAC.md, шаг 1)"; exit 1; fi
if [ ! -f config.json ]; then echo "Нет config.json - положи его из архива сюда: $(pwd)"; exit 1; fi

PORT=$(node -p "require('./config.json').port || 8787") || exit 1
SECRET=$(node -p "require('./config.json').secret || ''")
PUBLIC=$(node -p "String(require('./config.json').publicUrl || '').replace(/\/+\$/, '')")

echo
echo "  Панель:  http://127.0.0.1:$PORT/panel/$SECRET"
if [ -n "$PUBLIC" ]; then
  echo "  Вебхук:  $PUBLIC/signal?secret=$SECRET"
  echo "  (постоянный туннель - адрес не меняется)"
else
  if ! command -v cloudflared >/dev/null; then echo "Нет cloudflared - brew install cloudflared"; exit 1; fi
  # Быстрый туннель - в фоне, его вывод в logs/tunnel.log: оттуда берём адрес.
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
  if [ -n "$URL" ]; then
    echo "  Вебхук:  $URL/signal?secret=$SECRET"
    echo "  (адрес быстрого туннеля новый при каждом запуске)"
  else
    echo "  Туннель не дал адрес за 30 с - смотри logs/tunnel.log"
  fi
fi
echo

# caffeinate не даёт Маку уснуть, пока работает исполнитель.
caffeinate -dimsu node executor.js
