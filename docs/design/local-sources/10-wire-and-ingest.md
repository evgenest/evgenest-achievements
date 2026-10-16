# 10. Формат передачи и приём снимка

> **Для кого:** тот, кто пишет `src/ingest/wire.ts`, `guard.ts`, `handler.ts` и сборку снимка в collector'е (I1).
> **Что здесь решает владелец:** ничего. Вопросы — только в [общем README](../README.md).
> **Что просто к сведению:** всё — схема снимка версии 1, лимиты, чего в передаваемых данных нет ни в одном режиме,
> порядок проверок при приёме.

Общая картина, проверочный запрос и список учтённого — в [01-architecture.md](01-architecture.md); выбор событий — в
[07-selection.md](07-selection.md); что может держатель токена — в [08-threat-model.md](08-threat-model.md).

## Формат передачи (wire-схема v1)

Схема замораживается в конце I1 — когда collector реально отработал на ней; поле `claim` лежит в ней заранее (до I5
Worker его не читает), чтобы позже не понадобился `/ingest/v2`.

```ts
// src/ingest/wire.ts
export const WIRE_SCHEMA = 1 as const;
export const WINDOW_DAYS = 35;   // только потолок (28 дней окна Worker'а + 7); нижнюю границу задаёт список учтённого
export const LIMITS = {
  bodyBytes: 2 * 1024 * 1024, minBodyBytes: 64,
  machines: 5, reposPerSnapshot: 200, commitsPerSnapshot: 2000, promptsPerSnapshot: 5000,
  nameChars: 100, headlineChars: 200, messageChars: 1000, titleChars: 120,
  commitsPerRunPerWeek: 300,     // × max(1, round((until − since) / 7 д)) — как в 07
  ttlSeconds: 9 * 24 * 60 * 60,  // было 45 дней; MAX_WINDOW_DAYS удалён вместе с push --window-days
  minPushIntervalSeconds: 10,
  pushesPerDay: 96,              // 5 машин × 96 = 480 < 1000 записей KV в сутки на Free
} as const;
export type IsoInstant = string;               // ровно Date#toISOString(), всегда UTC
export type ShareMode = "counters" | "text";   // режим off в передаваемые данные не попадает вовсе

export interface WireCommit {
  sha: string;                 // 40 или 64 hex — точная идентичность
  authoredAt: IsoInstant;      // → CommitInfo.authoredDate; единственная дата для окна и отсева дублей
  committedAt: IsoInstant;     // → CommitInfo.date
  additions: number; deletions: number;    // СЫРЫЕ числа: ключ K считается только по ним
  imported?: [add: number, del: number];   // из них — строки загруженных документов (03a: collector смотрит расширения файлов)
  headline?: string;           // только share = "text"; секреты вырезаются, текст обрезается — на машине и снова на Worker'е
  message?: string;            // коммит БЕЗ текста в репозитории "text" законен: так едет частичное совпадение со списком
}
export type WireClaim =                  // РЕЗЕРВ: до I5 Worker принимает и не читает
  | { forge: "github"; key: string }     // "gh:<12 hex sha256(owner/name строчными)>" — имя не уходит
  | { forge: "forgejo" | "gitlab"; host: string; path: string };   // только если хост назван в publicHosts (I6)
export interface WireRepo {
  id: string;                  // 12 hex: sha256(наименьший корневой SHA + "\n" + нормализованный host/path remote); путь на диске не входит
  share: ShareMode;
  name: string | null;         // "text": /^[A-Za-z0-9][A-Za-z0-9._-]*$/, ≤ nameChars; "counters": null
  claim?: WireClaim;           // заявка «это публично»; только у репозиториев в режиме text
  commits: WireCommit[];       // без merge, только свои e-mail'ы, без границы неполного клона, без дат из будущего;
}                              //   сверх commitsPerSnapshot отбрасываются СТАРЕЙШИЕ (commitsTruncated), push не падает
export interface WireSession {           // читается Worker'ом с I3; до I3 принимается и не читается
  prompts: IsoInstant[];       // метки ЧЕЛОВЕЧЕСКИХ промптов, округлённые до минуты
  repo: string;                // WireRepo.id | "gh:<12 hex sha256(owner/name)>"; сессия из репозитория off или вне репозитория не уходит вовсе
  title?: string;              // aiTitle, ≤ titleChars: репозиторий text + Worker разрешил текст + есть промпт не раньше titlesSince
}
export const DIAGNOSTIC_KEYS = [         // закрытый список; последний пересмотр — перед заморозкой формата
  "reposScanned", "reposSkippedGithub", "reposSkippedHost", "reposSkippedNoRemote", "reposSkippedPartialClone",
  "reposFailed", "reposUndecided", "reposShallowId", "dirsUnreadable", "commitsFutureDated", "commitsShallow",
  "commitsTruncated", "commitsOmittedAccounted", "commitsTextWithheld", "commitsBelowFloor", "textDropped",
  "textDowngraded", "sessionFilesRead", "sessionFilesNoOrigin", "sessionLinesSkipped", "promptsSkippedScope",
  "titlesOmitted",
] as const;
export interface IngestSnapshot {
  schema: typeof WIRE_SCHEMA;
  machineId: string;           // /^m-[0-9a-f]{8}$/, случайный; обязан совпасть с сегментом URL
  collectorVersion: string;    // /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/
  generatedAt: IsoInstant;
  windowStart: IsoInstant;     // max(начало UTC-дня «сейчас − 35 д», from из списка учтённого)
  repos: WireRepo[];           // id уникальны внутри снимка — клоны collector сливает сам
  sessions?: { tool: "claude-code"; sessions: WireSession[] };
  diagnostics: Partial<Record<(typeof DIAGNOSTIC_KEYS)[number], number>>;
}
```

