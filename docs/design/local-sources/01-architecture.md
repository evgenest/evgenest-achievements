# 01. Архитектура

## Компоненты

| Компонент | Где живёт | Ответственность |
|---|---|---|
| **collector** | `collector/` в этом же репо, запускается на машине разработчика | Найти репозитории, прочитать `git log` и метаданные сессий, собрать снимок, провалидировать, отправить. Каждый push — полный снимок окна; локально хранится только выбрасываемый кэш |
| **wire-контракт** | `src/ingest/wire.ts`, `src/ingest/guard.ts` — без `Env`, импортируются и Worker'ом, и collector'ом | Типы снимка, лимиты, регулярки, рукописный валидатор |
| **ingest-роут** | `src/ingest/handler.ts` | Принять снимок, не разбирая тело, положить в KV |
| **store** | `src/ingest/store.ts` | В прогоне: прочитать индекс машин и их снимки, провалидировать. `machineId` берётся из имени ключа; снимок с другим `machineId` в теле отклоняется. Битый снимок пропускает машину, а не роняет неделю |
| **select + ledger** | `src/ingest/select.ts`, `src/ingest/ledger.ts` | Чистая функция: (state, снимки, GitHub-коммиты, since, until) → события недели + следующий ledger |
| **merge** | `src/ingest/merge.ts` | Превратить выбранное в `RepoActivity[]` и влить в `WeekActivity` до `applyPrivacy` |

Строгость guard'а разная: **collector строгий** (неизвестный ключ = ошибка до отправки),
**Worker терпимый** (проверяет типы известных полей, неизвестные ключи считает в сноску). Тело
хранится неразобранным, поэтому строгость на Worker'е приватности не добавляет, а collector
чуть новее Worker'а не должен «исчезать» на неделю.

Точка врезки одна — `src/run.ts`, между `collectWeekActivity` и `applyPrivacy`:

```
collected = collectWeekActivity(env, config, since, until)
if (env.INGEST_TOKEN) {
  snapshots      = loadSnapshots(env)               // сбой KV / ноль валидных → [], никогда не бросает
  reportsPrivate = await checkReportsRepo(env)      // +1 внешний subrequest; результат → ingest:v1:policy
  sel            = selectLocal(state.local, snapshots, collected, since, until)
  merged         = mergeLocal(collected, sel, reportsPrivate)   // + пересчёт итогов
} else {
  merged = collected                                // ноль обращений к KV, ноль новых subrequest'ов
  sel    = { next: state.local ? appendGithubKeys(state.local, collected) : undefined }
}
week = applyPrivacy(merged, policy)
…
saveState(advanceState(state, week, …, sel.next))
```

- С токеном выбор запускается **всегда**, когда `since < until`, — в том числе при нуле валидных
  снимков и при сбое чтения KV: выбрано пусто, но ledger создаётся, `from` закрепляется, а
  GitHub-коммиты прогона записываются. Иначе зеркальные коммиты этой недели задвоились бы
  опоздавшими локальными копиями, а неделя подключения первой машины потерялась бы.
- Без токена `selectLocal` не вызывается. Если `state.local` уже существует (фичу выключили),
  в него чистой функцией, без KV, дописываются ключи GitHub-коммитов прогона; если его нет — state
  форка не меняется вовсе.
- Однажды записанный `local` не теряется никогда.
- Выход `selectLocal`: `{ picked, next, dropGithubShas, counters }`. GitHub-репозиторий, у
  которого после `dropGithubShas` не осталось коммитов, удаляется; итоги пересчитываются.

## Wire-схема v1

Замораживается в конце I1 — после того как collector реально отработал на ней.

