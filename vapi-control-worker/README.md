# Vapi Live Control — приватная операторская консоль

### VIVpod CRM event mirror

`POST /vapi/vivpod-events` accepts minimized live events from the VIVpod CRM,
using the independent `VIVPOD_EVENTS_SECRET` bearer credential. It publishes to
the existing private CallHub and never invokes `WEBHOOK_FORWARD_URL`. The legacy
`/vapi/events` credential and forwarding behavior are unchanged. CRM remains the
primary Vapi webhook for tools and call reports. Its deployment explicitly lists
the assistant IDs permitted to use this owner's console; other tenants are excluded.

Консоль для наблюдения за активными звонками существующего Vapi-ассистента
(Deepgram Nova 3 → GPT-5 → xAI Ara) и ручного управления ими.
Модель, голос и транскрайбер **не изменяются** этим проектом.

### Скидки ассистента

На `https://www.vivpod.com/vapi-control/` флажок **Apply discounts** находится
сверху и доступен без выбранного звонка. Это один постоянный флаг с блоком
скидочных цен в CRM; цены настраиваются по ссылке **Edit discounted prices in CRM**.
При сохранении CRM обновляет настройки новых звонков и передаёт действующие
правила активным разговорам. Если доставка части обновлений не подтверждена,
консоль показывает это отдельно от сохранённого флага. Ошибка или тайм-аут
вызывает чтение фактического состояния, а не повторную запись.

Маршрут скидок требует настроенных `POLICY_AUD` и `ALLOWED_EMAILS`, действительной
пользовательской Access-сессии и www.vivpod.com. Worker передаёт проверенное
подписанное утверждение и фиксированный Origin в `/api/integrations/voice/promotions`.
CRM повторно проверяет его и право владельца компании. Цены, произвольные
промпты, API-ключи и идентификатор компании из браузера не принимаются.

| Что | Где |
| --- | --- |
| Консоль (сейчас) | https://kidletto-vapi-control.geofakt.workers.dev/vapi-control/ |
| Вход с сайта | https://kidletto.com/vapi-control/ → переадресация на консоль (файл для GoDaddy, см. §10) |
| Webhook для Vapi | https://kidletto-vapi-control-webhook.geofakt.workers.dev/vapi/events |

---

## 1. Что делает приложение

- Автоматически находит активные звонки (без ввода Call ID), показывает список, если их несколько.
- Таймер по реальному `startedAt` звонка из Vapi (с поправкой на расхождение часов браузера и сервера).
- Живой транскрипт PROVIDER / ASSISTANT (события Vapi через webhook), без дублей; interim-фразы показываются курсивом.
- LISTEN — живое аудио звонка (`monitor.listenUrl`); включается само.
- SAY TO CALLER — фраза произносится дословно голосом ассистента (`say`), Ctrl+Enter.
  Русский текст сначала переводится на сервере (Workers AI, Llama 3.3 70B), и звонку
  уходит готовая английская фраза — консоль показывает, что именно прозвучало.
- DICTATE (🎤) — оператор говорит по-русски, речь распознаётся на сервере (Workers AI,
  Deepgram Nova-3, запасной — Whisper), переводится и произносится по-английски.
  Микрофон включается только нажатием и отпускается сразу после записи.
- SAY & HANG UP — фраза (тоже с переводом), затем завершение звонка штатным `endCallAfterSpoken`.
- TAKE OVER — режим оператора: ассистент заглушён (`mute-assistant`) и получает указание молчать;
  каждая фраза оператора размьючивает его ровно на время фразы, затем сервер глушит его снова
  (по событию `speech-update stopped` или по оценке длительности). Режим хранится на сервере —
  его видят все устройства, он переживает перезагрузку страницы.
- AI INSTRUCTION — инструкция модели только для текущего звонка (`add-message`, role `system`); можно писать по-русски.
- QUICK PHRASES — настраиваемые кнопки (редактируются в консоли, хранятся на сервере).
- END CALL — с подтверждением (`end-call`).
- Оповещения о звонке (Web Push) — уведомление со звуком устройства, даже когда консоль закрыта;
  консоль устанавливается как приложение (PWA) на телефон и компьютер.
