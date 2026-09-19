# 03. Collector

## Принципы

- TypeScript, документированный runtime — **Bun**. Ядро написано на `node:fs`, `node:child_process`,
  `node:os`, `node:path` + глобальные `fetch`/WebCrypto — без `Bun.*` API (проверяется grep-тестом
  и `types: ["node"]`). Так один код тестируется существующим vitest (он работает под Node) и при
  желании собирается в npm-пакет. Запуск под чистым Node не обещаем: импорты в репо без расширений.
- Ноль runtime-зависимостей. git — через CLI, без libgit. `bun install` для collector'а не нужен.
- Запуск из клона форка: `bun run collector <команда>`. Та же модель доверия, что у деплоя.
  Для расписания — **выделенный клон или worktree на закреплённом коммите** (позже — на теге
  релиза `collector-vX.Y.Z`), а не рабочее дерево разработки: иначе cron каждый час исполняет
  то, что сейчас на WIP-ветке. `collectorVersion` берётся из `collector/version.ts`.
- Каждый файл — одна забота. Два источника — два обычных модуля; общий интерфейс адаптеров
  появится с третьим источником.

## Раскладка

```
collector/
  cli.ts              разбор аргументов, диспетчер команд
  config.ts           config.json, каталог состояния, env-переопределения
  discover.ts         обход корней, поиск репозиториев
  remote.ts           нормализация remote URL → host + path; срезание user:token@
  classify.ts         github | github-foreign | declared | undeclared-host | no-remote | partial-clone | excluded | failed
  git/
    commands.ts       типизированный union разрешённых git-команд → argv
    exec.ts           spawn без shell, окружение из белого списка, таймаут, лимит stdout
    log.ts            вызов git log + строгий разбор NUL-записей и --shortstat
    identity.ts       e-mail'ы пользователя
    repo-id.ts        id репозитория
  sources/
    git-local.ts      локальные репозитории
    claude-code.ts    сессии Claude Code (I3)
  snapshot.ts         сборка IngestSnapshot, скраббинг, деградация по размеру
  transport.ts        единственный файл с fetch
  commands/           scan.ts, push.ts (I1); init.ts, doctor.ts, schedule.ts (I2)
  tsconfig.json       types: ["node"]
  test/               vitest; фикстурные репозитории во временных папках
```

Общий контракт импортируется из `src/ingest/wire.ts`, `src/ingest/guard.ts`, скраббер — из
`src/secrets.ts` (все без `Env`). Grep-гейт: `collector/**` и эти три файла импортируют только
`node:*` и относительные модули без `Env`.

## Команды

| Команда | Итерация | Что делает |
|---|---|---|
| `scan` | I1 | Только чтение. Каждый найденный репозиторий с классом и числом коммитов в окне. `--json` — ровно тот снимок, что отправил бы `push`. `--explain <путь>` — почему коммитов нет: сколько чужих e-mail'ов (только число), сколько вне окна, сколько merge, какой класс |
| `push` | I1 | Probe → собрать → провалидировать общим guard'ом → отправить. `--dry-run` — напечатать байты и ничего не слать. `--force` — отправить, даже если содержимое не изменилось. `--window-days N` — расширение окна для backfill (≤ 120); ширина запоминается в `last-push.json` до `--window-days 0`, иначе ближайший запуск по расписанию вернул бы 35 дней |
| `init` | I2 | Интерактивно: URL Worker'а, токен, корни, таблица «хост + пространство имён» (ничего не отмечено), владельцы GitHub, какие из найденных e-mail'ов — ваши, брать ли репо без remote, `share`. Пишет конфиг, показывает `scan` и сниппет расписания |
| `sessions forget [--all]` | I3 | Очистить кэш меток промптов |
| `doctor` | I2 | **Никогда не пишет** (нет `machine-id` — probe идёт на `m-00000000`, файл не создаётся). Версия git (≥ 2.37; ≥ 2.45 для полной защиты), права на `credentials`, probe-запрос к Worker'у (токен, схема, режим приватности), проблемы по репо (dubious ownership, shallow, partial clone, пустой), `safe.directory=*`, конфиг внутри git-дерева, расхождение часов с заголовком `Date` |
| `schedule` | I2 / I4 | I2: `print` — сниппеты с абсолютными путями. I4: `install \| uninstall \| status` для systemd и cron |

Флаги: `--config <путь>`, `--quiet`, `--verbose` (только счётчики, никогда не контент).

Коды выхода `push`:

| Ответ | Поведение |
|---|---|
| 200, пропуск неизменного | выход 0 |
| 400 / 403 / 409 / 413 | **ненулевой выход и строка в stderr даже при `--quiet`**, без повтора — иначе отключённая машина невидима |
| 429 / 503 / сеть | выход 0, повтор следующим запуском; `last-push.json` не обновляется |
| 403 / 503 без `X-Ingest` | «блокирует защита зоны Cloudflare, а не Worker» |
| 404 | фича выключена или не тот URL (`doctor` различает их запросом `/state` без токена: ожидается 403) |