```ts
// src/ingest/wire.ts
export const WIRE_SCHEMA = 1 as const;
export const WINDOW_DAYS = 35;                         // MAX_LOOKBACK_MS Worker'а (28 д) + 7 д
export const MAX_WINDOW_DAYS = 120;                    // потолок для push --window-days (backfill)

export const LIMITS = {
  bodyBytes: 2 * 1024 * 1024,
  minBodyBytes: 64,
  machines: 5,
  reposPerSnapshot: 200,
  commitsPerSnapshot: 2000,
  nameChars: 100,
  headlineChars: 200,
  messageChars: 1000,
  titleChars: 120,
  promptsPerSnapshot: 5000,
  commitsPerRunPerWeek: 300,                           // × ceil((until − since) / 7 д)
  ttlSeconds: 45 * 24 * 60 * 60,
  minPushIntervalSeconds: 10,
  pushesPerDay: 96,                                    // 5 машин × 96 = 480 < 1000 KV-записей Free
} as const;

export type IsoInstant = string;                       // ровно Date#toISOString(), всегда UTC
export type ShareMode = "counters" | "text";

export interface WireCommit {
  sha: string;                 // 40 или 64 hex — точная идентичность
  authoredAt: IsoInstant;      // → CommitInfo.authoredDate; единственная дата для окна и дедупа
  committedAt: IsoInstant;     // → CommitInfo.date
  additions: number;
  deletions: number;
  headline?: string;           // только share = "text"; скраббинг + обрезка на клиенте
  message?: string;            //   и повторно на Worker'е
}

export interface WireRepo {
  id: string;                  // 12 hex: sha256(наименьший корневой SHA + "\n" + нормализованный host/path remote); локальный путь в id не входит
  share: ShareMode;
  name: string | null;         // "text": /^[A-Za-z0-9][A-Za-z0-9._-]*$/, ≤ nameChars; "counters": null
  commits: WireCommit[];       // без merge, только свои e-mail'ы, без shallow-границы, без дат из будущего;
                               //   сверх commitsPerSnapshot отбрасываются СТАРЕЙШИЕ (commitsTruncated), push не падает
}

export interface WireSession {                         // читается Worker'ом с I3; до I3 принимается и игнорируется
  prompts: IsoInstant[];       // метки ЧЕЛОВЕЧЕСКИХ промптов, округлённые до минуты
  repo?: string | null;        // уровень "projects": WireRepo.id | "gh:<12 hex sha256(owner/name)>" | null
  title?: string;              // уровень "titles": aiTitle, скраббинг, ≤ titleChars
}

export const DIAGNOSTIC_KEYS = [                       // закрытый список; другие ключи guard не пропустит
  "reposScanned", "reposSkippedGithub", "reposSkippedForeign", "reposSkippedHost",
  "reposSkippedNoRemote", "reposSkippedPartialClone", "reposExcluded", "reposFailed",
  "reposShallowId", "dirsUnreadable", "commitsFutureDated", "commitsShallow",
  "commitsTruncated", "textDropped", "textDowngraded",
  "sessionFilesRead", "sessionFilesNoOrigin", "sessionLinesSkipped", "promptsSkippedScope",
] as const;

export interface IngestSnapshot {
  schema: typeof WIRE_SCHEMA;
  machineId: string;           // /^m-[0-9a-f]{8}$/, случайный; обязан совпасть с сегментом URL
  collectorVersion: string;    // /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/
  generatedAt: IsoInstant;
  windowStart: IsoInstant;     // выровнен по началу UTC-дня
  repos: WireRepo[];           // id уникальны внутри снимка — клоны collector сливает сам
  sessions?: { tool: "claude-code"; sessions: WireSession[] };
  diagnostics: Partial<Record<(typeof DIAGNOSTIC_KEYS)[number], number>>;
}
```

Чего на проводе **нет ни в одном режиме**: абсолютных путей, `cwd`, имени хоста, имени
пользователя ОС, e-mail'ов, имён веток, URL и хостов remote'ов, имён файлов, диффов, id сессий,
текста промптов и ответов. GitHub-репозиторий в ключе проекта сессии — хеш `owner/name`: Worker
сопоставляет его с хешами списка `/user/repos`; нет в списке → приватный (fail-closed).
`sha` и `id` — **псевдонимы, не анонимность**: коммит, существующий и публично, находится поиском по SHA.

Любое изменение формы — это `/ingest/v2` рядом с `v1`. Worker берёт у машины ключ старшей
поддерживаемой схемы; collector на 404 от `v2` откатывается на `v1`.

## Ingest-роут

`PUT /ingest/v1/<machineId>`, `Authorization: Bearer <ingest-token>`,
`X-Collector-Version: <semver>`. Каждый ответ Worker'а **после авторизации и отказ 403** несёт
заголовок `X-Ingest: 1` — так collector отличает отказ Worker'а от 403/503, сгенерированных
защитой зоны Cloudflare на кастомном домене. 404 при выключенной фиче заголовка не несёт.

