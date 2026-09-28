# Переезд пульта на MacBook

## На Windows (сегодня)

1. Останови исполнитель (Ctrl+C в его окне) и туннель.
2. Собери архив:
   ```
   cd C:\Users\JakubPC\futures-app
   git pull origin main
   cd scripts\mexc-executor
   node executor.js move
   ```
   Появится `backup\futures-app-move-<дата>.zip`: весь проект с историей git,
   `config.json`, журналы и доходность. Профилей браузера в архиве нет
   нарочно: на macOS они не прочитаются, входить на биржи придётся заново.
3. Перенеси zip на флешке. **Не через облако и не через мессенджер:** внутри
   секрет панели и токен бота.

## На Маке (один раз)

1. Поставь Node.js LTS с https://nodejs.org (или `brew install node`).
2. Поставь туннель: `brew install cloudflared`
   (нет brew → https://brew.sh, одна команда в «Терминале»).
3. Распакуй архив в домашнюю папку, чтобы получилось `~/futures-app`.
4. В «Терминале»:
   ```
   cd ~/futures-app/scripts/mexc-executor
   npm install playwright
   npx playwright install chromium
   chmod +x start.sh
   ```
   Если `./start.sh` ответит `bad interpreter`, значит, на Windows он сохранился
   с виндовыми концами строк. Лечится один раз:
   `cd ~/futures-app && git config core.autocrlf input && git checkout -- .`
   Твои `config.json` и журналы эта команда не трогает: их нет в git.
5. Войди на биржи. На каждую откроется окно браузера: залогинься и закрой окно.
   ```
   node executor.js login mexc
   node executor.js login toobit
   node executor.js login toobit2
   ```
   Если macOS спросит про «Chromium Safe Storage», нажми «Разрешить всегда».
6. Новый бот Telegram: создай его у @BotFather, напиши ему `/start`, потом открой
   `https://api.telegram.org/bot<ТОКЕН>/getUpdates`: число в `"chat":{"id":…}` и есть chatId.
   Впиши оба значения в `config.json`:
   ```json
   "telegram": { "enabled": true, "token": "<ТОКЕН-НОВОГО-БОТА>", "chatId": "<ID>", ... }
   ```
   Старый токен отзови: @BotFather → /mybots → бот → API Token → Revoke.

## Запуск (каждый раз)

```
cd ~/futures-app/scripts/mexc-executor
./start.sh
```
Скрипт сам запускает туннель и исполнитель и печатает две строки:

- **Панель:** `http://127.0.0.1:8787/panel/<секрет>`, открой её в браузере на Маке;
- **Вебхук:** `https://xxxx.trycloudflare.com/signal?secret=<секрет>`.

Вебхук вставь в Apps Script (`CONFIG.MEXC.WEBHOOK_URL`, `CONFIG.TOOBIT.WEBHOOK_URL`),
сохрани и передеплой. Адрес туннеля меняется при каждом запуске `start.sh`.
Ctrl+C останавливает всё сразу.

Если хочется по-старому, в два окна «Терминала»:

| Windows | Мак |
|---|---|
| `cd C:\Users\JakubPC\futures-app\scripts\mexc-executor` | `cd ~/futures-app/scripts/mexc-executor` |
| `node executor.js` | `caffeinate -dimsu node executor.js` |
| `C:\Users\JakubPC\cloudflared.exe tunnel --url http://127.0.0.1:8787` | `cloudflared tunnel --url http://127.0.0.1:8787` |

## Важно

- **Не запускай Windows и Мак одновременно** на одних аккаунтах. Сначала
  останови Windows, потом переключай адрес вебхука на Мак.
- Мак не должен спать: держи его на зарядке и с открытой крышкой.
  `caffeinate` в `start.sh` не даёт системе уснуть, пока идёт работа.
- После переезда начни с `"dryRun": true` на одну-две ставки. Проверь в
  журнале, что ставка доходит до кнопки, и включай бой.
- Секрет панели сейчас много раз светился в переписке. При переезде смени его
  в `config.json` (`"secret"`) и в адресе вебхука в Apps Script.
- Обновления кода: `cd ~/futures-app && git pull origin main`.
