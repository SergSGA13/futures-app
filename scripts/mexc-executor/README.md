# MEXC Executor - автоторговля сигналов MEXC _10m

Локальный исполнитель: принимает принятые веткой MEXC сигналы от вебхука
и ставит ставки Up/Down на странице Event Futures MEXC кликами в браузере
(Playwright, постоянный залогиненный профиль Chrome).

**Важно понимать:** у Event Futures нет официального API - это
автоматизация интерфейса твоего собственного аккаунта. Возможен риск по
правилам биржи (автоматизация UI). Поэтому по умолчанию включён
**dry-run** (делает всё, кроме финального клика) и стоит минимальная
ставка. Включай боевой режим только после проверки скриншотов dry-run.

## Установка (домашний ПК, один раз)

1. Установи [Node.js LTS](https://nodejs.org) (18+).
2. В этой папке (`scripts/mexc-executor`):
   ```
   npm install playwright
   npx playwright install chromium
   copy config.example.json config.json     (Windows; на mac/linux: cp)
   ```
3. Открой `config.json`:
   - `secret` - придумай длинную случайную строку;
   - `stakeUSDT` - размер ставки (начни с минимума);
   - остальное можно не трогать.
4. Войди в аккаунт MEXC (окно откроется само, логин сохранится):
   ```
   node executor.js login
   ```
   Залогинься, реши капчу, закрой окно.

## Запуск

Терминал 1 - исполнитель:
```
node executor.js
```

Терминал 2 - туннель (даёт публичный https-адрес для вебхука):
```
cloudflared tunnel --url http://localhost:8787
```
([cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) -
один exe-файл; адрес вида `https://xxxx.trycloudflare.com` меняется при
перезапуске - для постоянного адреса заведи named tunnel или держи
процесс запущенным.)

## Подключение к вебхуку

В Apps Script, `CONFIG.MEXC.EXECUTOR`:
```js
EXECUTOR: {
  ENABLED: true,
  URL: "https://xxxx.trycloudflare.com/signal",
  SECRET: "тот же секрет, что в config.json",
  TIMEOUT: 5,
  TIMINGS: [10],   // автоторгуем только 10-минутки
},
```
Передеплой скрипт. Проверка: `https://xxxx.trycloudflare.com/health`
в браузере должен показать `{"ok":true,...}`.

## Порядок ввода в бой

1. **Dry-run неделю.** Исполнитель получает сигналы, проходит весь путь
   до кнопки и делает скриншот (`logs/shots/`). Сверь скриншоты и
   `logs/bets.csv` с реальными сигналами группы: то ли направление, тот
   ли таймфрейм, та ли сумма в поле.
2. Если селекторы не находят кнопку (в `logs/executor.log` ошибка
   "кнопка не найдена") - поправь `selectors` в config.json по факту
   (открой страницу, посмотри текст кнопок).
3. Боевой режим: `"dryRun": false` в config.json, перезапусти. Начни с
   минимальной ставки.

## Предохранители

- `dryRun` - по умолчанию включён;
- `maxBetsPerDay` - дневной лимит ставок;
- `maxSignalAgeSec` - устаревшие сигналы (>90с) не исполняются;
- `maxConsecutiveErrors` - после 3 ошибок подряд авто-возврат в dry-run
  + алерт в Telegram (если заполнены `tgToken`/`tgChatId` - можно взять
  того же бота и твой личный chat_id);
- страховочная проверка payout прямо со страницы перед кликом
  (`minPayout`) - вебхук уже фильтрует, но payout плавает;
- дедуп повторных доставок, ставки строго по одной, `/health` для
  мониторинга.

## Логи

- `logs/executor.log` - события;
- `logs/bets.csv` - каждая ставка/попытка (время, актив, направление,
  режим, статус, payout со страницы);
- `logs/shots/` - скриншот каждого действия (dry-run и боевых).
