# 06. Карта изменений

> **Для кого:** тот, кто пишет код и проверяет pull request'ы; владельцу этот файл читать не обязательно.
> **Что здесь решает владелец:** ничего. Видимые изменения поведения для чужих форков (пункты №2, №3, №5, №6, №9) он
> подтверждает в [общем README](../README.md#изменения-поведения-для-форков); там же и сами вопросы.
> **Что просто к сведению:** какие файлы и в какой итерации меняются.

Алгоритмы и контракты — в [01-architecture.md](01-architecture.md), [07-selection.md](07-selection.md) и
[10-wire-and-ingest.md](10-wire-and-ingest.md); запись недели,
тренды и ретроспективы подробно описаны в своих папках, здесь по ним только файлы. Строки кода указаны по состоянию на
2026-09-19.

## Итерации: какие файлы трогает каждая

Порядок, размер, обоснования и приёмка итераций — в [общем README](../README.md#общий-порядок-итераций); здесь — только
главные файлы каждой, в том же порядке.

| Итерация | Главные файлы |
|---|---|
| **S0** | `src/llm.ts`, `wrangler*.jsonc`, `SECURITY.md` |
| **I0-минимум** | `test/golden/`, `src/index.ts`, `src/run.ts`, `src/github.ts`, `src/state.ts`, `wrangler*.jsonc` |
| **R0** | `src/record/*`, `src/state.ts`, `src/run.ts`, `src/github.ts`, `src/types.ts`, `src/hours.ts` |
| Корректирующие отчёты (каждую пятницу до I1) | `scripts/local-addendum.ts` |
| **R1** | `scripts/backfill-history.ts`, `scripts/records-rebuild.ts` |
| **R2** | `src/trends/*`, `src/report.ts`, `src/i18n/*`, `src/telegram.ts` |
| **Остаток I0** | `src/privacy.ts`, `src/sanitize.ts`, `src/github.ts` |
| **I1** (ядро + C1–C3 + I1-T + I1-P) | `src/ingest/*`, `collector/*`, `src/run.ts`, `src/state.ts`, `src/index.ts`, `test/ingest/model/*` |
| **R3** | `src/retro/*`, `src/llm/call.ts`, `src/index.ts`, `src/config.ts`, `src/github.ts` |
| **I2 + C4** | `collector/commands/*`, `docs/`, `src/achievements.ts` |
| **I3** | `collector/sources/claude-code.ts`, `src/ingest/sessions.ts` |
| **R4** | `src/retro/*` |
| I4 · **I5 / C5** · **I6 / C6** | `collector/commands/schedule.ts` · `src/ingest/verify-github.ts` · `src/ingest/verify-forge.ts`, `src/config.ts` |
| **A1** (по желанию) | `src/aliases/*`, `scripts/aliases-push.ts` |

## Изменения в существующих файлах `src/`

Почти всё новое живёт в новых папках; существующие файлы получают врезки по несколько строк, и каждая новая часть
обёрнута в свой `try/catch`.

| Файл | Итерации | Изменение |
|---|---|---|
| `src/llm.ts` | S0, R3, A1 | **S0:** строка 214 пишет `String(err.cause)`, а в причину AI SDK вкладывает весь ответ модели → писать только тип ошибки и обрезанную структуру. Общее правило для логов: код события, числа, короткие хеши — никогда тело чужого ответа. **R3:** общий вызов модели выносится в `src/llm/call.ts`. A1: превью ответа в логе проходит подметание словарём |
| `src/index.ts` | I0-мин, I1, R3 | **I0-мин:** `/run?date=` с `until ≤ lastRunUntil` → 409 с подсказкой про откат; ручной прогон с периодом короче суток → 409 (после отката кеш KV ~60 с даёт «неделю» длиной в минуты). Ответ 409 — только ранняя подсказка человеку: cron и потребитель очереди идут мимо обработчика, поэтому сама защита стоит внутри `runWeekly` — строка `src/run.ts`. `DELETE /state/latest` отвечает `until` и готовой строкой `rerun` (сегодня — `{ deleted }`, строки 74–79). **I1:** маршруты `/ingest*`; предпроверка полноты снимков на ручном `/run` (409, `force=1`, `warnings`); `DELETE` переписывает список учтённого. **R3:** **сначала** отдельным деплоем — разбор `kind` с подтверждением незнакомого сообщения (сегодня форма сообщения не проверяется, строки 49–53), **потом** постановка в очередь — в `runInBackground` (строки 29–41), после успешного `runWeekly`, в своём `try/catch` (лог `retro_enqueue_failed`); маршрут `POST /retro` |
| `src/auth.ts` (новый), `src/env-optional.d.ts` (новый) | I1 | Проверка токенов вынесена из `index.ts`; функция сравнения передаётся параметром (`crypto.subtle.timingSafeEqual` есть только в Workers). `interface Env { INGEST_TOKEN?: string }` |
| `src/run.ts` | I0-мин, R0, R2, I1 | **I0-мин:** строка «отчёт за N дней: прошлый прогон не состоялся». **Защита от мусорного прогона** (решение после проверки на прочность): в начале `runWeekly`, сразу после загрузки state (строки 30–38): `since ≥ until` либо ручной прогон с периодом короче суток → лог `run_skipped_stale_state` и выход без единой записи — ни файла отчёта, ни state, ни Telegram. Причина: HTTP-обработчик и потребитель очереди могут видеть разный state (кеш KV ~60 с), а очередь может доставить сообщение дважды; сегодня такой прогон перезаписал бы файл хорошего отчёта и прибавил `reportCount`. *Принятое допущение:* для сообщения очереди — один раз `message.retry({ delaySeconds: 90 })`, чтобы пережить кеш KV. Приёмка: «сообщение доставлено дважды → вторая доставка ничего не пишет». **R0:** порядок `buildReport` → (подметание словарём, если он задан) → встроить запись → `commitFile` (один запрос записи) → Telegram → `saveState`. **R2:** блок трендов. **I1:** врезка между `collectWeekActivity` и `applyPrivacy` (строки 40–41): `loadSnapshots`, `checkReportsRepo`, `localTextGate`, `selectLocal`, `mergeLocal`; после `saveState` — `publishAccounted` |
| `src/state.ts` | I0-мин, R0, I1 | **I0-мин:** `deleteLatestState` возвращает `until`, `current`, `parent` и не делает второго `list()` после удаления; `advanceState` переносит **незнакомые поля верхнего уровня state как есть** — сегодня он собирает объект из явного списка полей (строки 78–100), и деплой более старого кода молча стирает всё, чего не знает. После этого откат на любой код не старше I0-минимума не стирает ни `history`, ни `career`, ни `local`; в данные для модели такие поля не попадают (`src/sanitize.ts` разворачивает только `allTime` и `lastWeek`). **R0:** общая сигнатура `advanceState(state, week, unlockedIds, rates, extras)`, `extras = { record?, local? }`; `history` (до 53 записей) и `career`. **I1:** `loadStateWithLineage` (state, его ключ, ключи цепочки); поле `local` — журнал учтённого |
| `src/github.ts` | I0-мин, R0, ост. I0, I1, R3 | **I0-мин:** `REPORTS_REPO` исключается из сбора — одна строка фильтра после `fetchAllRepos` (строка 196). **R0:** `created_at`, `closed_at`, `merged_at` из уже приходящего ответа поиска → `PrInfo` и `IssueInfo`; новых запросов нет. **Остаток I0:** `history(until:)` (строка 116). **I1:** `oid` → `CommitInfo.sha`. **R3:** `commitFile` делится на `getFile` и `putFile` (остаётся обёрткой) |
| `src/types.ts` | R0, I1, I3 | Всё необязательное. R0: `AppState.history?`, `AppState.career?`, даты в `PrInfo` и `IssueInfo`. I1: `CommitInfo.sha?`, `RepoActivity.local?`, `WeekActivity.local?`, `AppState.local?`. I3: `WeekActivity.ai?`, `AppState.local.covered?` |
| `src/privacy.ts` | ост. I0, R0, I1, I3 | **Остаток I0:** `redactPrivate` и `dropPrivate` собирают объекты из явных списков полей с проверкой полноты на уровне типов; `authoredDate` и даты PR и issues (`createdAt`, `mergedAt`, `closedAt`) вносятся как переживающие скрытие — это не текст. R0: правок нет — объекты сегодня копируются целиком (строки 54–65), новые даты переживают скрытие сами; это закрепляет тест. I1: правила для `local`, `sha`, `week.local`. I3: заголовки и разбивка по проектам |
| `src/sanitize.ts` | ост. I0, I1, I3 | **Остаток I0:** явные проекции `allTime` и `lastWeek` вместо `{...state.*}` (строки 167–168) — иначе любое новое поле state роняет защиту данных для модели на следующем прогоне у всех форков. **Остаток I0, если принят №2:** вырезание служебных хвостов коммитов (`Co-Authored-By` и подобных) и e-mail'ов из входа модели. I1: ключи `localCommits`, `lateCommits` и фраза в промпте. I3: `aiPairingMinutes`, `aiSessions`, `aiPrompts`, `sessionTitles`. Факты трендов в данные для модели **не добавляются** |
| `src/hours.ts` | R0 | Константа `HOURS_ALGO_VERSION = 1` |
| `src/report.ts`, `src/i18n/*` | I0-мин, R2, I1, I3 | Строка про несостоявшийся прогон; параметр `trends`; сноска о локальных источниках, причина скрытого текста (`local.textHidden.*`), пометка «только цифры», «сырые − загруженные» строки, «—» в столбце изменений; строки сессий (en и ru) |
| `src/telegram.ts` | R2, R3 | Необязательная строка трендов — только по поводу; сообщение о готовой ретроспективе (пункт №8) |
| `src/config.ts` | R3, C6 | Переменные `RETROSPECTIVES` (по умолчанию `false`) и `PUBLIC_HOSTS` (не задана — 0 запросов) |
| `src/achievements.ts` | I2 | Ачивка `off-grid`; тест «у каждой ачивки есть текст в en и ru» |

Честно про `history(until:)`: это **изменение поведения** для всех форков — прогон с `?date=` перестаёт захватывать
коммиты после `until`, а коммит, запушенный между стартом cron и запросом, уезжает в следующий отчёт. Поиск PR и issues,
CI и деплои сверху по-прежнему не ограничены — известная оставшаяся несогласованность.

## Новые модули

Каждая новая функция — своя папка, чистые функции без `Env` отдельно от единственного файла, который ходит в сеть или KV.

| Модуль | Итерация | Что внутри |
|---|---|---|
| `src/record/` — `types`, `build`, `embed`, `history` | R0 | `WeekRecord` v1, `buildWeekRecord`, встраивание в отчёт и чтение, `history` — [../week-record/](../week-record/README.md) |
| `src/trends/` — `series`, `facts`, `render` | R2 | [../trends/](../trends/README.md) |
| `src/llm/call.ts`; `src/retro/` — `types`, `due`, `aggregate`, `strip`, `payload`, `render`, `run` | R3, R4 | [../retrospectives/](../retrospectives/README.md) |
| `src/ingest/` — `wire`, `guard`, `handler`, `store`, `select`, `ledger`, `merge` | I1, ядро | Формат передачи, валидатор, приём, чтение снимков, выбор, журнал учтённого, слияние |
| `src/ingest/accounted.ts` | I1-T | `buildAccounted`, `publishAccounted`, `isComplete`; запись журнала `<sha10>:<hk12>` и замыкание ключей — в `select.ts` и `ledger.ts` |
| `src/ingest/visibility.ts` | C2, C3 | `localTextGate`; шов `resolveLocalVisibility` — до I5 всегда «приватно» |
| `src/ingest/sessions.ts` | I3 | `selectSessions` и учтённые интервалы |
| `src/ingest/verify-github.ts` · `verify-forge.ts` | C5 · C6 | Проверка публичности: один терпимый запрос GraphQL · адаптеры `forgejo` и `gitlab` |
| `collector/` — `cli`, `config`, `rules`, `version`, `discover`, `remote`, `classify`, `git/*`, `sources/git-local`, `snapshot`, `transport`, `commands/scan`, `push`, `set` | I1 | Раскладка — в [03-collector.md](03-collector.md); `version.ts` нужен уже в I1: снимок несёт `collectorVersion`. I2: `commands/init`, `repos`, `doctor`, `schedule`. I3: `sources/claude-code.ts` ([03b](03b-sessions.md)) |
| `scripts/local-addendum.ts` | до I1 | Корректирующие отчёты; после R0 зовёт тот же `buildWeekRecord(kind: "corrective")`, после C1 и C2 — те же `resolveMode` и `localTextGate` |
| `scripts/backfill-history.ts`, `scripts/records-rebuild.ts` | R1 | Только локально; Worker не меняется |
| `test/ingest/model/*` | I1-P | Модель передачи с эталоном полного окна; крутит **настоящие** `selectLocal`, `buildAccounted`, `isComplete` и сборку снимка; наивное правило и нестрогая проверка полноты обязаны ронять тест |
| `src/aliases/` — `compile`, `match`, `strip`, `apply`, `detect`, `load`; `scripts/aliases-push.ts`; `aliases.example.json` | A1 | Только если владелец решит строить словарь (пункт №1): секреты `ALIASES_1…8`; одна общая регулярка; закрытый список русских окончаний; проверка до модели бросает исключение, подметание после — нет |

## Части C1–C6: настройки и видимость

Шесть небольших частей живут внутри больших итераций; первые три обязаны выйти до заморозки формата передачи.

| Часть | Внутри | Файлы | Приёмка (кратко) |
|---|---|---|---|
| **C1** | I1 | `collector/rules.ts`, `collector/commands/set.ts`, `scan.ts`, `collector/config.ts`; ключ диагностики `reposUndecided` | Две строки конфига и команды `set` дают нужные режимы; в `push --dry-run` нет ни байта репозиториев `off`, `git log` по ним не запускался; перенос папки не снимает `off`; шаблон не наследует `text`; запуск по расписанию конфиг не пишет |
| **C2** | I1 | `src/ingest/visibility.ts`, `src/ingest/handler.ts` (проверочный запрос, `ingest:v1:policy` со сроком 3600 с), `src/i18n/*` | Шага «сначала preview» больше нет; при `redact`, публичном репозитории отчётов или сбое проверки текст не покидает машину, а присланный «непослушным» клиентом отбрасывается; не больше одного обращения к GitHub в час |
| **C3** | I1 | `src/ingest/wire.ts`, `guard.ts` (`WireRepo.claim?`), `publicHosts: []`, деление репозитория в `merge.ts` (путь выключен) | Снимок с заявкой принимается, заявка не читается, отчёт байт в байт тот же |
| **C4** | I2 | `collector/commands/init.ts`, `repos.ts`, `doctor.ts`; страница «как настроить» (русская и английский двойник) | Новый пользователь проходит путь без чтения кода и правки JSON; `init` ничего не отмечает заранее; тест с меткой-приманкой |
| **C5** | I5 | `src/ingest/verify-github.ts` | Подделка через чужой форк → приватно; ровно +1 внешний запрос — [09](09-public-visibility.md) |
| **C6** | I6 | `src/config.ts` (`PUBLIC_HOSTS`), `src/ingest/verify-forge.ts` | Без переменной — 0 запросов; ни один запрос не несёт авторизации; седьмой запрос не делается |

## Изменения вне `src/`

Конфиги и тесты меняются мало, но две строки конфигов обязательны до R0.

| Файл | Итерация | Изменение |
|---|---|---|
| `wrangler.jsonc`, `wrangler.ci.jsonc` и подсказка для личного конфига, скопированного с шаблона | S0, I0-мин, R3 | S0(б): `observability.traces.persist` — по решению владельца (пункт №3; сегодня `true`, строки 22–26). I0-мин: у потребителя очереди `"max_concurrency": 1` — очередь масштабируется сама, и два прогона с `?date=` иначе могут идти одновременно по одному state. Ретроспективы настройки очереди не меняют (ни `max_retries`, ни cron); **R3** добавляет в шаблон `wrangler.jsonc` только переменную `RETROSPECTIVES` (по умолчанию `false`) |
| `test/golden/*`, `test/fixtures.ts` | I0-мин, R0, R2, R3, I1 | «Золотой» отчёт и данные для модели; I0-мин: тесты «сообщение доставлено дважды → вторая доставка ничего не пишет» и «незнакомое поле state переживает прогон»; золотой JSON каждой версии записи; золотые блоки трендов и файл месяца. I1: подделка KV получает `getWithMetadata`, срок жизни, `put` с `ArrayBuffer`, счётчик `list()` |
| `test/github.test.ts` | ост. I0, I1 | Проверка `until` в запросе; `oid` в тестовом узле |
| `vitest.config.ts`, `package.json` | I1 | `include` += `collector/test/**/*.test.ts` — иначе тесты collector'а молча не запускаются; скрипты `collector`, `check:collector`, `dev:ingest` |
| `collector/tsconfig.json` | I1 | `types: ["node"]` + `@types/node` в devDependencies и тест-поиск на `Bun.` — иначе запрет `Bun.*` ничем не проверяется |
| `.github/workflows/ci.yml`, `deploy.yml` | I1, I2 | Шаги `check:collector` и тесты в **обоих** (deploy повторяет ci); набор ОС — только в ci |
| `.dev.vars.example`, комментарий в `wrangler.jsonc` | I1 | Подсказка про `INGEST_TOKEN` и `--var` |
| `collector/version.ts` | I1 | Источник `collectorVersion` |
| Теги релизов `collector-vX.Y.Z` | I2 | Сверка `version.ts` с тегом в CI |

## Изменения поведения для форков

Список один, и лежит он в [общем README](../README.md#изменения-поведения-для-форков): там владелец подтверждает каждый
пункт. Здесь — только файлы, которые эти изменения затрагивают (таблицы выше).

## Правки документации проекта: что устаревает

Пункты 1–6 по `SECURITY.md` выходят в том же pull request'е, что и I1; остальное — с I2.

`SECURITY.md`: (1) «Every endpoint is authenticated … against `RUN_SECRET` … Every other path is `404`» — появляются
второй токен и маршруты; (2) таблица секретов — строка `INGEST_TOKEN`: **не «только запись»**, он читает список
учтённого ([08](08-threat-model.md)); (3) «Commit messages, PR and issue titles … written by other people end up in the
prompt» — добавить текст, присланный держателем `INGEST_TOKEN`; (4) область вырезания секретов — теперь ещё отчёт и
машина; (5) новый раздел «данные в покое», включая трассы и логи на путях ошибок; фраза про логи, которые пишут «the
*shape* of the answer, not its content», станет правдой только после S0; (6) строка `RUN_SECRET`: + список машин,
preview, удаление снимков, `force=1`, `/retro`; (7) с R0 — «при `full` в KV лежат имена проектов за 53 недели».

`README.md`: «scans every repository you touched»; «authenticated `/run` and `/state` endpoints»; перечень содержимого
KV («только счётчики» → «счётчики, записи недель, короткие хеши учтённого и транзитные снимки не старше 9 дней»);
«`PRIVATE_REPOS` decides what happens to repositories GitHub marks private»; раздел секретов и `.dev.vars`; «Only
default-branch commits authored by `GITHUB_USER` are counted»; список модулей; «Known limitations»; новая строка про
Workers Free («проверено, не гарантировано»); новый раздел «Изменения поведения». Сохраняемые обещания называем явно:
модель по-прежнему не видит временны́х меток, SHA, номеров машин, содержимого файлов и диффов.