## Конфиг и состояние

`${XDG_CONFIG_HOME:-~/.config}/achievements-collector/config.json`
(Windows: `%APPDATA%\achievements-collector\config.json`). Обычный JSON; в I1 пишется руками по
примеру. Ключи будущих итераций (`githubOwners` — I2; `sessions`, `sessionsScope` — I3) до своей
итерации игнорируются:

```json
{
  "endpoint": "https://<worker-name>.<account-subdomain>.workers.dev",
  "roots": ["~"],
  "exclude": ["~/<папка-клиента>"],
  "include": [],
  "maxDepth": 6,
  "emails": ["<вы>@<домен>", "<id>+<login>@users.noreply.github.com"],
  "githubOwners": ["<github-login>"],
  "hosts": {
    "<forge-host>": { "share": "text" },
    "<saas-forge-host>/<личное-пространство>": {}
  },
  "includeNoRemote": true,
  "notBefore": null,
  "share": "counters",
  "sessions": "off",
  "sessionsScope": "collected"
}
```

Каталог состояния `${XDG_STATE_HOME:-~/.local/state}/achievements-collector/`
(Windows: `%LOCALAPPDATA%`) — **не синхронизировать**:

| Файл | Зачем |
|---|---|
| `machine-id` | `m-<8 hex>`, создаётся при первом push |
| `credentials` (0600) | ingest-токен; альтернатива — `ACHIEVEMENTS_INGEST_TOKEN` |
| `last-push.json` | хеш содержимого (только `repos` + `sessions`), время, последний ответ Worker'а (`privacy`, `reportsPrivate`, `supported`) |
| `prompt-cache.json` | I3: уже увиденные минутные метки промптов |

Каталог создаётся с правами 0700, файлы — 0600 (`doctor` проверяет). Выбрасываемый кэш здесь —
только `last-push.json`; удаление `prompt-cache.json` теряет ещё не учтённые минуты уже удалённых
сессий. `push`
пропускает отправку, если хеш содержимого не изменился и прошлый push моложе 24 ч
(`windowStart` выровнен по UTC-дню, поэтому у простаивающей машины содержимое меняется не чаще
раза в сутки).

## Поиск репозиториев

- Обход `readdir({ withFileTypes })`, симлинки не раскрываются, глубина ≤ `maxDepth`.
- Репозиторий — это `.git` **папка или файл** (worktree, submodule); найдя, внутрь не спускаемся.
  Bare — по `HEAD` + `objects` + `refs`.
- Отсечение по имени: `node_modules`, `vendor`, `target`, `dist`, `build`, `.venv`, `venv`,
  `__pycache__`, `Library`, `AppData`, `snap`, `go/pkg`, `$RECYCLE.BIN`, `System Volume Information`
  и **все dot-папки**, кроме явно заданных корней.
- `EACCES`/`EPERM`/`ENOENT` — в счётчик, не в ошибку.
- Связанные worktree схлопываются по `git rev-parse --path-format=absolute --git-common-dir`
  (без `--path-format` git возвращает относительный `.git`, и `realpath` разрешит его не от того
  каталога); их HEAD'ы добавляются в список ревизий (`git worktree list --porcelain`).
- Клоны с одинаковым `id` collector сливает в один `WireRepo` сам. `scan` и `doctor` печатают
  `id` — чтобы сравнить машины: один репозиторий с разными `id` (разные формы remote, ssh-алиас
  из `~/.ssh/config`, который git не раскрывает) склеивается по SHA, но не по `K`.
- Кэш не нужен: замер — ~0.25 с на домашнюю папку, 34 репозитория.

## Вызовы git

Разрешённый набор (union в `commands.ts` — запрещённую команду нельзя выразить):
`rev-parse`, `rev-list --max-parents=0`, `remote get-url --all [--push]`, `config --get[-regexp]`
(только чтение), `worktree list --porcelain`, `log -z --shortstat`. Никаких `fetch`/`pull`,
`-p`, `--numstat`, сетевых команд.

```
git -C <repo> --no-pager
    -c core.quotePath=false -c log.showSignature=false -c color.ui=false
    -c log.mailmap=false -c core.fsmonitor=false -c core.bigFileThreshold=<большое>
  log -z HEAD --branches --remotes [<HEAD'ы worktree>] --no-merges -M
    --diff-algorithm=myers --shortstat --no-ext-diff --no-textconv --no-color
    --since-as-filter=<windowStart> --author=<email> [--author=…]
    --format=%H%x00%P%x00%at%x00%ct%x00%ae[%x00%s%x00%b]
```

