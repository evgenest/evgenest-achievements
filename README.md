# EVGENEST Achievements

Личная доска почёта: Cloudflare Worker раз в неделю (пятница утром) сканирует всю активность на GitHub за последние 7 дней — коммиты, pull requests, issues по всем репозиториям — и с помощью LLM собирает подробный отчёт: таблицы по проектам, человеческое описание сделанного, оценка часов и «сколько бы это стоило» (офис vs фриланс), стрики и ачивки. Отчёт коммитится в `reports/YYYY-MM-DD.md`, уведомление со ссылкой приходит в Telegram.

## Архитектура

- **Cloudflare Worker** + cron trigger (пятница утром, UTC)
- **GitHub API**: REST (список репо, search PR/issues, коммит отчёта) + GraphQL (коммиты со статистикой одним запросом)
- **LLM**: OpenAI Responses API напрямую ИЛИ через Vercel AI Gateway (`@ai-sdk/gateway` + `ai`) — переключается переменной `LLM_PROVIDER`, модель одна и та же (`LLM_MODEL`, reasoning effort medium, structured output)
- **Workers KV**: стрик, all-time тоталы, разблокированные ачивки, снапшот прошлой недели
- **Telegram Bot API**: исходящий `sendMessage`, без webhook

## Модули

```
src/index.ts        — scheduled + fetch (ручной запуск /run)
src/run.ts          — оркестратор недельного прогона
src/github.ts       — сбор активности + коммит отчёта
src/llm.ts          — промпт и вызов LLM (OpenAI напрямую или через Vercel AI Gateway)
src/report.ts       — сборка markdown-отчёта
src/telegram.ts     — уведомление
src/state.ts        — состояние в KV
src/achievements.ts — правила ачивок
src/sanitize.ts     — страж данных перед отправкой в LLM
```

## Страж данных (что уходит в LLM)

GitHub-токен имеет право читать код, но приложение его никогда не запрашивает: из GitHub берутся только заголовки сообщений коммитов, счётчики строк, названия PR/issues, языки, статистика CI/деплоев. Перед отправкой в LLM (OpenAI или Vercel AI Gateway — в обоих случаях payload и путь идентичны) payload проходит через `src/sanitize.ts`:

- единственная точка выхода данных в LLM — явная проекция с allowlist полей;
- рекурсивная проверка ключей payload, fail-closed: незнакомый ключ = ошибка вместо отправки;
- текстовые поля обрезаются до 200 символов.

Содержимое файлов, диффы и патчи в LLM не попадают by construction.

## Настройка

Vars в `wrangler.jsonc`: `GITHUB_USER`, `REPORTS_REPO` (`<owner>/<repo>` для отчётов), `REPORT_LANG`, `DEV_PROFILE` (профиль разработчика для оценки зарплаты), `LLM_PROVIDER` (`openai` — напрямую в OpenAI, `gateway` — через Vercel AI Gateway), `LLM_MODEL` (модель, без префикса провайдера).

Секреты (`wrangler secret put <NAME>`):

| Секрет | Что это |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT: чтение всех репо + contents read/write для репо с отчётами |
| `OPENAI_API_KEY` | Ключ OpenAI API — нужен только при `LLM_PROVIDER=openai` |
| `VERCEL_AI_GATEWAY_API_KEY` | Ключ Vercel AI Gateway — нужен только при `LLM_PROVIDER=gateway` |
| `TELEGRAM_BOT_TOKEN` | Токен бота от @BotFather |
| `TELEGRAM_CHAT_ID` | ID чата с ботом (написать боту /start, взять из `getUpdates`) |
| `RUN_SECRET` | Произвольная строка для ручного запуска |

## Запуск

```bash
bun install
bun run types     # генерирует worker-configuration.d.ts
bun run check     # tsc --noEmit
bun run deploy
```

Ручной прогон (тест): `GET https://<worker-url>/run?key=<RUN_SECRET>`, опционально `&date=YYYY-MM-DD` — неделя, оканчивающаяся этой датой.

## Roadmap

- Демон на VPS: сканирование локальных git-папок, пуш сводки в отчёт (без входящих запросов к серверу)
- Тренды по неделям, месячные и годовые ретроспективы
