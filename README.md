# Futures Prediction

Telegram Mini App со сводкой реальных сделок по веткам (Binance Pro 10 мин,
MEXC 10 и 30 мин, ByBit 5 мин), плюс скрипты, которые готовят для него данные.

## Что где лежит

```
docs/                    мини-приложение (раздаёт GitHub Pages)
  index.html, app.js, styles.css, translations.js
  live-charts.js         свечной график раздела Futures Strategy
  futures-strategy.js    раздел Futures Strategy
  brand/                 фон и шрифт (см. brand/README.md)
  img/                   логотип и картинки статей
scripts/
  actions/               скрипты, которые запускают workflow
    backtest_v29.py      бэктест v.29.1 для раздела Futures Strategy
    update_sheets.py     пишет результаты бэктеста в таблицу
    dev_badlist.py       утренний список DEV_BADLIST / DEV_TOPLIST
    requirements.txt     зависимости для обоих workflow
  gas/                   Apps Script доступа к каналам (см. scripts/gas/README.md)
.github/workflows/       dev-badlist.yml, futures-stats.yml
```

## Приложение

GitHub Pages: ветка `main`, папка `/docs`. Адрес приложения не содержит
`docs`, поэтому кнопка бота смотрит на тот же адрес, что и раньше.
Файлы приложения держать внутри `docs/`: всё, что лежит там, раздаётся
публично, а то, что вне `docs/`, через Pages не раздаётся.

Проверить локально:

```
cd docs
python -m http.server 8000
```

и открыть `http://localhost:8000/`. Вне Telegram приложение открывается в
режиме браузера, данные читаются так же.

## Таблица с данными

Приложение и скрипты читают Google-таблицу по названиям листов (ALLsignal,
MEXCsignal, MEXC30signal, 5Msignal, BLOCKEDsignal, ANAL L7D, DEV_BADLIST,
DEV_TOPLIST, FUT_STRAT...) и по заголовкам колонок. Эти названия читают и
другие инструменты: не переименовывать листы и колонки без проверки всех,
кто их читает.

## Workflow

| Workflow | Когда | Что делает |
|---|---|---|
| `dev-badlist.yml` | ежедневно 02:37 UTC | `scripts/actions/dev_badlist.py`: вкладки DEV_BADLIST и DEV_TOPLIST |
| `futures-stats.yml` | каждые 6 ч | `scripts/actions/update_sheets.py`: бэктест и вкладки FUT_STRAT* |

Оба требуют секрет репозитория `GOOGLE_CREDS_JSON` (ключ сервисного аккаунта
целиком): Settings -> Secrets and variables -> Actions. Без секрета запуск
проходит с предупреждением и ничего не пишет. Ручной запуск: вкладка Actions,
Run workflow (у `futures-stats` есть режим dry run без записи в таблицу).

## Apps Script

Править исходники `scripts/gas/01..08_*.gs`, затем собрать:

```
python scripts/gas/build_all_in_one.py
```

Собранные `ALL_IN_ONE.gs` / `ALL_IN_ONE_STANDALONE.gs` вставляются в проект
Apps Script вручную, из репозитория они не разворачиваются.

## Исполнитель

Исполнитель ставок живёт в отдельном проекте и в этот репозиторий не входит.
Папка `scripts/mexc-executor/` целиком в `.gitignore`: в старых клонах там
остаются его конфиг и профиль браузера, и в коммит они попасть не должны.

## Секреты

Ключи, токены и пароли в репозиторий не коммитятся (см. `.gitignore`). Репозиторий публичный, и удаление файла из
текущей версии не убирает его из истории: если секрет попал в коммит, его
нужно сменить.
