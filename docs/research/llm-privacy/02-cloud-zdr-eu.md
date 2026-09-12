# Облачная LLM с zero data retention и обработкой в EU

Дата проверки: 2026-09-12 (по официальной документации и публичным API каталогов моделей — ссылки внизу).
Цены и списки моделей меняются: перед реализацией перепроверить.

## Термины

- **ZDR (zero data retention)** — провайдер модели не хранит промпт и ответ после запроса (а значит, и не обучается на них).
  Отвечает на вопрос «хранят ли», но не «где обрабатывают».
- **Регион / in-region routing** — где провайдер выполняет инференс (и хранит, если хранит). Отвечает на «где», но не «хранят ли».
- **No training** — провайдер может хранить (напр. для abuse-мониторинга), но не обучается. Слабее ZDR.
- Для нашей цели нужны **оба**: ZDR + EU.

## Сравнение маршрутов

| | OpenRouter Standard | OpenRouter Business | Vercel AI Gateway Hobby (free) | Vercel AI Gateway Pro |
|---|---|---|---|---|
| ZDR (принудительно) | да, всем: `provider.zdr: true` или в настройках аккаунта | да | **нет** — только Pro/Enterprise | да, per-request бесплатно; team-wide $0.10 / 1000 запросов |
| Хранит ли сам шлюз промпты | нет (если не включён prompt logging) | нет | нет | нет |
| Запрет обучения | `provider.data_collection: "deny"` | да | да, всем бесплатно: `disallowPromptTraining: true` | да |
| EU-обработка | нет (можно только вручную ограничить провайдеров через `only`, без гарантии) | **да**: `eu.openrouter.ai`, fail-closed | да: `inferenceRegion: { scope: 'zone', geoRegion: 'eu' }`, fail-closed; ограничений по тарифу в доке нет | да |
| Что не покрыто регионом | — | часть неpromptовых данных аккаунта остаётся в US; `openrouter/auto` и внешний web search недоступны | шлюз может принять запрос (TLS) в любом регионе Vercel, пинится только провайдер | то же |
| Стоимость | 5.5% комиссия на покупку кредитов | 8% комиссия на покупку кредитов, без абонплаты и контракта | $5/мес бесплатного кредита, **только на free-tier модели**; после первой покупки кредитов бесплатный кредит перестаёт начисляться | $20/мес за место (включает $20 кредита на использование платформы) + токены |
| Цены токенов | по прайсу провайдера | то же | по прайсу провайдера; EU обычно ~+10% | то же |

Проверка резидентности:
- Vercel: в метаданных ответа `inferenceEndpoint.geoRegion` у успешной попытки провайдера; при ZDR — `gateway.routing.planningReasoning`.
- OpenRouter: регион задаётся доменом; при отсутствии in-region провайдера запрос падает, а не уходит наружу.

## Проверка предпосылок (что оказалось не так, как предполагалось)

- **«У OpenRouter недавно появился EU-роутинг»** — да, но только на тарифе **Business** (self-serve апгрейд, комиссия 8% вместо 5.5%) или Enterprise. На обычном аккаунте его нет.
- **«На бесплатные $5 у Vercel можно брать платные модели»** — частично: только модели с флагом free tier. Из текущих: Nemotron 3 Ultra — да, `gpt-5.6-luna` — нет.
  Покупка любых кредитов переводит команду на paid tier, и бесплатные $5 больше не начисляются.
- **ZDR у Vercel на free tier** — нельзя. Сам шлюз ничего не хранит, но принудительный ZDR у провайдера — только Pro/Enterprise. На Hobby доступен только `disallowPromptTraining`.
- **Nemotron 3 Ultra + EU** — нигде: у Vercel у модели только регион `us`, у OpenRouter ZDR-эндпоинты Nemotron (BaseTen, DeepInfra, Venice) без EU-меток.

## Модели-кандидаты с EU + ZDR

