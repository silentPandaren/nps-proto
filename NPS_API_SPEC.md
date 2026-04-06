# NPS Survey — API Specification

> Контекст: NPS-опрос показывается пользователю после успешной покупки.
> Появляется как bottom sheet поверх экрана успеха при нажатии «Back to Market».

---

## Эндпоинты

### POST `/api/orders/{order_id}/nps/`

Сохранить оценку пользователя.

**Request**

```typescript
type PostOrderNpsRequest = {
  rating: 1 | 2 | 3 | 4 | 5;   // оценка, обязательно
  comment?: string;              // текстовый комментарий, опционально
};
```

**Response `201 Created`**

```typescript
type PostOrderNpsResponse = {
  id: number;
};
```

**Errors**

| Код | Описание |
|-----|----------|
| `400` | Невалидный `rating` (не 1–5) |
| `403` | Заказ не принадлежит текущему пользователю |
| `404` | Заказ не найден |
| `409` | NPS по этому заказу уже был отправлен |

**Side effects** (только для авторизованных пользователей)

Обновить `user_nps_eligibility`:
- `last_submitted_at = NOW()`

> Cooldown уже активирован фактом показа (через `POST /api/users/nps/impression/`).
> Повторно перезаписывать `cooldown_until` при отправке не нужно.

---

### GET `/api/orders/{order_id}/nps/eligibility/`

Проверить, нужно ли показывать NPS для данного заказа.
Вызывается фронтендом при нажатии «Back to Market».

> **Для анонимных пользователей** фронтенд проверяет куку `nps_shown_at` до вызова этого эндпоинта.
> Если кука есть и cooldown не истёк — API не вызывается вообще.

**Response `200 OK`**

```typescript
type GetOrderNpsEligibilityResponse = {
  shouldShow: boolean;
  reason?: NpsIneligibilityReason;
};

type NpsIneligibilityReason =
  | "already_submitted"           // NPS по этому заказу уже отправлен
  | "order_too_old"               // заказ старше 7 дней
  | "ineligible_product"          // заказ не оплачен или бесплатный
  | "order_value_too_low"         // сумма заказа < $1.00
  | "cooldown_active"             // 90-дневный cooldown ещё не истёк (только авторизованные)
  | "insufficient_order_history"; // меньше 2 оплаченных заказов (только авторизованные)
```

---

### POST `/api/users/nps/impression/`

Зафиксировать факт показа NPS bottom sheet авторизованному пользователю.
Фронтенд вызывает fire-and-forget сразу после отрисовки шторки.

**Требует авторизации.** `401` если не авторизован — фронтенд игнорирует.

**Response `204 No Content`**

**Side effects**

Обновить `user_nps_eligibility`:
- `last_shown_at = NOW()`
- `cooldown_until` — зависит от стратегии опроса:
  - `periodic`: `NOW() + INTERVAL '90 days'`
  - `once`: `'9999-12-31 00:00:00+00'`

> **Почему отдельный эндпоинт, а не side effect в GET?**
> GET не должен иметь side effects (REST). Разделение позволяет отличить «проверил» от «показал» для аналитики и A/B тестов.

---

## Бизнес-логика

### Правила для всех пользователей (бэкенд)

| Правило | Значение |
|---------|----------|
| Заказ оплачен | `status = paid` и `isFreeOrder = false` |
| Окно показа | Заказ создан не позднее 7 дней назад |
| Минимальная сумма | Заказ ≥ $1.00 (исключает микротранзакции и тестовые покупки) |
| Один NPS на заказ | Повторная отправка → `409`, eligibility → `already_submitted` |

### Дополнительные правила только для авторизованных (бэкенд)

| Правило | Значение |
|---------|----------|
| Минимум заказов | Не менее 2 оплаченных заказов всего |
| Cooldown | Определяется стратегией опроса (см. ниже) |

> **Cooldown от показа, не от отправки — для всех пользователей.**
> Шторка появилась → `POST /api/users/nps/impression/` срабатывает немедленно → cooldown пошёл.
> Пропустил, заполнил, закрыл — неважно: 90 дней уже считаются.

### Стратегии cooldown

Разные опросы требуют разного поведения. Стратегия задаётся как **константа на бэкенде** при регистрации нового опроса — без изменений схемы БД.