Чего в передаваемых данных **нет ни в одном режиме**: абсолютных путей, `cwd`, сетевого имени машины, имени пользователя ОС,
e-mail'ов, имён веток, адресов remote'ов, имён файлов, диффов, id сессий, текста промптов и ответов. Исключение одно и
позднее: заявка `claim` для других хостингов (I6) несёт путь репозитория — на свой Worker и только если Worker сам
назвал этот хост в `publicHosts`. `sha` и `id` — **псевдонимы, а не анонимность**: публичный коммит находится поиском
по SHA. Любое изменение формы — это `/ingest/v2` рядом с `v1`: Worker берёт у машины ключ старшей поддерживаемой
схемы, collector на 404 от `v2` откатывается на `v1`.

## Приём снимка

`PUT /ingest/v1/<machineId>` с заголовками `Authorization: Bearer <ingest-token>`, `X-Collector-Version`,
`X-Accounted-Through`; тело не разбирается никогда, проверки идут по порядку.

| # | Проверка | Ответ |
|---|---|---|
| 1 | `INGEST_TOKEN` не задан; или задан, но равен `RUN_SECRET` (ошибка конфигурации — в лог) | **404** |
| 2 | Токен не совпал (хеш + сравнение за постоянное время, как `keyMatches`, `src/index.ts:7-14`). `RUN_SECRET` здесь не принимается; `INGEST_TOKEN` не принимается на остальных маршрутах | **403** |
| 3 | `machineId` не проходит регулярное выражение; `X-Accounted-Through` не пуст и не похож на `state:<ISO с миллисекундами>Z` (пустой или отсутствует — `null`) | **400** |
| 4 | Нет `Content-Length` / меньше `minBodyBytes` / больше `bodyBytes`. Тело кусками без `Content-Length` барьер не обходит — проверено | **411** / **400** / **413** |
| 5 | `get("ingest:v1:index")` — только проверка: машины нет в индексе и индекс полон. Нет индекса = пустой | **409** |
| 6 | `getWithMetadata(key, { type: "stream" })` + немедленный `cancel()`: прошлый push моложе `minPushIntervalSeconds` или исчерпан `pushesPerDay` | **429** + `Retry-After` |
| 7 | `arrayBuffer()`; `byteLength` в пределах; первый значимый байт `{`, последний `}` | иначе **400** |
| 8 | `KV.put(key, body, { metadata: { receivedAt, bytes, pushesToday, collectorVersion, tk, through }, expirationTtl })` — 9 суток; `tk` — первые 8 hex SHA-256 от текущего `INGEST_TOKEN`. **Только после успешной записи** — дописать `machineId` в индекс. Чужие снимки Worker не переписывает | — |
| 9 | Успех; collector узнаёт его по наличию `receivedAt` | **200** `{ receivedAt, bytes, supported }` |

Каждый ответ Worker'а после авторизации и отказ 403 несут `X-Ingest: 1` — так collector отличает отказ Worker'а от
403/503 защиты зоны Cloudflare на своём домене; 404 выключенной функции заголовка не несёт. Шаги 5–8 — в одном
try/catch: любой сбой KV → **503** + `Retry-After`. Ограничитель частоты и лимит машин — **рекомендательные**:
проверки не атомарны, чтения KV кешируются до ~60 с; они останавливают зациклившийся collector, а не владельца
утёкшего токена. Прогон удаляет из индекса запись, чьего снимка уже нет, и снимки с чужим `tk` — **ротация токена
обесценивает всё, присланное старым**. *Принятое допущение:* сырые `privacy` и `reportsPrivate` убраны и из ответа 200.

Проверочный запрос `GET` по тому же адресу — в [01-architecture.md](01-architecture.md#проверочный-запрос). Маршруты
владельца под `RUN_SECRET` (`GET /ingest`, `GET /ingest/preview`, `DELETE /ingest/v1/<machineId>`, новые ответы
`DELETE /state/latest` и `/run`) — в [05-operations.md](05-operations.md#маршруты-владельца).