- **Разделители — только NUL.** git отвергает NUL в сообщении коммита, а `%ae`/`%b` на нём
  обрезаются — подделать запись нельзя. Раскладка при `-z`: NUL завершает формат, а блок
  `\n <shortstat>\n` коммита N стоит **в начале токена с `%H` коммита N+1**. Разбор строгий:
  точное число полей, SHA — 40/64 hex, **не более одной** строки shortstat по жёсткой регулярке
  (её отсутствие = пустой коммит, 0/0 — `git commit --allow-empty` обычен для CI-триггеров);
  e-mail перепроверяется в JS **точным**
  сравнением без учёта регистра, с отказом при управляющих символах (`--author` в git — поиск
  подстроки, а несколько `--author` объединяются по ИЛИ).
- **`--since-as-filter`** (git ≥ 2.37), а не `--since`: обычный `--since` останавливает обход на
  первом коммите старше порога по дате коммиттера и теряет лежащие под ним коммиты окна. На старом
  git — без фильтра по дате, с `--max-count`. Окно по **дате автора** выбирается в JS — как шкала
  часов в `src/hours.ts`, и это переживает rebase.
- **`--diff-algorithm=myers` флагом**, а не `-c diff.algorithm`: конфиг задаёт лишь запасной
  алгоритм, драйвер из `.gitattributes` его перекрывает. Атрибуты (`binary`, собственные
  diff-драйверы) всё равно могут менять статистику между клонами — известное ограничение `K`;
  точный SHA-дедуп от этого не зависит.
- Никогда `--all`: проверено, что он вытаскивает внутренности stash.
- Даты — из `%at`/`%ct` (epoch); в UTC переводит collector. В режиме `counters` в формате **нет**
  `%s`/`%b` — тест проверяет argv.