| Стратегия | Значение | Когда использовать |
|-----------|----------|--------------------|
| `periodic` | Показывать раз в N дней (сейчас 90) | Периодический сбор NPS о качестве покупок |
| `once` | Показать один раз, больше никогда | Опрос о конкретной фиче («Как вам новый баннер?») |

**Реализация через `cooldown_until`** — схема БД не меняется:
- `periodic`: `cooldown_until = NOW() + INTERVAL '90 days'` (сбрасывается при следующем показе)
- `once`: `cooldown_until = '9999-12-31'` (выставляется при первом показе, не при отправке)

Текущий опрос после покупки использует стратегию **`periodic`**.

### Правила для анонимных пользователей (фронтенд)

| Правило | Как реализовано |
|---------|-----------------|
| Cooldown 90 дней | Кука `nps_shown_at` (timestamp). Проверяется до вызова eligibility API. |

Анонимы не проходят user-level проверки на бэкенде — бэкенд доверяет факту вызова API
(кука уже проверена на фронте). Cooldown через куку достаточен: если пользователь очистит куку —
это его выбор, идеальная защита здесь не нужна.

---

## Pipeline проверки eligibility

```
[ФРОНТ] При нажатии "Back to Market":
  └─ пользователь анонимный?
       └─ кука nps_shown_at есть и < 90 дней?
            → ДА: не показывать NPS, перейти в магазин
            → НЕТ: вызвать GET eligibility

[БЭКЕНД] GET /api/orders/{order_id}/nps/eligibility/:

  1. ORDER QUERY (один запрос к БД):
     ├─ заказ существует?
     ├─ status = paid, isFreeOrder = false?
     ├─ created_at >= NOW() - 7 days?
     └─ total_usd >= 1.00?
     → любое нет → { shouldShow: false, reason: ... }

  2. DEDUP CHECK (order_nps):
     └─ нет строки WHERE order_id = ?
     → есть → { shouldShow: false, reason: "already_submitted" }

  3. AUTH BRANCH:
     └─ анонимный (userId = null)?
          → { shouldShow: true }

     └─ авторизованный?
          → USER STATE (user_nps_eligibility, O(1) по PK):
            ├─ total_paid_orders >= 2?
            │   → нет → { shouldShow: false, reason: "insufficient_order_history" }
            └─ cooldown_until IS NULL OR cooldown_until < NOW()?
                → нет → { shouldShow: false, reason: "cooldown_active" }
            → { shouldShow: true }

[ФРОНТ] После показа шторки:
  └─ анонимный → SET cookie nps_shown_at=<timestamp>, expires=90 дней
  └─ авторизованный → POST /api/users/nps/impression/ (fire-and-forget)
```

Итого: 2 DB round-trip для анонимов, 3 для авторизованных.

---

## Модель данных

### Существующая таблица `order_nps` (изменения)

```sql
-- Добавить колонку для аналитики (корреляция суммы и рейтинга)
ALTER TABLE order_nps ADD COLUMN order_value_usd NUMERIC(10,2);

-- Удалить избыточные поля:
-- user_id: достаётся через JOIN orders ON orders.id = order_nps.order_id
-- showcase_id: не используется
ALTER TABLE order_nps DROP COLUMN user_id;
ALTER TABLE order_nps DROP COLUMN showcase_id;
```

Полная схема:

```sql
CREATE TABLE order_nps (
  id              SERIAL PRIMARY KEY,
  order_id        INTEGER NOT NULL REFERENCES orders(id),
  rating          SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment         TEXT,
  order_value_usd NUMERIC(10,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX order_nps_unique_order ON order_nps(order_id);
```

> **`user_id` не хранится** — он уже есть на заказе. Отзыв может оставить только автор заказа
> (проверяется через `orders.user_id = current_user`), дублировать его в `order_nps` нет смысла.
> Для аналитических запросов достаточно `JOIN orders USING (order_id)`.

### Новая таблица `user_nps_eligibility`

Трекинг cooldown и истории показов для авторизованных пользователей.