- На телефоне сверху — DICTATE и быстрые фразы, ниже транскрипт и остальное.
- DTMF — см. §4 и §14: прямой DTMF от оператора Vapi **не поддерживает**; клавиатура включается только если у ассистента есть встроенный инструмент `dtmf`.

### Оповещения и приложение на телефоне

- **Android (Chrome):** открыть консоль → меню ⋮ → «Установить приложение» (или кнопка
  «⬇ Install app» в шапке) → открыть Vapi Control с рабочего стола → «🔔 Alerts» →
  Turn on alerts → Send test alert.
- **iPhone (Safari, iOS 16.4+):** Поделиться → «На экран Домой» → открыть Vapi Control
  с экрана «Домой» → «🔔 Alerts» → Turn on alerts. В обычной вкладке Safari web push не работает.
- **Компьютер (Chrome/Edge):** «🔊 Enable sound & alerts» или «🔔 Alerts» → разрешить
  уведомления. Оповещения приходят, пока браузер запущен, даже если вкладка консоли закрыта.
  «⬇ Install app» ставит консоль отдельным окном.
- Срок входа Cloudflare Access (по умолчанию 24 ч) задаётся в Zero Trust → Access →
  Applications → приложение → Session duration; для приложения на телефоне удобно поставить
  неделю или месяц, иначе после клика по оповещению придётся заново вводить код из письма.

## 2. Архитектура

```
Браузер оператора
   │ HTTPS / WSS (один origin)
   ▼
Cloudflare Access (вход по email)  ──► JWT в заголовке Cf-Access-Jwt-Assertion
   ▼
Worker "kidletto-vapi-control"  (проверяет подпись JWT в каждом запросе)
   ├─ /vapi-control/            статический интерфейс (../vapi-control)
   ├─ /vapi-control/api/...     REST + WebSocket
   │     ├─► api.vapi.ai (приватный ключ, только здесь)
   │     ├─► call.monitor.controlUrl  (say / add-message / end-call)
   │     └─► call.monitor.listenUrl   (аудио, проксируется без JS на каждый кадр)
   └─ Durable Object CallHub ──► WebSocket событий в браузер
                ▲
Worker "kidletto-vapi-control-webhook" (публичный, секрет Bearer)
                ▲                       └─► WEBHOOK_FORWARD_URL (прежний Server URL, напр. vapi-telegram)
         Vapi Server URL events (status-update, conversation-update, transcript, speech-update)
```

Почему консоль отдаёт сам Worker, а не хостинг GoDaddy: kidletto.com обслуживается
Apache на GoDaddy, DNS тоже у GoDaddy, поэтому Cloudflare Access не может защитить
страницу на GoDaddy. Интерфейс и API на одном origin за Access — единственная схема,
где защищены **и** страница, **и** API без сторонних cookie. Переход на
`kidletto.com/vapi-control/` описан в §10 и §11 (вариант B), код менять не нужно.

## 3. Структура каталогов

```
vapi-control/                 фронтенд (статика; раздаётся Worker'ом)
  index.html
  config.js                   НЕсекретные настройки: быстрые фразы, шаблон инструкции, опрос, аудио, DTMF
  css/app.css
  js/app.js                   контроллер интерфейса
  js/api.js                   клиент API (same-origin, распознаёт истёкшую сессию Access)
  js/events.js                WebSocket событий с переподключением
  js/transcript.js            модель транскрипта (partial/final/commit, дедупликация)
  js/audio.js                 плеер listen-потока + автоопределение формата PCM
  js/dictation.js             запись голоса оператора (MediaRecorder) для DICTATE
  js/push.js                  service worker, подписка на Web Push, установка приложения
  js/format.js
  sw.js                       service worker: показывает оповещения о звонках
  manifest.webmanifest, icons/   установка как приложение (PWA)
vapi-control-worker/
  src/index.js                Worker консоли: роутинг, API, прокси listen
  src/auth.js                 проверка Cloudflare Access JWT (RS256, WebCrypto)
  src/vapi.js                 клиент Vapi API / controlUrl / listenUrl
  src/calls.js                фильтры звонков, санитизация, DTMF-возможности
  src/hub.js                  Durable Object CallHub (живые события → браузеры, режим оператора, push-подписки)
  src/ai.js                   Workers AI: распознавание диктовки, перевод фраз
  src/push.js                 Web Push: VAPID (RFC 8292) + шифрование aes128gcm (RFC 8291)
  src/events.js               санитизация Vapi webhook-событий
  src/webhook.js              Worker-ingress для Vapi Server URL
  src/http.js, src/log.js     заголовки безопасности, CORS/Origin, логи с редактированием секретов
  wrangler.jsonc              конфиг Worker консоли
  wrangler.webhook.jsonc      конфиг Worker webhook
  .dev.vars.example           только плейсхолдеры
  deploy/godaddy/vapi-control/index.html   переадресация для kidletto.com/vapi-control/
  test/unit | integration | ui
```

