# Flight Watch — Chișinău → Nha Trang

Локальный сайт-монитор цен на авиабилеты:

| Параметр | Значение |
| --- | --- |
| Откуда | Chișinău, Moldova — **RMO** (Eugen Doga Chișinău International Airport) |
| Куда | Nha Trang, Vietnam — **CXR** (Cam Ranh International Airport) |
| Тип | one-way, economy |
| Пассажиры | **2 взрослых** (цена — итог за двоих) |
| Даты вылета | 20.10.2026 – 15.11.2026 включительно (**27 дат**) |
| Пересадки | любое количество (фильтр по умолчанию — Any) |

## 1. Что делает приложение

* Сканирует все 27 дат вылета, нормализует ответы провайдера в единый формат `FlightOffer`.
* Показывает самый дешёвый найденный вариант и самый дешёвый день, график «Price by departure date»,
  таблицу всех маршрутов с раскрываемыми сегментами, пересадками, багажом, self-transfer предупреждениями.
* Сортировки: Cheapest (по умолчанию), Fastest, Fewest stops, Earliest departure.
  Фильтры: max duration, stops (Any/Direct/≤1/≤2/≤3/4+), airline, departure date, max price. Фильтры сохраняются в URL.
* Хранит каждый реальный snapshot в SQLite: история минимальной цены по дате, история цены конкретного
  маршрута (fingerprint), изменения ↓/↑ относительно предыдущего snapshot, lowest/highest observed.
* Автообновление по расписанию + кнопка «Refresh prices», прогресс «17 / 27 dates checked», индикатор freshness,
  частичные результаты («24 of 27 dates successfully checked»), отдельные состояния для 401, 429, отсутствия ключа.
* Дополнительно: CSV export, сравнение до 3 маршрутов, порог цены + desktop notifications, визуализация длительности
  и пересадок, статистика (median, cheapest date, fastest, best price/duration compromise), dark/light тема.

## 2. Провайдер данных