Порядок (тело не парсится никогда):

1. `INGEST_TOKEN` не задан → **404**. Задан, но равен `RUN_SECRET` → ошибка конфигурации в лог и тоже 404.
2. Bearer не совпал (хеш + constant-time, как `keyMatches`) → **403**. `RUN_SECRET` здесь не
   принимается; `INGEST_TOKEN` не принимается на остальных роутах.
3. `machineId` не проходит регулярку → **400**.
4. **Probe:** `Content-Length: 0` → **200** `{ probe: true, supported: [1], privacy, reportsPrivate }`.
   Единственное обращение к KV — `get("ingest:v1:policy")`; **записей нет**, индекс и снимок не
   читаются. Этим пользуются `doctor` и начало каждого `push`.
5. Нет `Content-Length` → **411**; меньше `minBodyBytes` → **400**; больше `bodyBytes` → **413**.
   (Chunked-тело без `Content-Length` размерный барьер не обходит — проверено.)
6. `get("ingest:v1:index")` — только проверка: машины нет в индексе и индекс полон → **409**.
   Отсутствующий или нечитаемый индекс = пустой.
7. `getWithMetadata(key, { type: "stream" })` + немедленный `cancel()`: прошлый push моложе
   `minPushIntervalSeconds` или исчерпан `pushesPerDay` → **429** с `Retry-After`.
8. `arrayBuffer()`; `byteLength` в пределах; первый значимый байт `{`, последний `}` (O(1), без
   разбора) — иначе **400**.
9. `KV.put(key, body, { metadata: { receivedAt, bytes, pushesToday, collectorVersion, tk },
   expirationTtl })`, где `tk` — первые 8 hex SHA-256 от текущего `INGEST_TOKEN`.
   **Только после успешного put** — дописать `machineId` в индекс, если его там нет.
10. **200** `{ receivedAt, bytes, supported, privacy, reportsPrivate }`. Успех push collector
    определяет по наличию `receivedAt`; ответ с `probe: true` на непустой снимок — ошибка.

Шаги 6–9 — в одном try/catch: любой сбой KV → **503** + `Retry-After` + `X-Ingest: 1`. 429 —
только от собственного ограничителя.

`ingest:v1:policy` = `{ repo, reportsPrivate, checkedAt }`. Обработчик отдаёт `reportsPrivate: false`,
если ключа нет или `repo !== env.REPORTS_REPO`. Пишут ключ прогон (только при заданном токене) и
роуты владельца. `true` — при `visibility === "private"` (или `private === true`, если поля
`visibility` нет). `false` пишется **только при определённом ответе** GitHub; при ошибке lookup
(сеть, 5xx, rate-limit) прогон текст отбрасывает, но ключ не трогает — иначе один сбой в пятницу
стоил бы двух отчётов без текста.

Ограничитель частоты и лимит машин — **рекомендательные**: проверки не атомарны, KV
eventual-consistent, чтения кешируются до ~60 с. Они останавливают зациклившийся collector, а не
целеустремлённого владельца утёкшего токена. В `SECURITY.md` бюджет записей не обещаем.

Жизненный цикл индекса: прогон удаляет из индекса запись, чьего ключа снимка уже нет (TTL истёк),
и снимки, чей `tk` не совпадает с текущим токеном, — **ротация токена обесценивает всё,
присланное старым**; настоящие машины заново пришлют окно в течение часа.

Роуты владельца (под `RUN_SECRET`, токену с машины недоступны; появляются в I1):

| Роут | Назначение |
|---|---|
| `GET /ingest` | Индекс машин + метаданные снимков (без значений) |
| `GET /ingest/preview[?date=][&github=1]` | «Сухой» выбор против текущего state: по каждой машине — валиден / отклонён (код причины), выбрано, опоздавших, отложено, сгорело, отброшено как дубль. По умолчанию **без обращения к GitHub**: колонка «отброшено как GitHub» считает только `gh:`-записи ledger и помечена «неполно»; с `github=1` выполняется только выборка коммитов. Текста не возвращает. Побочный эффект один — обновление `ingest:v1:policy` |
| `DELETE /ingest/v1/<machineId>` | Убрать машину: ключ + запись в индексе |

## Выбор событий