Оба каталога исключены из сборки Jekyll (`_config.yml → exclude`), чтобы исходники
не попали в публичный `_site`.

## 4. Интеграция с Vapi (проверено по официальной документации)

| Функция | Механизм Vapi | Статус |
| --- | --- | --- |
| Поиск звонков | `GET /call?createdAtGt=…&limit=100[&assistantId=…]`, фильтр статусов `queued/ringing/in-progress/forwarding` | реализовано |
| Детали звонка | `GET /call/{id}` → `monitor.listenUrl`, `monitor.controlUrl` | реализовано |
| Say | `POST controlUrl {"type":"say","content":…,"endCallAfterSpoken":false}` | реализовано |
| Say & hang up | `say` + `endCallAfterSpoken:true` + `interruptionsEnabled:false` | реализовано |
| AI instruction | `POST controlUrl {"type":"add-message","message":{"role":"system",…},"triggerResponseEnabled":true}` | реализовано |
| End call | `POST controlUrl {"type":"end-call"}` | реализовано |
| Live listen | WebSocket `monitor.listenUrl` (бинарный PCM + JSON-фреймы) | реализовано |
| Живой транскрипт | только Server URL events (`conversation-update`, `transcript`, `status-update`, `speech-update`); `GET /call` транскрипт во время звонка не отдаёт | реализовано, требует настройки §11.3 |
| DTMF от оператора | **в Live Call Control нет такой команды.** Официально DTMF шлёт только встроенный инструмент ассистента `dtmf` (RFC 2833) | см. ниже |

- `listenUrl`/`controlUrl` по умолчанию **без аутентификации** (capability URL). Worker никогда
  не отдаёт их в браузер. Если включить в `assistant.monitorPlan`
  `listenAuthenticationEnabled`/`controlAuthenticationEnabled`, Vapi требует
  `Authorization: Bearer <PUBLIC key>` — тогда задайте `VAPI_PUBLIC_KEY`.
- Ограничения GPT-Live на `say`/`add-message` к этому ассистенту не относятся (он на стандартном пайплайне GPT-5).
- **DTMF.** Прямой отправки нет, поэтому клавиатура по умолчанию выключена и помечена
  «NOT SUPPORTED BY VAPI». Если добавить ассистенту встроенный инструмент **DTMF**
  (Vapi Dashboard → Tools → Create Tool → DTMF, затем привязать к ассистенту), консоль
  это обнаружит и включит клавиатуру: цифры передаются модели инструкцией «вызови dtmf
  с keys "…"», а реальные тоны шлёт Vapi. Нажатие выполняет модель, поэтому это не
  детерминированно (см. §14). Добавлять инструмент — ваше решение: это изменение ассистента.
- Формат listen-аудио Vapi не документирует (частота/каналы). Плеер определяет его
  автоматически и показывает («PCM16 16 kHz mono (auto)»); при искажениях формат
  можно выбрать вручную (Format).

## 5. Архитектура Cloudflare Worker

API (все пути под `/vapi-control/api/`, каждый запрос — только с валидным Access JWT):

