# Vapi Live Control — приватная операторская консоль

Консоль для наблюдения за активными звонками существующего Vapi-ассистента
(Deepgram Nova 3 → GPT-5 → xAI Ara) и ручного управления ими.
Ассистент, его модель, голос и транскрайбер **не изменяются** этим проектом.

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
- LISTEN — живое аудио звонка (`monitor.listenUrl`), без доступа к микрофону.
- EXACT SAY — фраза произносится дословно голосом ассистента (`say`), Ctrl+Enter.
- SAY & HANG UP — фраза, затем завершение звонка штатным `endCallAfterSpoken` (без таймеров JS).
- AI INSTRUCTION — инструкция модели только для текущего звонка (`add-message`, role `system`); можно писать по-русски.
- QUICK PHRASES — настраиваемые кнопки (`vapi-control/config.js`).
- END CALL — с подтверждением (`end-call`).
- DTMF — см. §4 и §14: прямой DTMF от оператора Vapi **не поддерживает**; клавиатура включается только если у ассистента есть встроенный инструмент `dtmf`.

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
  js/format.js
vapi-control-worker/
  src/index.js                Worker консоли: роутинг, API, прокси listen
  src/auth.js                 проверка Cloudflare Access JWT (RS256, WebCrypto)
  src/vapi.js                 клиент Vapi API / controlUrl / listenUrl
  src/calls.js                фильтры звонков, санитизация, DTMF-возможности
  src/hub.js                  Durable Object CallHub (живые события → браузеры)
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
| GET | `calls` | активные звонки (без monitor URL, промптов, стоимости) |
| GET | `calls/:id` | один звонок + возможности (control/listen/dtmf) |
| POST | `calls/:id/say` | `{text, endCallAfterSpoken?, interruptAssistant?}` |
| POST | `calls/:id/instruction` | `{text}` |
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
npm run test:unit     # 41 тест: JWT, санитизация, CORS, логи, транскрипт, аудио, таймер
npm run test:integration   # 26 проверок: оба Worker в workerd + мок Vapi + реальная проверка JWT
npm run test:ui       # 16 проверок в headless Chrome (нужен Chrome или Edge)
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
| Cloudflare Access: «That account does not have access.» | до Worker дело не дошло — не сошлась политика Access. Zero Trust → **Logs → Access** покажет, какой именно email пришёл и какая политика сработала. Обычно email в политике не совпадает с тем, что вернул способ входа |
| На странице входа только «Sign in with: Cloudflare» | добавьте **One-time PIN**: Zero Trust → Settings → Authentication → Login methods → Add new → One-time PIN. Тогда код придёт на любой разрешённый email |
| «Missing Cloudflare Access credentials» (401) | Access не включён на hostname — запрос пришёл в обход логина |
| «Session expired» в консоли | перезагрузите страницу, войдите через Access |
| «Vapi rejected the server API key» | неверный `VAPI_API_KEY` (нужен **private** key) |
| Звонок виден, LISTEN/команды недоступны | звонок ещё `ringing`, или в `monitorPlan` выключены listen/control |
| «Events: offline» / нет транскрипта | не настроен §11.3; проверьте `wrangler tail kidletto-vapi-control-webhook` |
| Искажённый звук | выберите формат вручную (Format) |
| Нужны и Telegram-отчёты, и консоль | задайте секрет `WEBHOOK_FORWARD_URL` = прежний Server URL |
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
- Список звонков смотрит на 3 часа назад (`LOOKBACK_MS` в `src/calls.js`).
- Пока kidletto.com не в Cloudflare, адрес консоли — `*.workers.dev` (вход с kidletto.com — переадресацией).
