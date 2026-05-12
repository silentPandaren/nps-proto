# NPS Proto

Прототип NPS-опроса для маркетплейса War Robots. Показывается как bottom sheet после успешной покупки.

## Что внутри

| Файл | Описание |
|------|----------|
| `nps-prototype.html` | Интерактивный HTML-прототип всего флоу |
| `nps-dashboard.html` | Дашборд для анализа собранных NPS-ответов |
| `scripts/enrich.mjs` | Препроцессор: переводит комментарии в EN + классифицирует через Claude |
| `NPS_API_SPEC.md` | Спецификация API (эндпоинты, модель данных, бизнес-логика) |

## Флоу прототипа

1. **Storefront** — витрина товаров (Д-кубы, Thorium и др.)
2. **Product Detail** — карточка товара с кнопкой «Купить»
3. **Processing** — экран обработки платежа (~5 сек)
4. **Success** — подтверждение покупки
5. **NPS bottom sheet** — появляется по нажатию «Back to Market»
   - Звёздный рейтинг 1–5
   - Опциональный текстовый комментарий
   - Thank you state после отправки

## API

Два эндпоинта:

```
POST /api/orders/{order_id}/nps/           — сохранить оценку
GET  /api/orders/{order_id}/nps/eligibility/ — проверить, показывать ли опрос
```

Подробнее — в [NPS_API_SPEC.md](NPS_API_SPEC.md).

## Запуск прототипа

Открыть `nps-prototype.html` в браузере — никаких зависимостей нет.

## Запуск дашборда

Дашборд работает с CSV-выгрузкой `order_nps` (см. [NPS_API_SPEC.md](NPS_API_SPEC.md)).
Двухступенчатая схема: офлайн-препроцессор обогащает данные переводом и классификацией, статичная HTML-страница их рендерит.

**1. Положить CSV:**
```
data/order_nps_export.csv
```
Формат: `id;order_id;rating;comment;order_value_usd;created_at` (UTF-8, опциональный BOM).

**2. Прогнать препроцессор:**
```bash
cd scripts
npm install
ANTHROPIC_API_KEY=sk-... node enrich.mjs
```
- Использует Claude Haiku 4.5; обработка ~140 непустых комментариев на 636 строках стоит ~$0.30–0.80.
- Кеширует результат в `data/responses.cache.json` — повторный запуск бесплатный.
- Без `ANTHROPIC_API_KEY` — fallback-режим: дашборд работает, но без перевода и классификации.

**3. Открыть дашборд:**
```bash
# из корня nps-proto
python3 -m http.server 8000
# открыть http://localhost:8000/nps-dashboard.html
```
(нужен HTTP, а не `file://` — иначе fetch не сработает).

### Что показывает дашборд

- **KPI**: total responses, response rate (vs configurable impressions), avg rating, share with comment, anomalies (4-5★ + negative)
- **Rating distribution** (1★–5★)
- **Responses per day** + средний рейтинг по дням
- **Topic distribution** на 3 категории: `payment_window`, `ui`, `assortment`, `none`
- **Sentiment by topic** (stacked positive/neutral/negative)
- **Comments table** с фильтрами по rating / topic / sentiment / search и переключателем «only with comment»
- У переведённых комментариев бейдж `🌐 translated from XX` — клик показывает оригинал