| Метод | Путь | Назначение |
| --- | --- | --- |
| GET | `session` | email оператора, серверное время, состояние конфигурации |
| GET / POST | `promotions` | общий флаг скидок CRM; запись только `{enabled, expectedRevision}`, с проверкой ревизии и статуса доставки |
| GET | `calls` | активные звонки (без monitor URL, промптов, стоимости) |
| GET | `calls/:id` | один звонок + возможности (control/listen/dtmf) |
| POST | `calls/:id/say` | `{text, endCallAfterSpoken?, interruptAssistant?, translate?}` → `{spoken}` |
| POST | `calls/:id/instruction` | `{text, triggerResponse?, line?}` |
| POST | `calls/:id/mode` | `{operator, text, mute?}` — режим оператора |
| POST | `transcribe` | аудио (webm/ogg/mp4) → `{text}` |
| POST | `push/subscribe`, `push/unsubscribe`, `push/test` | оповещения Web Push |
| POST | `calls/:id/dtmf` | `{keys}` — только если у ассистента есть `dtmf` tool |
| POST | `calls/:id/end` | завершить звонок |
| WS | `calls/:id/listen` | аудио (прокси `listenUrl`) |
| WS | `events` | живой транскрипт/статусы (CallHub) |

Безопасность в Worker: проверка JWT (подпись по ключам команды Access, `iss`, `aud`,
`exp`), второй независимый список `ALLOWED_EMAILS`, отказ при отсутствии конфигурации
(503), проверка `Origin` для POST и WebSocket, CORS только для `ALLOWED_ORIGINS`
(без `*`), CSP/`Permissions-Policy: microphone=()`, перед каждой командой звонок
перечитывается из Vapi (статус, фильтр ассистента). Логи — JSON без секретов;
автоматические invocation logs выключены (они сохраняли бы заголовки запросов).

## 6. Переменные окружения

Обязательных значений всего два: **`VAPI_API_KEY`** и **`TEAM_DOMAIN`**.
Остальное — усиление защиты поверх политики Cloudflare Access; без них консоль
работает, но в шапке показывает жёлтый значок «Security notice» с пояснением.

**kidletto-vapi-control**

| Имя | Тип | Обязательна | Значение |
| --- | --- | --- | --- |
| `VAPI_API_KEY` | Secret | **да** | приватный ключ Vapi |
| `TEAM_DOMAIN` | Variable | **да** | `https://<team>.cloudflareaccess.com` — источник ключей для проверки подписи JWT. Можно перечислить несколько через запятую; указывайте только те, что реально отдают `/cdn-cgi/access/certs` |
| `POLICY_AUD` | Variable | рекомендуется | AUD-тег приложения Access (64 hex). Без неё подойдёт JWT **любого** приложения этой команды Access |
| `ALLOWED_EMAILS` | Variable | рекомендуется | email(ы) операторов через запятую. Без неё пускает всех, кого пропустила политика Access |
| `VAPI_ASSISTANT_ID` | Variable | нет | UUID — показывать/управлять только звонками этого ассистента |
| `VAPI_PUBLIC_KEY` | Secret | нет | только если включена аутентификация monitor URL |
| `ALLOWED_ORIGINS` | Variable (в wrangler.jsonc) | уже задана | `https://kidletto.com` |
| `VAPID_PUBLIC_KEY` | Variable (в wrangler.jsonc) | для оповещений | публичная половина VAPID-ключа (base64url) |
| `VAPID_PRIVATE_KEY` | Secret | для оповещений | приватная половина (base64url, 32 байта). Без неё кнопка «Alerts» не появляется |
| `VAPID_SUBJECT` | Variable (в wrangler.jsonc) | нет | контакт для push-сервисов, по умолчанию `https://kidletto.com` |
| `AI` | binding (в wrangler.jsonc) | для DICTATE и перевода | Workers AI; ключ не нужен, оплата — аккаунт Cloudflare |

Новая пара VAPID-ключей (если приватный ключ утёк):
`node -e "const c=require('crypto');const j=c.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'jwk'});console.log('public',Buffer.concat([Buffer.from([4]),Buffer.from(j.x,'base64url'),Buffer.from(j.y,'base64url')]).toString('base64url'));console.log('private',j.d)"`
— public в `wrangler.jsonc`, private — `npx wrangler secret put VAPID_PRIVATE_KEY`. Устройства
переподпишутся сами при следующем открытии консоли.

