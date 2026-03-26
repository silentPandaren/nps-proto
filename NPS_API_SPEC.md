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

---

### GET `/api/orders/{order_id}/nps/eligibility/`

Проверить, нужно ли показывать NPS для данного заказа.
Вызывается фронтендом при переходе на экран успеха.

**Response `200 OK`**

```typescript
type GetOrderNpsEligibilityResponse = {
  shouldShow: boolean;
  reason?: "already_submitted" | "order_too_old" | "ineligible_product";
};
```

---

## Бизнес-логика (для бэкенда)

| Правило | Значение |
|---------|----------|
| Один NPS на заказ | Повторная отправка → `409` |
| Окно показа | Только если заказ создан не позднее 7 дней назад |
| Типы заказов | Только успешно оплаченные (`isFreeOrder: true` или статус `paid`) |
| Анонимные пользователи | Не показывать |

---

## Модель данных (для бэкенда)

```sql
CREATE TABLE order_nps (
  id           SERIAL PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  showcase_id  INTEGER REFERENCES showcases(id),
  rating       SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX order_nps_unique_order ON order_nps(order_id);
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

---

## Флоу

```
Экран успеха
     │
     ▼
[Back to Market]
     │
     ├─► GET /api/orders/{id}/nps/eligibility/
     │         │
     │    shouldShow: false ──► редирект в магазин
     │         │
     │    shouldShow: true
     │         │
     ▼         ▼
   Показать NPS bottom sheet
     │
     ├─► [Пропустить] ──► редирект в магазин
     │
     └─► [Отправить]
           │
           ▼
     POST /api/orders/{id}/nps/
           │
           ▼
     Thank you state → редирект в магазин
```

---

## Вопросы, которые стоит обсудить до реализации

1. **Хранить `showcase_id`?** — полезно для аналитики по конкретным играм
2. **Нужен ли GET eligibility?** — можно упростить: всегда показывать, дублирование защищать только на `POST`
3. **Аналитика** — нужен ли отдельный Grafana/BI дашборд или достаточно выгрузки из БД?
4. **Локализация комментария** — сохранять язык пользователя вместе с комментарием?
