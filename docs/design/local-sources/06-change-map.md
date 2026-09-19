# 06. Карта изменений

Что и в какой итерации меняется. Алгоритмы и контракты — в [01-architecture.md](01-architecture.md).

## Изменения в `src/`

| Файл | Итерация | Изменение |
|---|---|---|
| `src/privacy.ts` | I0, I1 | I0: `redactPrivate`/`dropPrivate` собирают объекты из явных списков полей с проверкой полноты (`satisfies Record<keyof CommitInfo, true>` и т.п.) — новое поле требует явного решения; `authoredDate` сохраняется. I1: правила для `local`, `sha`, `week.local` из таблицы режимов в [01](01-architecture.md#слияние) |
| `src/sanitize.ts` | I0, I1 | I0: явные проекции `allTime`/`lastWeek` вместо `{...state.*}` — иначе любое новое поле state роняет LLM-guard **на следующем прогоне у всех форков**. I1: ключи `localCommits`, `lateCommits` + фраза в промпте |
| `src/github.ts` | I0, I1 | I0: `history(until:)`. I1: `oid` → `CommitInfo.sha` |
| `src/types.ts` | I1, I3 | всё необязательное. I1: `CommitInfo.sha?`, `RepoActivity.local?`, `WeekActivity.local?`, `AppState.local?`, `WeekSnapshot.localCommits?`. I3: `WeekActivity.ai?`, `WeekSnapshot.aiPairingMinutes?`, `AppState.local.covered?` |
| `src/ingest/*` | I1 | новый модуль; каждый файл — одна забота |
| `src/auth.ts`, `src/index.ts` | I1 | проверка токенов вынесена; компаратор передаётся параметром (`crypto.subtle.timingSafeEqual` — расширение Workers, под Node-vitest его нет); маршруты `/ingest*` |
| `src/env-optional.d.ts` | I1 | `interface Env { INGEST_TOKEN?: string }` |
| `src/state.ts`, `src/run.ts` | I0, I1 | I0 (предложение): `/run?date=` с `until ≤ lastRunUntil` → 409 с подсказкой про откат — сегодня такой прогон выпускает мусорный отчёт, обнуляет streak и откатывает `lastRunUntil`. I1: перенос/запись `local` (`advanceState(…, extras)`); врезка; проверка reports-репозитория и запись `ingest:v1:policy` — только при заданном токене |
| `src/ingest/sessions.ts`, `src/sanitize.ts`, `src/privacy.ts`, `src/report.ts`, `src/i18n/*` | I3 | `selectSessions` и набор покрытия; ключи `aiPairingMinutes`/`aiSessions`/`aiPrompts`/`sessionTitles`; правила для заголовков и разбивки по проектам; строки отчёта (en + ru) |
| `src/report.ts`, `src/i18n/*` | I1 | сноска, пометка «только счётчики», «—» в дельтах, сортировка при включённой фиче (en + ru) |
| `src/achievements.ts`, `src/i18n/*` | I2 | `off-grid`; тест «у каждой ачивки есть текст в en и ru» (`Messages.achievements` — `Record<string, …>`, пропуск компилируется и рендерит `undefined`) |
| `src/totals.ts`, переиспользование `isActiveWeek` в `report.ts` | когда удобно | рефакторинг, не предпосылка (копий редьюсеров итогов две в `src/` + одна в `test/fixtures.ts`) |

Честно про I0: `history(until:)` — **изменение поведения** для всех форков: `?date=`-прогон
перестаёт захватывать коммиты после `until`, а коммит, запушенный между стартом cron и
GraphQL-запросом, уезжает в следующий отчёт. Поиск PR/issues, CI, deployments и предфильтр
`pushed_at` сверху по-прежнему не ограничены — известная оставшаяся несогласованность.

## Изменения вне `src/`

| Файл | Итерация | Изменение |
|---|---|---|
| `vitest.config.ts` | I1 | `include` += `collector/test/**/*.test.ts` — иначе тесты collector'а молча не запускаются |
| `package.json` | I1 | скрипты `collector`, `check:collector`, `dev:ingest` |
| `.github/workflows/ci.yml`, `deploy.yml` | I1, I2 | шаги `check:collector` + тесты в **обоих** (deploy дублирует ci); матрица ОС — только в ci |
| `test/fixtures.ts` | I0, I1 | I0: «золотые» файлы. I1: KV-фейк: `getWithMetadata`, `expirationTtl`, `put` с `ArrayBuffer`, `get("text")`; сборщики state/week/commit |
| `test/github.test.ts` | I0, I1 | `oid` в фикстуре узла; проверка `until` в запросе |
| `.dev.vars.example`, комментарий в `wrangler.jsonc` | I1 | подсказка про `INGEST_TOKEN` и `--var` |
| `collector/tsconfig.json` | I1 | `types: ["node"]` + `@types/node` в devDependencies (не копия `scripts/tsconfig.json` с `bun-types` — иначе запрет `Bun.*` ничем не проверяется) + grep-тест на `\bBun\.` |
| `wrangler.jsonc` (и подсказка для prod-конфигов) | I0 | consumer очереди: `"max_concurrency": 1` — очереди масштабируются сами, и два `?date=`-прогона иначе могут идти одновременно по одному state |
| `collector/version.ts`, релизные теги `collector-vX.Y.Z` | I2 | источник `collectorVersion`; сверка с тегом в CI. До появления тегов в документации — «закреплённый коммит» |

## Правки документации: что именно устаревает

**В том же PR, что и I1:** пункты 1–3, 5, 6 по `SECURITY.md`. Остальное — I2.

`SECURITY.md`: (1) «Every endpoint is authenticated … against `RUN_SECRET` … Every other path is
`404`» — появляется второй токен и роуты; (2) таблица секретов — строка `INGEST_TOKEN` с радиусом
поражения; (3) «Commit messages, PR and issue titles … written by other people end up in the
prompt» — добавить текст, присланный держателем `INGEST_TOKEN`; (4) область действия скраббера —
теперь ещё отчёт и клиент; (5) новый пункт «данные в покое» (см. [02](02-privacy-security.md));
(6) строка `RUN_SECRET` в таблице радиуса поражения: + список машин и метаданные push'ей, preview
(счётчики), удаление снимков машин (восстановимо следующим push).

`README.md`: «scans every repository you touched»; «authenticated `/run` and `/state` endpoints»;
перечень содержимого KV; «`PRIVATE_REPOS` decides what happens to repositories GitHub marks
private»; раздел секретов и `.dev.vars`; абзац про типизацию секретов; «Only default-branch
commits authored by `GITHUB_USER` are counted»; список модулей; абзацы про CI; «Known limitations».
Сохраняемые обещания называем явно: LLM по-прежнему не видит временны́х меток, SHA, `machineId`,
содержимого файлов и диффов.
