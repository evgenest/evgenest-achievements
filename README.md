# EVGENEST Achievements

Личная доска почёта: Cloudflare Worker раз в неделю (пятница утром) сканирует всю активность на GitHub за последние 7 дней — коммиты, pull requests, issues по всем репозиториям — и с помощью LLM собирает подробный отчёт: таблицы по проектам, человеческое описание сделанного, оценка часов и «сколько бы это стоило» (офис vs фриланс), стрики и ачивки. Отчёт коммитится в `reports/YYYY-MM-DD.md`, уведомление со ссылкой приходит в Telegram.

## Архитектура

- **Cloudflare Worker** + cron trigger (пятница утром, UTC)
- **GitHub API**: REST (список репо, search PR/issues, коммит отчёта) + GraphQL (коммиты со статистикой одним запросом)
- **OpenAI Responses API** (`gpt-5.6-luna`, reasoning effort medium, structured output)
- **Workers KV**: стрик, all-time тоталы, разблокированные ачивки, снапшот прошлой недели
- **Telegram Bot API**: исходящий `sendMessage`, без webhook

## Модули

```
src/index.ts        — scheduled + fetch (ручной запуск /run)
src/run.ts          — оркестратор недельного прогона
src/github.ts       — сбор активности + коммит отчёта
src/llm.ts          — промпт и вызов OpenAI
src/report.ts       — сборка markdown-отчёта
src/telegram.ts     — уведомление
src/state.ts        — состояние в KV
src/achievements.ts — правила ачивок
```

## Настройка

Vars в `wrangler.jsonc`: `GITHUB_USER`, `REPORTS_REPO` (`<owner>/<repo>` для отчётов), `REPORT_LANG`, `DEV_PROFILE` (профиль разработчика для оценки зарплаты).

Секреты (`wrangler secret put <NAME>`):

| Секрет | Что это |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT: чтение всех репо + contents read/write для репо с отчётами |
| `OPENAI_API_KEY` | Ключ OpenAI API |
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