Цены за 1M токенов (вход / выход), для EU-эндпоинта.
Оценка одного прогона: ~10k входа + ~5k выхода (с reasoning) — оценка, не замер.

### OpenRouter (EU-эндпоинты с ZDR, тариф Business)

| Модель | Провайдер / эндпоинт | Цена | ~$ за прогон |
|---|---|---|---|
| `openai/gpt-5.6-luna` (текущая) | Azure EU | $0.22 / $1.32 | ~0.01 |
| `openai/gpt-oss-120b` | Bedrock eu-west-1 | $0.15 / $0.60 | ~0.005 |
| `mistralai/mistral-large-2512` | Mistral EU | $0.55 / $1.65 | ~0.015 |
| `mistralai/mistral-medium-3-5` | Mistral EU | $1.65 / $8.25 | ~0.06 |
| `z-ai/glm-5.2` | Mistral EU | $1.54 / $4.84 | ~0.04 |
| `google/gemini-2.5-pro` | Vertex EU | $1.25 / $10 | ~0.06 |
| `anthropic/claude-sonnet-5` | Bedrock eu-west-1 / Vertex europe | $2.20 / $11 | ~0.08 |

Полный актуальный список ZDR-эндпоинтов с регионом в поле `tag`: `https://openrouter.ai/api/v1/endpoints/zdr`.

### Vercel AI Gateway (модели с EU-регионом)

EU-регион есть у 23 языковых моделей: Amazon Nova, Anthropic Claude, Google Gemini.
Из них на **free tier** доступны только: `amazon/nova-micro`, `nova-lite`, `nova-pro`, `nova-2-lite`, `google/gemini-2.5-flash`, `google/gemini-2.5-flash-lite`.
OpenAI (включая `gpt-5.6-luna`), Mistral и Nemotron в EU-регионе у Vercel сейчас нет.

| Модель | Free tier | EU-цена | ~$ за прогон |
|---|---|---|---|
| `google/gemini-2.5-flash` | да | $0.30 / $2.50 | ~0.016 |
| `amazon/nova-pro` | да | $1.05 / $4.20 | ~0.03 |
| `anthropic/claude-sonnet-5` | нет | $2.20 / $11 | ~0.08 |

Актуальные данные: `https://ai-gateway.vercel.sh/v1/models` (поля `zdr`, `no_training`, `pricing.regional`).

### Вывод по деньгам

Даже самый дорогой кандидат — порядка $0.3–0.8 в месяц (4–10 прогонов с учётом повторов для сравнений).
Бесплатные $5 у Vercel здесь не решающий фактор: ограничение free tier — это список моделей, а не сумма.

## Итог

- **Строго EU + ZDR** реально только через **OpenRouter Business**. Плюс: доступна текущая `gpt-5.6-luna` (через Azure EU) и Mistral. Минус: комиссия 8% на пополнение (при таких суммах — центы).
- **Vercel Hobby** даёт EU-регион + запрет обучения, но не принудительный ZDR; из бесплатных EU-моделей — Gemini 2.5 Flash и Amazon Nova.
- Nemotron 3 Ultra в EU недоступен нигде — если хочется именно его, придётся выбирать между моделью и резидентностью.

## Решение (2026-09-12)

ZDR обязателен, EU желательно. Выбран **OpenRouter** + `nvidia/nemotron-3-ultra-550b-a55b` (US), effort `high`.

- Vercel отпал: ZDR там только на Pro ($20/мес), а оплата кредитов на Hobby ZDR не даёт.
- Аккаунт — личный OpenRouter (Standard), не Business: ZDR передаётся в каждом запросе и от тарифа не зависит,
  Business нужен только для EU-роутинга. Комиссия на пополнение 5.5%.
- ZDR-эндпоинты Nemotron 3 Ultra на OpenRouter: DeepInfra (fp4), BaseTen (fp4), Venice (fp8).
  Strict structured output (`structured_outputs`) — только у DeepInfra, поэтому с `require_parameters: true` запросы фактически идут туда.