```sql
CREATE TABLE user_nps_eligibility (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id),
  last_shown_at       TIMESTAMPTZ,                        -- когда последний раз ПОКАЗАЛИ
  last_submitted_at   TIMESTAMPTZ,                        -- когда последний раз отправили рейтинг
  total_paid_orders   INTEGER NOT NULL DEFAULT 0,         -- денормализованный счётчик заказов
  cooldown_until      TIMESTAMPTZ,                        -- дата окончания cooldown
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX user_nps_eligibility_user ON user_nps_eligibility(user_id);
```

**`total_paid_orders` — денормализация.** Инкрементируется событием post-order (очередь или DB trigger).
Считать `COUNT(*)` на каждую проверку дорого для активных пользователей.

### Миграция существующих данных

При деплое: бэкфиллить `user_nps_eligibility` из существующих `order_nps`:

```sql
INSERT INTO user_nps_eligibility
  (user_id, last_submitted_at, cooldown_until, total_paid_orders)
SELECT
  o.user_id,
  MAX(n.created_at),
  MAX(n.created_at) + INTERVAL '90 days',
  (SELECT COUNT(*) FROM orders o2
   WHERE o2.user_id = o.user_id AND o2.status = 'paid')
FROM order_nps n
JOIN orders o ON o.id = n.order_id
GROUP BY o.user_id
ON CONFLICT (user_id) DO NOTHING;
```

---

## Пример интеграции на фронтенде

Паттерн соответствует существующему в `src/api/market-api/`.

**`src/api/market-api/post-order-nps/types.ts`**
```typescript
export type PostOrderNpsRequest = {
  rating: 1 | 2 | 3 | 4 | 5;
  comment?: string;
};

export type PostOrderNpsResponse = {
  id: number;
};
```

**`src/api/market-api/get-order-nps-eligibility/types.ts`**
```typescript
export type NpsIneligibilityReason =
  | "already_submitted"
  | "order_too_old"
  | "ineligible_product"
  | "order_value_too_low"
  | "cooldown_active"
  | "insufficient_order_history";

export type GetOrderNpsEligibilityResponse = {
  shouldShow: boolean;
  reason?: NpsIneligibilityReason;
};
```

**`src/api/market-api/post-order-nps/endpoints.ts`**
```typescript
import type { PostOrderNpsRequest, PostOrderNpsResponse } from "./types";
import { getCsrfToken, kyFetchMarketApi } from "@/api/common";

export const postOrderNps = async (
  orderId: number,
  request: PostOrderNpsRequest
) => {
  return kyFetchMarketApi
    .post(`api/orders/${orderId}/nps/`, {
      credentials: "include",
      json: request,
      headers: { "X-Csrftoken": getCsrfToken() },
    })
    .json<PostOrderNpsResponse>();
};
```

**`src/api/market-api/post-nps-impression/endpoints.ts`**
```typescript
import { getCsrfToken, kyFetchMarketApi } from "@/api/common";

// Fire-and-forget: вызывать без await, ошибки игнорировать
export const postNpsImpression = () => {
  kyFetchMarketApi
    .post("api/users/nps/impression/", {
      credentials: "include",
      headers: { "X-Csrftoken": getCsrfToken() },
    })
    .catch(() => {});
};
```

---

## Флоу (обновлённый)

```
Экран успеха
     │
     ▼
[Back to Market]
     │
     ├─► Аноним: проверить куку nps_shown_at
     │         │
     │    cooldown активен ──► перейти в магазин
     │         │
     │    cooldown истёк / нет куки
     │         │
     ├─► GET /api/orders/{id}/nps/eligibility/
     │         │
     │    shouldShow: false ──► перейти в магазин
     │         │
     │    shouldShow: true
     │         │
     ▼         ▼
   Показать NPS bottom sheet
     │
     ├─► Аноним: SET cookie nps_shown_at (90 дней)
     ├─► Авторизован: POST /api/users/nps/impression/ (fire-and-forget)
     │
     ├─► [Пропустить] ──► перейти в магазин
     │
     └─► [Отправить]
           │
           ▼
     POST /api/orders/{id}/nps/
           │
           ▼
     Thank you state → перейти в магазин
```

---

## Аналитика

### API для аналитиков

Read-only эндпоинт для выгрузки данных в Superset (или любой другой BI-инструмент).
Требует внутренней авторизации (service token / IP whitelist).