- Окружение строится с нуля: `PATH`, `HOME`/`USERPROFILE`, `SystemRoot`, `LC_ALL=C`, пустой
  `LANGUAGE`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_PAGER=cat`,
  **`GIT_NO_LAZY_FETCH=1`**; stdin закрыт; таймаут 30 с.
- Репозитории с `extensions.partialClone` или `remote.*.promisor` пропускаются целиком (счётчик).
- Пустой репозиторий: предварительно `rev-parse -q --verify HEAD`. Коммиты shallow-границы **не
  отправляются** (их статистика неизвестна и могла бы победить настоящую копию с другой машины).
  Коммиты с датой автора дальше +24 ч от текущего времени не отправляются (счётчик). Сверх
  `commitsPerSnapshot` отбрасываются старейшие (`commitsTruncated`) — push не падает. Сбой
  одного репо — счётчик, не падение.
- Фикстуры I1: пустой коммит, только-переименование, только-смена-режима и корневой коммит в
  одном репозитории; тело и e-mail с управляющими байтами; враждебный конфиг; `LANGUAGE=ru`.
- Если `LC_ALL=C --shortstat` окажется нестабильным на Git for Windows / Apple git — запасной
  вариант `--numstat -z` (пути остаются в памяти collector'а и не отправляются).

**`id` репозитория**: `sha256(наименьший корневой SHA по `HEAD --branches --remotes` + "\n" +
нормализованный `host/path` первого объявленного remote, либо пусто)`, первые 12 hex. Корень
считается по всем веткам, а не от `HEAD` — иначе клон с выбранной orphan-веткой получит другой id.
Shallow-клон: корня нет → id только из пути remote + счётчик. Форки и проекты из одного шаблона с
общей историей различаются путём remote; без remote — делят id (известное ограничение).

## E-mail'ы автора

Объединение `git config --global user.email`, локальных `user.email` **собираемых** репозиториев и
`emails[]`. `init` показывает самые частые e-mail'ы авторов по найденным репозиториям со
счётчиками — пользователь отмечает свои. Чужие коммиты не отправляются никогда.

## Расписание

Push идемпотентен, поэтому запускать его нужно **часто** (раз в час): гонка с cron Worker'а и
eventual consistency KV перестают иметь значение, а неизменившееся содержимое не отправляется.

- **I1** — одна строка cron в README:
  `17 * * * * <abs-bun> run <abs-clone>/collector/cli.ts push --quiet`
  (в cron `PATH` обычно не содержит `~/.bun/bin` — пути абсолютные).
- **I2** — `schedule print`: systemd user timer (`OnCalendar=hourly`, `Persistent=true`,
  `RandomizedDelaySec=300`; на VPS — `loginctl enable-linger <user>`), crontab, launchd plist,
  Task Scheduler XML (`StartWhenAvailable`). Последние два помечены «проверено сообществом».
- **I4** — `schedule install | uninstall | status` для systemd и cron.
- Известное: cron/launchd на macOS не читают TCC-защищённые папки (`Documents`, `Desktop`).
  WSL и Windows-установка — две разные машины. `/mnt/c` из WSL автоматически не сканируется.

## Путь нового пользователя (после I2)

1. Обновить форк, задеплоить Worker.
2. Создать токен — команда в [05](05-operations.md#токен-создание-и-ротация): значение секрета из
   Cloudflare прочитать нельзя, поэтому оно сначала сохраняется локально. Фича включается сразу.
3. На рабочей машине: клон форка на закреплённом коммите (`bun install` не нужен).
4. `bun run collector init`.
5. `bun run collector push --dry-run` → посмотреть, что уйдёт → `bun run collector push`.
6. Вставить напечатанный сниппет расписания.
7. Хотите названия и сводки вместо `private-project-N` — это отдельное решение с ценой:
   [02](02-privacy-security.md#текст-уходит-только-после-подтверждения).

## Сессии Claude Code (I3, opt-in)

Уровни: `"off"` (по умолчанию) · `"time"` · `"projects"` · `"titles"`.

- **Где искать.** Официально — один каталог `CLAUDE_CONFIG_DIR`, иначе `~/.claude`; внутри
  `projects/<slug>/<sessionId>.jsonl`. Дополнительно, для совместимости с привычками ccusage
  (это не официальное поведение): список через запятую и `$XDG_CONFIG_HOME/claude`.
  Slug не «разворачивается» обратно в путь (и может быть переопределён переменной окружения).
- **Файлы.** Только `^[0-9a-f-]{36}\.jsonl$` верхнего уровня; `.orphaned-*`/`.superseded-*` и
  подпапки (`subagents/`, `tool-results/`) не читаются. Предфильтр по mtime.
- **Поля.** Построчно, `JSON.parse` в try/catch; из записи берутся только `type`, `timestamp`,
  `uuid`, `isSidechain`, `origin.kind`, `promptSource`, `entrypoint`, `cwd` (только в памяти),
  на уровне `titles` — `aiTitle`.
- **Человеческий промпт** = `type: "user"`, `origin.kind === "human"`, без `toolUseResult`,
  `promptSource` ∈ {typed, suggestion_accepted}; `queued` и `system` интервал не открывают.
  `origin` надёжен **там, где есть**: примерно в 15% файлов, включая свежие версии CLI, его нет
  вовсе — такие файлы пропускаются и считаются (метрика занижает, но не угадывает).
  `entrypoint: "sdk-cli"` исключается. Дедуп по `uuid` через все файлы (копии от `/branch` и
  `--fork-session`).
- **Область.** `cwd` → корень репозитория (`rev-parse --show-toplevel`) → `classify.ts`.
  `"collected"` = собираемые локальные репозитории + GitHub-репозитории из `githubOwners`, не из
  `exclude`; `cwd` вне любого репозитория отбрасывается. При `"all"` — всё, вне репозитория с
  `repo: null`.
- **Кэш.** Каждый push — свежий полный скан, а транскрипты живут 30 дней и удаляются чисткой
  сессий. Поэтому collector хранит уже увиденные минутные метки и ключ проекта в
  `prompt-cache.json`, обрезает по окну и объединяет со сканом. **Заголовки не кэшируются:**
  удалил сессию — её заголовок перестаёт отправляться со следующего push.
- **На провод.** Метки, округлённые до минуты; на `projects` — ключ проекта
  (`WireRepo.id` | `gh:<хеш owner/name>` | `null`); на `titles` — заголовок после скраббинга,
  только для сессий в репозиториях с `share: "text"` и только после подтверждения приватности.

Метрика считается на Worker'е (одно определение на все версии collector'а):

```
selectSessions(L, snapshots, since, until):
  P        := промпты всех машин, from ≤ t < until
  интервалы := соседние промпты с паузой ≤ 15 мин — один интервал [первый, последний + 5 мин];
               объединение по всем машинам (параллельные сессии не складываются)
  новые    := интервалы \ L.covered
  минуты   := |новые|;  next.covered := prune(L.covered ∪ новые, ≥ from)
```

В отчёт: отдельная строка «время в паре с ИИ», на `projects` — разбивка по проектам (те же
`private-project-N` при `redact`) и «из них N ч в сессиях без коммитов (±30 мин)»; на `titles` —
раздел «Сессии без коммитов» с заголовком и длительностью. В LLM-payload — `aiPairingMinutes`,
`aiSessions`, `aiPrompts` (+ `sessionTitles` на `titles` — только при `full` и подтверждённой
приватности). **Не** идёт в `hours.ts`, зарплатную оценку, `isActiveWeek`, streak. Поведение по
режимам приватности — в таблице [01](01-architecture.md#слияние).

Не проверено, нужны образцы при реализации: как выглядит `/compact` в текущих версиях; сохраняют
ли копии при fork исходные `uuid`; поля в версиях CLI старше встреченных локально. Фикстуры в
публичном репо — только синтетические.