- Цена: ~$0.5–0.6 / ~$2.2–2.4 за 1M токенов → ~$0.02 за прогон.

## Реализация

`LLM_PROVIDER=openrouter` → `callOpenRouter` в `src/llm.ts`, пакет `@openrouter/ai-sdk-provider` (v3, peer `ai ^7`):

- настройки модели: `provider: { zdr: true, data_collection: "deny", require_parameters: true }` — захардкожены, переключателя нет;
- reasoning: провайдер **игнорирует** SDK-параметр `reasoning` у `generateText` и читает только свою настройку `reasoning: { effort }` — поэтому effort передаётся через неё (`provider-default` → не передаётся вовсе);
- structured output: `Output.object` → `response_format: json_schema` со `strict: true` (дефолт провайдера);
- при промахе схемы — то же восстановление из сырого текста, что у Vercel (`recoverSchemaMiss`).

## Чеклист максимальной приватности

Цель — максимально близко к локальной модели: облако только считает, данные нигде не остаются и не идут на обучение.

В коде (сделано):
- [x] ZDR на каждом запросе, без фоллбэка на эндпоинты, которые хранят данные.
- [x] `data_collection: "deny"` (избыточно при ZDR, но явно).
- [x] Никаких плагинов OpenRouter (web search, response healing): на плагины ZDR не распространяется.

В личном аккаунте OpenRouter, из которого выпущен ключ (руками, [privacy settings](https://openrouter.ai/settings/privacy)):
- [ ] Prompt logging — выключен (иначе OpenRouter сам хранит промпты).
- [ ] ZDR включён на уровне аккаунта для всех групп моделей (Anthropic, OpenAI, Google, SpaceXAI, non-frontier) — страховка на случай, если ключ когда-то используется без флага в запросе.
- [ ] Обучение на данных — запрещено (paid и free настройки).

Что остаётся за пределами ZDR (принять или закрыть отдельно):
- OpenRouter хранит **метаданные** запроса (модель, токены, стоимость, время) — без текста промпта и ответа.
- Провайдер может обработать и сохранить запрос, помеченный его системой abuse/safety, по своим правилам.
- Логи воркера (Cloudflare Observability, `persist: true`): при ответе, который не парсится как JSON, в лог уходит превью сырого текста (до 300 символов, `describeLlmOutput` в `src/llm.ts`). Это своя инфраструктура, но текст там лежит.
- Результат по построению уходит в репозиторий отчётов (GitHub) и в Telegram.

## Если понадобится EU

- OpenRouter Business: base URL `https://eu.openrouter.ai/api/v1` (параметр `baseURL` в `createOpenRouter`) + модель из EU-списка выше. Nemotron 3 Ultra там нет.
- Fail-closed: без in-region провайдера запрос падает — фоллбэк на глобальный роутинг не добавлять.

Пример REST-запроса OpenRouter (из документации):

```bash
curl https://eu.openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer <OPENROUTER_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-5.6-luna",
    "messages": [{ "role": "user", "content": "..." }],
    "provider": { "zdr": true, "data_collection": "deny" }
  }'
```

## Источники

- OpenRouter: [Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr), [In-Region Routing](https://openrouter.ai/docs/guides/features/in-region-routing), [Business](https://openrouter.ai/business), [Pricing](https://openrouter.ai/pricing), [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- Vercel: [ZDR](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr), [Regional inference](https://vercel.com/docs/ai-gateway/security-and-compliance/regional-inference), [Disallow prompt training](https://vercel.com/docs/ai-gateway/security-and-compliance/disallow-prompt-training), [Pricing](https://vercel.com/docs/ai-gateway/pricing), [Free-tier модели](https://vercel.com/ai-gateway/models?freeTier=true)
- Каталоги (данные для таблиц): `https://ai-gateway.vercel.sh/v1/models`, `https://openrouter.ai/api/v1/endpoints/zdr`