```
GET /api/internal/nps/responses/
```

**Query params**

| Параметр | Тип | Описание |
|----------|-----|----------|
| `from` | `YYYY-MM-DD` | Начало периода (по `created_at`) |
| `to` | `YYYY-MM-DD` | Конец периода |
| `rating` | `1,2,3,4,5` | Фильтр по оценкам (через запятую) |
| `has_comment` | `bool` | Только с комментарием / без |
| `page` | `int` | Страница (default: 1) |
| `limit` | `int` | Записей на страницу (max: 1000, default: 500) |

**Response `200 OK`**

```typescript
type InternalNpsResponsesResponse = {
  total: number;
  page: number;
  results: Array<{
    id: number;
    order_id: number;
    rating: 1 | 2 | 3 | 4 | 5;
    comment: string | null;
    order_value_usd: number | null;
    // classification — null если ещё не обработан
    topic: "payment" | "delivery" | "price" | "ui" | "other" | null;
    sentiment: "positive" | "neutral" | "negative" | null;
    created_at: string; // ISO 8601
  }>;
};
```

### Автоматическая классификация комментариев

Ночной cron-job батчами обрабатывает новые комментарии через Claude API и записывает результат в `order_nps_analysis`.

**Новая таблица `order_nps_analysis`**

```sql
CREATE TABLE order_nps_analysis (
  id           SERIAL PRIMARY KEY,
  nps_id       INTEGER NOT NULL REFERENCES order_nps(id),
  topic        TEXT NOT NULL,    -- payment | delivery | price | ui | other
  sentiment    TEXT NOT NULL,    -- positive | neutral | negative
  is_anomaly   BOOLEAN NOT NULL DEFAULT FALSE, -- рейтинг противоречит тональности
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX order_nps_analysis_nps ON order_nps_analysis(nps_id);
```

**Pipeline (запускается раз в сутки)**

```python
# Псевдокод
comments = db.query("""
    SELECT n.id, n.rating, n.comment
    FROM order_nps n
    LEFT JOIN order_nps_analysis a ON a.nps_id = n.id
    WHERE n.comment IS NOT NULL AND a.id IS NULL
""")

if not comments:
    exit()

response = claude.messages.create(
    model="claude-opus-4-6",
    messages=[{
        "role": "user",
        "content": f"""
Classify each comment. Return a JSON array with objects:
{{"id": <id>, "topic": <topic>, "sentiment": <sentiment>, "is_anomaly": <bool>}}

Topics: payment, delivery, price, ui, other
Sentiment: positive, neutral, negative
is_anomaly: true if rating contradicts sentiment (e.g. rating=5 but negative text)

Comments:
{format_for_prompt(comments)}
        """
    }]
)

db.bulk_insert("order_nps_analysis", parse_json(response))
```

Claude обрабатывает комментарии на любом языке — отдельное хранение языка не нужно.

**Что получают аналитики в Superset:**
- Распределение тем: «60% комментариев про оплату»
- Аномалии: высокий рейтинг + негативный текст (и наоборот)
- Динамика NPS по времени с разбивкой по темам

---

## Архитектурные решения на будущее

**Generic Survey API** — когда появится второй NPS-контекст (доставка, фича, бронирование и т.д.),
имеет смысл перейти к обобщённому эндпоинту вместо создания отдельного `/orders/{id}/nps/` для каждого случая:

```
GET /api/nps/?target=/orders/          → конфиг опроса + эндпоинт для отправки
GET /api/nps/?target=/banner/feature/  → другой конфиг, стратегия once
```

Текущие таблицы (`order_nps`, `user_nps_eligibility`) и стратегии cooldown совместимы с этим переходом
без изменений схемы — `user_nps_eligibility` достаточно расширить ключом target.
Переход делать при появлении реального второго кейса, не заранее.

---

## Принятые решения

| Вопрос | Решение |
|--------|---------|
| Аналитика | `GET /api/internal/nps/responses/` для Superset + ночная LLM-классификация комментариев |
| Язык комментария | Не хранить — Claude обрабатывает любой язык без подсказок |
| Порог суммы | $1.00 — фильтрует тестовые микротранзакции (Thorium $0.10), сохраняет все осмысленные покупки |
