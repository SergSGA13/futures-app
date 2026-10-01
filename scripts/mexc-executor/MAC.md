# Панель на MacBook (для второго человека)

Здесь человек заводит свою панель со своими аккаунтами бирж и своим
Telegram-ботом. Ставки, активы и расписание копируются с исходной панели,
а секреты, журналы и доходность не передаются.

## На Windows: собрать комплект

```
cd C:\Users\JakubPC\futures-app
git pull origin main
cd scripts\mexc-executor
node executor.js kit
```
Появится `backup\futures-app-kit-<дата>.zip`, а в окне будет напечатан
**новый секрет** этой панели. В архиве:
- код из git;
- `config.json` с теми же ставками, активами, расписанием и порогами выплаты;
- новый секрет;
- выключенный Telegram;
- включённый dry-run.

Твоих журналов, доходности, профилей бирж и токенов в архиве нет.

## На Маке: один раз

1. Поставь Node.js LTS с https://nodejs.org (или `brew install node`).
2. Поставь туннель: `brew install cloudflared`
   (если нет brew: https://brew.sh, одна команда в «Терминале»).
3. Распакуй архив в домашнюю папку, чтобы получилось `~/futures-app`.
4. В «Терминале»:
   ```
   cd ~/futures-app/scripts/mexc-executor
   npm install playwright
   npx playwright install chromium
   chmod +x start.sh
   ```
5. Войди на биржи **своими** аккаунтами. Откроется окно браузера: залогинься
   и закрой окно.
   ```
   node executor.js login mexc
   node executor.js login toobit
   ```
   Второго аккаунта Toobit нет? Тогда в `config.json` у `toobit2` поставь
   `"enabled": false`. Если macOS спросит про «Chromium Safe Storage»,
   нажми «Разрешить всегда».
6. Свой Telegram-бот для отчётов:
   1. Создай бота у @BotFather и напиши ему `/start`.
   2. Открой `https://api.telegram.org/bot<ТОКЕН>/getUpdates`: число в
      `"chat":{"id":…}` и есть chatId.
   3. Впиши оба значения в `config.json`:
      ```json
      "telegram": { "enabled": true, "token": "<ТОКЕН>", "chatId": "<ID>", ... }
      ```

## Постоянный адрес (туннель ex2)

Если для этого Мака заведён туннель на своём домене (например, `ex2`), адрес
вебхука не меняется, а туннель работает службой и сам поднимается после
перезагрузки.

1. Владелец домена открывает в Cloudflare: Networks → Tunnels → **ex2** →
   Overview → **macOS** и копирует команду `cloudflared service install …`
   с токеном. Токен передаётся лично, не в общих чатах.
2. На Маке в «Терминале»:
   ```
   sudo cloudflared service install <ТОКЕН>
   ```
   Через полминуты у `ex2` в Cloudflare статус станет **Healthy**.
3. В Cloudflare: ex2 → Routes → маршрут `ex2.<домен>` → Service URL
   `http://127.0.0.1:8787` (именно `http://`).
4. В `config.json` на Маке:
   ```json
   "publicUrl": "https://ex2.<домен>",
   ```
5. Запуск как обычно, `./start.sh`. С `publicUrl` он поднимает только
   исполнитель и печатает постоянный адрес вебхука.

Проверка: `https://ex2.<домен>/health` показывает `{"ok":true,...}`.

## Запуск (каждый раз)

```
cd ~/futures-app/scripts/mexc-executor
./start.sh
```
Скрипт сам поднимает туннель и исполнитель и печатает две строки:

- **Панель:** `http://127.0.0.1:8787/panel/<секрет>`. Открой её в браузере на Маке.
  В ней задаются ставки, часы работы, цели и порог выплаты.
- **Вебхук:** `https://xxxx.trycloudflare.com/signal?secret=<секрет>`.
  На этот адрес панель принимает сигналы. Он меняется при каждом запуске
  `start.sh`, так что после перезапуска его нужно заново передать туда,
  откуда приходят сигналы.

Ctrl+C останавливает всё сразу.

То же самое в два окна «Терминала», как на Windows:

| Windows | Мак |
|---|---|
| `cd C:\Users\JakubPC\futures-app\scripts\mexc-executor` | `cd ~/futures-app/scripts/mexc-executor` |
| `node executor.js` | `caffeinate -dimsu node executor.js` |
| `C:\Users\JakubPC\cloudflared.exe tunnel --url http://127.0.0.1:8787` | `cloudflared tunnel --url http://127.0.0.1:8787` |

## Важно

- Мак не должен спать: держи его на зарядке и с открытой крышкой.
  `caffeinate` не даёт системе уснуть, пока идёт работа.
- Панель стартует в dry-run: ставки проходят до кнопки, но не открываются.
  Проверь несколько сигналов в журнале и только потом выключай dry-run в панели.
- Секрет из `config.json` не показывай никому: кто его знает, тот управляет
  ставками через туннель.
- Если `./start.sh` отвечает `bad interpreter`, выполни один раз:
  `cd ~/futures-app && git config core.autocrlf input && git checkout -- .`
- Обновить код: `cd ~/futures-app && git pull origin main`.
  Твой `config.json` при этом не трогается.