Почему `TEAM_DOMAIN` нельзя опустить: по ней Worker берёт публичные ключи
Cloudflare (`<team>/cdn-cgi/access/certs`). Если брать домен из самого токена,
злоумышленник подставит свой домен со своими ключами и подпишет любой JWT сам.
Поэтому Worker сначала сверяет `iss` со списком и только потом идёт за ключами.

Текущие значения для этого аккаунта заданы в `wrangler.jsonc` (они не секретны —
оба видны в публичном redirect'е на страницу входа):
`TEAM_DOMAIN=https://kidletto.cloudflareaccess.com`,
`POLICY_AUD=64d5dc8e…745d7`. Если задать те же имена переменных в дашборде,
значения дашборда имеют приоритет.

**kidletto-vapi-control-webhook**

| Имя | Тип | Обязательна | Значение |
| --- | --- | --- | --- |
| `VAPI_WEBHOOK_SECRET` | Secret | для живого транскрипта | случайная строка ≥ 32 символов; то же значение — в Vapi Bearer credential |
| `WEBHOOK_FORWARD_URL` | Secret | нет | прежний Server URL, если события нужно дублировать туда (например, в vapi-telegram) |

Только для тестов (не задавать в продакшене): `VAPI_API_BASE_URL`, `DEV_AUTH_BYPASS`.

## 7. Cloudflare Secrets

Секреты задаются в Dashboard: **Workers & Pages → <worker> → Settings → Variables and
Secrets → Add → Type: Secret**, или из терминала:

```bash
cd vapi-control-worker
npx wrangler secret put VAPI_API_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPI_WEBHOOK_SECRET -c wrangler.webhook.jsonc
npx wrangler secret put WEBHOOK_FORWARD_URL -c wrangler.webhook.jsonc
```

Обычные переменные (`TEAM_DOMAIN`, `POLICY_AUD`, `ALLOWED_EMAILS`, `VAPI_ASSISTANT_ID`)
добавляйте в Dashboard как **Text**; `keep_vars: true` сохраняет их при `wrangler deploy`.
Никогда не кладите ключи в `config.js`, `wrangler*.jsonc` или Git.

## 8. Локальная разработка

```bash
cd vapi-control-worker
npm install
cp .dev.vars.example .dev.vars   # заполнить; DEV_AUTH_BYPASS=true работает только на localhost
npx wrangler dev                  # http://127.0.0.1:8787/vapi-control/
```

`.dev.vars` в `.gitignore`. Для живого транскрипта локально нужен и webhook-Worker;
при двух отдельных `wrangler dev` связь с Durable Object через dev-реестр бывает
нестабильной — тесты поэтому запускают оба Worker в одном процессе (`test/helpers/devserver.mjs`).

## 9. Деплой Worker

```bash
cd vapi-control-worker
npm install
npx wrangler login        # если не авторизованы
npm run check             # dry-run обоих
npm run deploy            # сначала консоль (класс CallHub), затем webhook
```

## 10. Деплой фронтенда

Фронтенд деплоится вместе с Worker (`assets.directory = ../vapi-control`); после
правки `config.js` выполните `npm run deploy`.

**Вариант A (сейчас, DNS у GoDaddy).** Чтобы адрес `kidletto.com/vapi-control/` вёл в
консоль, загрузите на GoDaddy **папку** `vapi-control-worker/deploy/godaddy/vapi-control/`
в корень сайта (cPanel → File Manager → каталог, где лежит `index.html` главной
страницы, обычно `public_html`). Должен появиться файл
`public_html/vapi-control/index.html`. `.htaccess` менять не нужно.

**Вариант B (адрес kidletto.com/vapi-control/ без переадресации).** Требует, чтобы
kidletto.com обслуживался через Cloudflare:
1. Cloudflare Dashboard → Add a domain → `kidletto.com` → Free. Сверьте импортированные
   DNS-записи с GoDaddy (A `@` → 198.12.236.208, `www`, MX, TXT/SPF/DKIM) — почта зависит от MX/TXT.
2. SSL/TLS → Full (strict).
3. GoDaddy → Domain → Nameservers → Custom → два NS от Cloudflare. Дождитесь статуса Active.
4. В `wrangler.jsonc` раскомментируйте `routes` (`kidletto.com/vapi-control*`) и выполните
   `npm run deploy`. Маршрут узкий: остальные страницы идут на GoDaddy как раньше.
5. Access-приложение для `kidletto.com/vapi-control` (§11, вариант B), его AUD добавьте в `POLICY_AUD`.
6. Удалите переадресацию `vapi-control/` с GoDaddy; при желании выключите workers.dev
   (`"workers_dev": false`).

**Вариант C (текущий план): `https://www.vivpod.com/vapi-control/`.** vivpod.com — DNS у
GoDaddy, сайт — Express на Railway (`www` → `web-production-ea90e.up.railway.app`), почта —
timeweb. Консоль подключается узким маршрутом Worker, остальной сайт идёт на Railway как раньше.
1. Cloudflare → Add a domain → `vivpod.com` → Free. Сверьте импортированные записи (всё, кроме
   apex, — «DNS only», серое облако, кроме `www`):
   - `CNAME www → web-production-ea90e.up.railway.app` — **Proxied** (оранжевое облако);
   - `TXT _railway-verify.www` (railway-verify=…);
   - `MX @ mx1.timeweb.ru (10)`, `MX @ mx2.timeweb.ru (20)`;
   - `TXT @ v=spf1 include:_spf.timeweb.ru ~all`, `TXT dkim._domainkey …`, `TXT _dmarc v=DMARC1;p=none`;
   - `A mail 198.12.236.208`; прочие TXT @ (google-site-verification, afternic и т. п.);
   - apex: GoDaddy-переадресация (A 3.33.251.168 / 15.197.225.128) после смены NS работать
     перестанет → удалить эти A, добавить `A @ 192.0.2.1` **Proxied** и Rules → Redirect Rules:
     hostname = `vivpod.com` → `https://www.vivpod.com${uri}` (301, сохранить query).
2. SSL/TLS → **Full (strict)** (Railway отдаёт настоящий сертификат; Flexible даст бесконечный редирект).
3. GoDaddy → vivpod.com → Nameservers → Custom → два NS от Cloudflare. Ждать статуса Active.
4. Zero Trust → Access → Applications → Add → Self-hosted: домен `www.vivpod.com`, path
   `vapi-control`, политика Allow → Emails → ваш email. Его AUD дописать в `POLICY_AUD`
   через запятую (старый оставить, пока работает workers.dev).
5. В `wrangler.jsonc` раскомментировать `routes` (www.vivpod.com/vapi-control*) → `npm run deploy`.
6. На телефоне/компьютере открыть новую консоль, установить приложение и включить Alerts заново
   (установка и push-подписка привязаны к адресу сайта). Старую установку можно удалить.

## 11. Cloudflare Access

### 11.1 Вариант A — workers.dev (работает сейчас)
1. **Zero Trust:** https://one.dash.cloudflare.com → при первом входе выберите team name
   (например, `kidletto` → `https://kidletto.cloudflareaccess.com`) и план **Free**.
   Вход по одноразовому коду на email (One-time PIN) включён по умолчанию.
2. **Workers & Pages → kidletto-vapi-control → Settings → Domains & Routes →
   workers.dev → Enable Cloudflare Access.**
3. **Manage Cloudflare Access** → политика `kidletto-vapi-control - Production` →
   Action **Allow**, Include → **Emails** → ваш email. Удалите прочие правила (Everyone и т. п.).
4. **`TEAM_DOMAIN`** и **`POLICY_AUD`** для этого аккаунта уже прописаны в
   `wrangler.jsonc`. Оба значения видны в публичном redirect'е на страницу входа:
   домен — в `Location`, AUD — в параметре `kid`. Для другого аккаунта замените их
   там же или задайте в дашборде (Settings → Variables and Secrets → Text).
5. Рекомендуется добавить **`ALLOWED_EMAILS`** = ваш email (Text). Пока её нет,
   консоль работает, но показывает в шапке жёлтый значок «Security notice».
   Точный email своей Access-личности видно в шапке консоли после входа.
6. **Не включайте Access** для `kidletto-vapi-control-webhook` — Vapi должен до него
   достучаться; он защищён собственным секретом.

### 11.2 Вариант B — kidletto.com/vapi-control (после переноса DNS)
Zero Trust → Access controls → Applications → Add an application → **Self-hosted** →
Domain `kidletto.com`, Path `vapi-control` → Policy Allow / Emails → ваш email.
Скопируйте AUD и допишите в `POLICY_AUD` через запятую.

### 11.3 Живой транскрипт (Vapi Server URL)
1. Сгенерируйте секрет: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
2. Cloudflare → **kidletto-vapi-control-webhook** → Settings → Variables and Secrets →
   Secret `VAPI_WEBHOOK_SECRET` = этот секрет → Deploy.
3. Vapi → **Integrations → Server Configuration → Add Custom Credential → Bearer Token**:
   Credential Name — любое (например `Kidletto Control Webhook`), Token — тот же секрет,
   Header Name — `Authorization`, Include Bearer Prefix — включить. Save.
4. Vapi → **Assistants → Thumbtack → Advanced → Webhook Server**:
   Server URL = `https://kidletto-vapi-control-webhook.geofakt.workers.dev/vapi/events`,
   Authorization → Credential = созданный credential. Publish.
5. Server Messages по умолчанию уже содержат `conversation-update`, `status-update`,
   `speech-update`. Для interim-фраз («печатается на лету») добавьте `transcript`.

Server URL ассистента перекрывает организационный (приоритет:
assistant → phone number → organization). То есть события **этого** ассистента
пойдут только в консоль, а остальные ассистенты продолжат слать их туда, куда
слали раньше. Если нужно и то, и другое, задайте секрет `WEBHOOK_FORWARD_URL`
с прежним URL — Worker перешлёт каждое событие без изменений и вернёт Vapi ответ
того сервера.

## 12. Тестирование

```bash
cd vapi-control-worker
npm test              # unit + integration + ui
npm run test:unit     # 47 тестов: JWT, санитизация, CORS, логи, транскрипт, аудио, таймер, Web Push (вектор RFC 8291)
npm run test:integration   # 31 проверка: оба Worker в workerd + мок Vapi/Workers AI/push-сервиса + реальная проверка JWT
npm run test:ui       # 23 проверки в headless Chrome (нужен Chrome или Edge; фейковый микрофон Chrome для DICTATE)
```

Результаты и скриншоты — `test-results/` (в `.gitignore`).

**Ручная проверка на живом звонке** (обязательна: мок не заменяет телефонию):
1. Позвоните на номер Vapi. Откройте консоль: звонок выбран сам, `● ACTIVE`, таймер
   совпадает с длительностью звонка на телефоне.
2. Говорите — реплики появляются в LIVE TRANSCRIPT (после §11.3).
3. LISTEN — слышны обе стороны; формат показан рядом с Format. Браузер не спрашивает микрофон.
4. EXACT SAY «I have a few other offers. I'll think about it.» — на телефоне звучит дословно голосом Ara.
5. AI INSTRUCTION «Спроси его, это окончательная цена?» — бот задаёт вопрос по-английски.
6. Быстрые фразы; «Goodbye + Hang Up» — двойной клик.
7. SAY & HANG UP — фраза звучит полностью, затем звонок обрывается; консоль: CALL ENDED → NO ACTIVE CALL.
8. Новый звонок → END CALL → Cancel (ничего) → End Call (звонок завершён).
9. Повесьте трубку сами — консоль показывает CALL ENDED с причиной.
10. Два звонка одновременно — список, ничего не выбирается само, команды идут выбранному.
11. Проверьте, что Telegram-отчёты по-прежнему приходят (пересылка).

## 13. Troubleshooting

| Симптом | Причина / действие |
| --- | --- |
| «Control panel not configured» (503) | не задана переменная `TEAM_DOMAIN` |
| Жёлтый значок «Security notice» | не заданы `POLICY_AUD` и/или `ALLOWED_EMAILS` (наведите курсор — покажет, что именно) |
| «Not authorized» (403) | email не в `ALLOWED_EMAILS` или AUD другого приложения |
| Cloudflare Access: «That account does not have access.» | до Worker дело не дошло — не сошлась политика Access. Частая причина: в правиле выбран селектор **Emails ending in** (домен), а вписан полный адрес — Cloudflare превращает это в `@you@example.com`, что не совпадает ни с чем. Нужен селектор **Emails** с точным адресом. Проверить: Zero Trust → Access controls → Applications → приложение → **Policy tester**, он покажет, какое правило не сошлось |
| На странице входа только «Sign in with: Cloudflare» | добавьте **One-time PIN**: Zero Trust → Settings → Authentication → Login methods → Add new → One-time PIN. Тогда код придёт на любой разрешённый email |
| «Missing Cloudflare Access credentials» (401) | Access не включён на hostname — запрос пришёл в обход логина |
| «Session expired» в консоли | перезагрузите страницу, войдите через Access |
| «Vapi rejected the server API key» | неверный `VAPI_API_KEY` (нужен **private** key) |
| Звонок виден, LISTEN/команды недоступны | звонок ещё `ringing`, или в `monitorPlan` выключены listen/control |
| «Events: offline» / нет транскрипта | не настроен §11.3; проверьте `wrangler tail kidletto-vapi-control-webhook` |
| Искажённый звук | выберите формат вручную (Format) |
| Нужны и Telegram-отчёты, и консоль | задайте секрет `WEBHOOK_FORWARD_URL` = прежний Server URL |
| Нет кнопки «🔔 Alerts» | не задан секрет `VAPID_PRIVATE_KEY` (или `VAPID_PUBLIC_KEY`) |
| Оповещения не приходят при закрытой консоли | «🔔 Alerts» → Send test alert. iPhone: только из приложения на экране «Домой». Windows: разрешить уведомления Chrome/Edge в Параметры → Система → Уведомления; браузер должен работать в фоне. Лог: событие `push_sent` |
| DICTATE: «Microphone access is blocked» | разрешить микрофон для сайта (значок замка у адреса) |
| DICTATE: «Dictation is not configured» | нет binding `AI` в `wrangler.jsonc` |
| Перевод недоступен | фраза уходит модели ассистента (как раньше), в консоли — предупреждение; лог `control_command_failed`/ошибка `translate_failed` |
| Логи | `npx wrangler tail kidletto-vapi-control` или Dashboard → Workers → Logs |

## 14. Известные ограничения

- **DTMF от оператора Vapi не поддерживает.** Возможен только через встроенный
  инструмент ассистента `dtmf`: клавишу «нажимает» модель по инструкции, поэтому
  возможны задержка, отказ или повтор; надёжность зависит от IVR и провайдера телефонии
  (Vapi рекомендует паузы `w`/`W`). Эмуляции тонами в браузере или озвучивания цифр нет.
- Живой транскрипт требует Server URL (§11.3); `GET /call` транскрипт во время звонка не отдаёт.
- Формат listen-аудио Vapi не документирован; автоопределение + ручной выбор.
- Серверный лог фиксирует установку listen-соединения; обрыв виден в консоли
  (Reconnecting/Error), а не в логе Worker: поток проксируется runtime без JS.
- `say` с `interruptAssistant=false` (по умолчанию) ставится в очередь после текущей речи бота.
- Оповещения используют системный звук уведомлений устройства; свой рингтон браузеры для
  web-уведомлений не позволяют. На iPhone web push работает только для консоли, добавленной
  на экран «Домой» (iOS 16.4+). На компьютере браузер должен быть запущен (хотя бы в фоне).
- Перевод выполняет LLM: смысл, числа и имена сохраняются, но формулировка может быть
  не дословной. Произнесённая английская фраза всегда видна в консоли.
- Режим оператора: между фразами ассистент заглушён; повторное глушение делает сервер по
  событию `speech-update` (или по оценке длительности, если событий нет).
- Список звонков смотрит на 3 часа назад (`LOOKBACK_MS` в `src/calls.js`).
- Пока kidletto.com не в Cloudflare, адрес консоли — `*.workers.dev` (вход с kidletto.com — переадресацией).