Какие события попадают в неделю, как устроен ledger, инварианты и таблица сценариев —
в [07-selection.md](07-selection.md). Коротко: чистая функция от (state, снимки, GitHub-коммиты,
since, until); дедуп по SHA и по `K` в пределах репозитория; учтённое записывается в ledger внутри
append-only state — поэтому откат state откатывает и его; лимит на прогон — старые первыми,
несгоревшее откладывается, сгоревшее считается.

## Слияние

- Каждый локальный репозиторий → `RepoActivity`: `fullName = "local/<id>"`, `isPrivate: true`,
  `local: true` (неидентифицирующий флаг, переживает редактирование), `url: ""`,
  `ciSuccess/ciFailure/deployments: 0`, `language: null`.
- `displayName`: `<name>` при `share: "text"` (при совпадении имён — `<name>~<id4>`), иначе
  `local/<id>`. Имя, не прошедшее регулярку или похожее на секрет (`findSecret`), заменяется на
  `local/<id>` + счётчик — иначе fail-closed LLM-guard уронил бы **весь** прогон.
- Репо в режиме `counters` получает `redacted: true` и **свою** пометку в отчёте («только
  счётчики»), а не «приватный репозиторий: детали скрыты».
- Имя для `id` берётся из любой `text`-копии (при споре — меньший `machineId`).
- При включённой фиче общий список сортируется по дате последнего коммита (аналог нынешнего
  порядка GitHub «по pushed»), при равенстве — по `fullName`: нумерация `private-project-N`
  детерминирована, главный проект недели не оказывается последним.
- `headline` и `name` проходят скраббинг, обрезку и нейтрализацию markdown/HTML до `report.ts`;
  `message` — только скраббинг и обрезку (в отчёт он не выводится).
- Текст локальных репо **и заголовки сессий** отбрасываются (как при `redact`), если приватность
  reports-репозитория не подтверждена в этом прогоне — даже при `PRIVATE_REPOS=full`.
- `title` сессии — скраббинг, обрезка, нейтрализация markdown; при срабатывании `findSecret`
  заменяется на «—» + счётчик. Ключ проекта `gh:<хеш>` сопоставляется с хешами `/user/repos`;
  нет в списке → приватный.

`WeekActivity.local` = `{ commits, late, deferred, expired, unknownKeys, namesReplaced,
machines: { seen, stale, rejected } }`. Им владеет `applyPrivacy`:

| | `full` | `redact` | `skip` |
|---|---|---|---|
| Локальные репозитории | как есть | `private-project-N`, счётчики | удалены, итоги пересчитаны |
| `week.local` (числа) | есть | есть | **обнулены**; остаётся только строка здоровья машин |
| Ключи `localCommits`/`lateCommits` в LLM-payload | есть | есть | нет |
| `off-grid` (I2) | по `week.local.commits` после приватности | то же | не срабатывает |
| Ledger | продвигается | продвигается | продвигается (смена `skip → redact` backfill не даёт) |
| I3: время в паре с ИИ, общая сумма | есть | есть | есть |
| I3: разбивка по проектам | есть | `private-project-N` | только проекты, не помеченные приватными |
| I3: заголовки сессий / `sessionTitles` | есть (при подтверждённой приватности) | нет | нет |

## Как выглядит отчёт

`full` + `share: "text"`:

```
| Проект            | Коммиты | + строк | − строк | Язык |
| my-forge-project  |      40 |  12 000 |     500 | —    |
…
_Локальные источники: 40 коммитов · опоздавших 0 · отложено 0 · сгорело 0 ·
машины: 1 на связи, 0 молчат > 48 ч, 0 отклонены._
```

`full` + `share: "counters"`: строка `local/3f9a1c20b7e4` и под заголовком проекта —
«_Только счётчики: collector не передал текст (share: counters)._»

`redact`: строка `private-project-2`, обычная пометка о скрытых деталях, та же сноска.

В первую локальную неделю в столбце дельт — «—» и одна строка «подключены локальные источники».
LLM получает `localCommits` и `lateCommits` и одну фразу в промпте — чтобы не хвалить за всплеск,
который на деле приехавшая с опозданием прошлая неделя.

Карта изменений по файлам и список устаревающих мест в документации — в [06-change-map.md](06-change-map.md).