| `FLIGHT_PROVIDER` | Источник | Данные |
| --- | --- | --- |
| `serpapi` (по умолчанию) | [SerpApi Google Flights API](https://serpapi.com/google-flights-api) — `GET https://serpapi.com/search.json?engine=google_flights` | **LIVE**: актуальная выдача Google Flights на момент запроса |
| `duffel` | [Duffel Flights API v2](https://duffel.com/docs/api/v2/offer-requests/create-offer-request) — `POST https://api.duffel.com/air/offer_requests` | `duffel_test_…` → **SANDBOX** (вымышленная Duffel Airways), `duffel_live_…` → **LIVE** контент авиакомпаний |
| `demo` | встроенный генератор | **DEMO DATA** — только для UI/разработки, везде помечено, хранится отдельно |

## 3. Почему выбран именно этот провайдер

* **Amadeus Self-Service** (классический выбор) закрыт: портал выведен из эксплуатации 17.07.2026, ключи отключены.
* **Kiwi Tequila** не принимает самостоятельные регистрации; Skyscanner и Travelpayouts real-time Flight Search API выдаются
  только после партнёрского одобрения, а Travelpayouts Data API отдаёт кэш цен из чужих поисков без полной сегментации.
* **SerpApi** — легальный коммерческий API marketplace: ключ выдаётся самостоятельно за минуту, бесплатный план,
  один запрос = одна дата, возвращает `price` для указанного числа `adults` в запрошенной `currency=EUR`,
  все сегменты (номер рейса, аэропорты, локальное время, длительность), пересадки, extensions (багаж),
  ссылку `google_flights_url` на реальную выдачу. Количество пересадок не ограничиваем (`stops` не передаётся = any).
* **Duffel** — второй, «официальный» вариант: прямой контент авиакомпаний (NDC/GDS), `total_amount` с налогами
  для всех пассажиров, IANA time zones аэропортов, багаж по сегментам. Требует верификации аккаунта для live.

Сайт ничего не скрейпит сам и не обходит anti-bot защиту: все запросы идут на документированные API провайдеров.

## 4. Какие данные live

* `serpapi`: цена и расписание — snapshot Google Flights в момент запроса (SerpApi может отдать свой кэш до 1 ч
  для идентичного запроса; время snapshot провайдера показывается как «Last provider update»).
* `duffel` + `duffel_live_…`: live-предложения авиакомпаний с `expires_at`. С `duffel_test_…` — SANDBOX, баннер в UI.
* Это **near-real-time** мониторинг (регулярные snapshots), а не tick-by-tick поток. Цена может измениться
  между поиском и бронированием — об этом сказано в блоке Data provenance.
* Курсы валют (только если Duffel вернул не EUR): реальные ECB reference rates через [Frankfurter](https://frankfurter.dev),
  исходная валюта показывается рядом. Захардкоженных курсов нет.

## 5. Ограничения провайдеров

**SerpApi**
* Каждая некэшированная дата = 1 search из квоты (кэшированные SerpApi, ошибочные и failed searches не считаются).
  Полный проход = 27 searches. Free plan — 250 searches/месяц и 50/час (≈ 9 полных проходов в месяц), Developer — 5,000/месяц.
* Значения по умолчанию рассчитаны на Developer plan: автообновление каждые 240 мин, TTL 240 мин,
  `DAILY_REQUEST_LIMIT=162` (6 полных проходов в сутки ≈ 4,860/месяц), ручной refresh не чаще 1 раза в 60 с,
  перезапрашиваются только даты старше 10 минут.
* Для Free plan поставьте `REFRESH_INTERVAL_MINUTES=4320` (раз в 3 дня ≈ 10 проходов/месяц) и `DAILY_REQUEST_LIMIT=27`
  — иначе квота закончится; приложение тогда покажет состояние «quota / rate limit» и оставит кэш на экране.
* Google Flights отдаёт локальное время аэропортов без UTC-offset; длительности сегментов, пересадок и
  всего пути берутся из ответа провайдера (минуты), а не вычисляются из строк времени.
* `price` — сумма Google Flights за всю группу пассажиров (здесь 2 adults), с налогами и сборами перевозчика;
  багаж, места и комиссии за оплату не включены. Ответ проверяется на `search_parameters.adults = 2`.
* Ссылка «View / Book» открывает реальную страницу Google Flights с этой датой и 2 пассажирами
  (`google_flights_url`), где выбирается конкретный рейс. Отдельный booking-запрос (`booking_token`) стоил бы
  ещё один search на каждое предложение, поэтому не выполняется автоматически.
* Self-transfer помечается только когда Google явно пишет «Self transfer» / «Separate tickets».

**Duffel**
* Live search limit по умолчанию — 10 запросов / 60 с → приложение делает 1 запрос каждые 6.5 с (полный проход ≈ 3 мин),
  429 повторяется с учётом `Retry-After`/`ratelimit-reset`.
* `max_connections` по умолчанию у Duffel = 1; отправляем `DUFFEL_MAX_CONNECTIONS=2` (максимум, который мы используем) —
  маршрутов с 3+ пересадками Duffel в одной брони не вернёт. Для «любых пересадок» лучше SerpApi.
* У Duffel нет потребительской страницы бронирования → в UI честно: «Booking link unavailable from this provider».
* Split-ticket (self-transfer) у Duffel доступен только для multi-slice поиска по заявке в поддержку — для one-way не используется.
* Live-доступ требует активации аккаунта (компания, платёжные данные), test-токен доступен сразу.

## 6. Как получить API key

**SerpApi (рекомендуется):**
1. Зарегистрируйтесь: https://serpapi.com/users/sign_up
2. Скопируйте Private API Key: https://serpapi.com/manage-api-key
3. В `.env`: `FLIGHT_PROVIDER=serpapi`, `SERPAPI_API_KEY=...`

**Duffel:**
1. Регистрация: https://app.duffel.com/join
2. Dashboard → Developers → Access tokens → Create token (`duffel_test_…` сразу; `duffel_live_…` после активации live mode)
3. В `.env`: `FLIGHT_PROVIDER=duffel`, `DUFFEL_ACCESS_TOKEN=...`

## 7. Заполнение `.env`

```bash
cp .env.example .env
# откройте .env и вставьте ключ
```

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `FLIGHT_PROVIDER` | `serpapi` | `serpapi` / `duffel` / `demo` |
| `SERPAPI_API_KEY` | — | секрет SerpApi (только сервер) |
| `SERPAPI_GL` / `SERPAPI_HL` | `md` / `en` | страна (point of sale) и язык Google |
| `SERPAPI_DEEP_SEARCH` | `false` | `true` = медленнее, но 1:1 с браузером |
| `DUFFEL_ACCESS_TOKEN` | — | секрет Duffel (только сервер) |
| `DUFFEL_MAX_CONNECTIONS` | `2` | 0–2 |
| `REFRESH_INTERVAL_MINUTES` | serpapi 240 / duffel 30 / demo 5 | период автообновления |
| `CACHE_TTL_MINUTES` | = интервалу | даты свежее TTL не перезапрашиваются (5–10080 мин для интервала, 1–10080 для TTL) |
| `DAILY_REQUEST_LIMIT` | serpapi 162 / иначе 0 | жёсткий лимит вызовов провайдера в сутки (0 = без лимита) |
| `MANUAL_REFRESH_COOLDOWN_SECONDS` | `60` | защита от частых ручных обновлений |
| `MAX_OFFERS_PER_DATE` | `25` | сколько самых дешёвых маршрутов хранить на дату |
| `REQUEST_TIMEOUT_MS` | `60000` | таймаут запроса к провайдеру |
| `DB_PATH` | `./data/flight-watch.sqlite` | файл SQLite |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | адрес сервера |

`.env` в `.gitignore`; ключи читаются только в `src/config.js` и уходят только на серверные запросы к провайдеру.
Браузер получает лишь нормализованные данные через `/api/*`; произвольного proxy-endpoint нет.

## 8. Установка

Требуется **Node.js ≥ 22.13** (рекомендуется 24): используется встроенный `node:sqlite`, нативная сборка не нужна.

```bash
npm install
```

## 9. Запуск

```bash
cp .env.example .env   # и впишите ключ
npm start              # http://127.0.0.1:3000
```

Посмотреть интерфейс без ключа (всё помечено DEMO DATA):

```bash
FLIGHT_PROVIDER=demo npm start
```

## 10. Тесты

```bash
npm test
```

Vitest покрывает: генерацию 27 дат (включая DST 25.10), парсинг длительностей и time zones, нормализацию цены,
расчёт per-person из total за 2 взрослых, нормализацию маршрутов SerpApi и Duffel (fixtures по документации),
fingerprint маршрутов, сортировку/фильтры, классификацию 401/429, кэш/TTL, частичные результаты, остановку при rate limit,
дневной бюджет, разделение demo/live истории, валидацию HTTP API, отсутствие секретов во frontend.

## Архитектура

```
Browser (public/*, без секретов) ──/api/*──► Express (src/server.js)
                                              └─ Monitor (src/monitor.js): 27 дат, TTL-кэш, concurrency + spacing,
                                                 retry/backoff, бюджет, частичные результаты
                                                   ├─ Provider adapter (src/providers/serpapi|duffel|demo.js) → FlightOffer
                                                   ├─ Currency (ECB via Frankfurter, только для не-EUR)
                                                   └─ SQLite (src/db.js): date_results (кэш), date_snapshots, offer_observations, runs
```
