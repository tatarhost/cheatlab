<p align="center">
  <img src="public/og.png" width="640" alt="CHEATLAB">
</p>

# CHEATLAB

Анонимная площадка для публикации **скриптов, кода, изображений, видео и любых
файлов**. Без регистрации, без входа, без OAuth и без внешних сервисов: браузер
сам генерирует идентификатор устройства, API выдаёт ключ редактирования при
публикации, и больше ничего не требуется.

Чёрно-белый интерфейс: один акцент — чёрный, никаких градиентов, скруглений и
эмодзи, только линейные иконки.

Размещено бесплатно: статика на **GitHub Pages**, API на **Cloudflare Workers**,
метаданные в **D1**, файлы в **R2**. Ноль зависимостей во фронтенде, ноль
зависимостей в Worker.

| | |
| --- | --- |
| ![Лента](docs/feed.png) | ![Публикация](docs/item.png) |
| ![Форма публикации](docs/publish.png) | ![Статистика](docs/stats.png) |

---

## Что умеет

- Шесть типов публикаций: скрипт, приложение, паста, изображение, видео, файл.
- Файлы адресуются по содержимому: два одинаковых файла занимают место один раз.
- Изображения показываются в ленте и на странице публикации с подписью и
  кнопкой скачивания.
- Видео отдаётся с поддержкой `Range` и перемотки, аудио — плеером.
- Просмотр исходника, скачивание, счётчик просмотров, теги, поиск, сортировка.
- Свои публикации на странице «Мои загрузки», экспорт и импорт ключей.
- Виджет `embed.js` для встраивания в чужие сайты.
- Никаких гейтов: страна, ASN, VPN и тип подключения не влияют на доступ.

---

## Архитектура

```
public/                статика для GitHub Pages (vanilla, без сборки)
  index.html           разметка и спрайт иконок
  app.js               SPA: роуты, формы, лента, публикация
  style.css            чёрно-белая тема
  embed.js             виджет для чужих сайтов
  og.png               превью для ссылок

worker/                Cloudflare Worker — единственный бэкенд
  src/index.js         маршруты, CORS, лимиты, Range
  src/store.js         D1: items, files, clients, rate
  src/blobs.js         R2: байты по SHA-256, дедупликация
  src/plugins.js       хост плагинов
  src/util.js          id, секреты, хеши, mime, имена файлов
  plugins/             upload-guard, denylist, webhooks
  schema.sql           схема D1
  migrations/          миграции для wrangler d1 execute
  test/                142 теста на локальных шимах D1 и R2

scripts/set-api-url.mjs   вписывает адрес Worker в public/index.html
tools/screens.py          рисует og.png и скриншоты из docs/
```

Фронтенд не знает, где живёт API: он читает `<meta name="cheatlab-api">` в
`public/index.html`. Пустое значение означает «тот же origin», поэтому сайт
работает и локально, и за прокси, который раздаёт всё с одного хоста.

---

## Развёртывание

### 1. API

```bash
cd worker
npm install

npx wrangler login
npx wrangler d1 create cheatlab          # вписать database_id в wrangler.toml
npx wrangler r2 bucket create cheatlab

npx wrangler d1 execute cheatlab --file=./migrations/0001_init.sql
npx wrangler deploy
```

`wrangler.toml` содержит два места для ручной правки:

```toml
[[d1_databases]]
database_name = "cheatlab"
database_id   = "REPLACE_WITH_D1_DATABASE_ID"   # ← из вывода wrangler d1 create

[[r2_buckets]]
bucket_name = "cheatlab"                        # ← имя созданного бакета
```

Настройки (все — обычные `vars`, секретов нет):

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `SITE_URL` | `https://tatarhost.github.io/cheatlab` | куда `PLUGINS` и ссылки ведут на этот хост |
| `ALLOW_ORIGIN` | `*` | значение `Access-Control-Allow-Origin` |
| `MAX_FILE_MB` | `25` | лимит одного файла |
| `MAX_TEXT_KB` | `256` | лимит текста публикации |
| `MAX_FILES` | `20` | файлов на публикацию |
| `MAX_WRITE_RPM` | `30` | записей в минуту на устройство |
| `MAX_READ_RPM` | `240` | чтений в минуту |
| `CL_DENY_EXT` | — | `exe,scr,vbs` — запретить расширения |
| `CL_DENY_SHA` | — | список SHA-256 для блокировки |
| `CL_WEBHOOK_URL` | — | адрес для уведомлений о публикациях |

### 2. Сайт

```bash
node scripts/set-api-url.mjs https://cheatlab.<ваш-поддомен>.workers.dev
git commit -am "point the site at the deployed API"
git push
```

Дальше срабатывает `.github/workflows/pages.yml`: он публикует каталог
`public/` через `actions/deploy-pages`. API при этом не трогается — он живёт в
Cloudflare.

Чтобы стереть адрес и вернуть same-origin:

```bash
node scripts/set-api-url.mjs
```

### Бесплатно

Cloudflare Free-тариф покрывает эту нагрузку с запасом: 100 000 запросов
Workers в сутки, 5 млн строк чтения и 100 000 строк записи D1 в сутки, 5 ГБ
базы, около 10 ГБ-месяц хранения R2 и **бесплатный исходящий трафик** — то есть
скачивание файлов и видео не тарифицируется.

---

## Идентичность без регистрации

1. При первом визите `app.js` генерирует 24 случайных байта, кладёт
   `cheatlab.client` в `localStorage` и отправляет их в заголовке
   `x-cheatlab-client` с каждым запросом.
2. Публикация возвращает `secret`. Он кладётся в `localStorage`
   (`cheatlab.keys`) и больше нигде не хранится: в базе лежит только
   `sha256(secret)`.
3. Изменение и удаление требуют `x-cheatlab-secret`. Чужой `client` без секрета
   не проходит.

Публичный API никогда не отдаёт `author` в исходном виде — только шестизначный
тег `sha256(id)[:6]`. Ключи можно экспортировать и импортировать на странице
«Мои загрузки», чтобы не потерять доступ при очистке данных браузера.

---

## API

Все ответы — JSON. Заголовок `x-cheatlab-client` обязателен для записи.

| Метод | Путь | Что делает |
| --- | --- | --- |
| `GET` | `/api/config` | типы, языки, лимиты, загруженные плагины |
| `GET` | `/api/stats` | счётчики хранилища |
| `GET` | `/api/plugins` | список серверных плагинов и их хуков |
| `GET` | `/api/items` | лента: `type`, `q`, `tag`, `author`, `sort`, `limit`, `offset` |
| `POST` | `/api/items` | создать; возвращает `{ item, secret }` |
| `GET` | `/api/items/:id` | полная публикация с `body` |
| `PATCH` | `/api/items/:id` | изменить; нужен `x-cheatlab-secret` |
| `DELETE` | `/api/items/:id` | удалить публикацию и её файлы |
| `POST` | `/api/items/:id/files` | загрузить файл (нужен `x-cheatlab-client` автора) |
| `DELETE` | `/api/files/:id` | удалить файл |
| `GET` | `/api/me` | свои публикации и файлы |
| `GET` | `/f/:fileId` | скачать вложение (`Content-Disposition: attachment`) |
| `GET` | `/f/:fileId/raw` | открыть в браузере, поддерживает `Range` и `ETag` |
| `GET` | `/m/:itemId` | медиа публикации: изображение, видео или аудио целиком |
| `GET` | `/r/:itemId` | сырой текст без интерфейса |

`/m/:id` и `/f/:id/raw` отдают `206 Partial Content` на запрос с `Range`, так что
видео перематывается без загрузки целиком, и `304` при совпадении `ETag`.

### Загрузка файла

Тело запроса — сами байты, имя — в заголовке. Multipart не разбирается:

```bash
curl -X POST https://cheatlab.example.workers.dev/api/items/abc12345/files \
  -H "x-cheatlab-client: <ваш client id>" \
  -H "x-filename: aimbot.lua" \
  --data-binary @aimbot.lua
```

Имя кодируется в URL-безопасную строку, сервер декодирует и чистит. Размер
проверяется на лету: файл больше лимита не пишется в R2 целиком.

Пример создания пасты:

```bash
curl -X POST https://cheatlab.example.workers.dev/api/items \
  -H "content-type: application/json" \
  -H "x-cheatlab-client: <ваш client id>" \
  -d '{"type":"paste","title":"хоткейы","body":"F6 — toggle"}'
```

`GET /api/*` отдаётся с `Access-Control-Allow-Origin: *` и отвечает на
`OPTIONS`, поэтому API можно дёргать с любой страницы.

---

## Серверные плагины

Плагин — модуль в `worker/plugins/`, зарегистрированный в `worker/src/plugins.js`.
Динамического `import()` по имени файла в Workers нет, поэтому список статический:

```js
export default {
  name: 'my-plugin',
  description: 'что делает',
  hooks: {
    async 'file:upload'(file, ctx) {
      if (file.size > 1e9) throw reject('слишком большой');
      return { ...file, mime: 'application/octet-stream' };
    },
  },
};
```

| Хук | Когда | Значение |
| --- | --- | --- |
| `item:create` | перед записью в базу | черновик публикации; `throw reject()` → 422 |
| `item:published` | после создания | публичное представление |
| `item:update` | после PATCH | публичное представление |
| `item:delete` | после удаления | публичное представление |
| `file:upload` | **до** записи байт в R2 | `{ id, item_id, name, mime }` |
| `file:stored` | после записи | файл с `size` и `sha256`; `throw reject()` откатывает и строку, и объект |
| `file:delete` | после удаления | файл |

`reject(reason)` из `worker/src/plugins.js` помечает ошибку как намеренный отказ;
любая другая ошибка тоже превращается в отказ, но с пометкой `plugin error`.
Возвращённый объект заменяет значение для следующих плагинов. Хуки выполняются
в порядке регистрации. Ошибка в одном плагине не роняет запрос — все отказы
собираются в поле `reasons` ответа.

Что уже установлено:

- **upload-guard** — отсекает пустые имена, пути, управляющие символы и
  непригодные расширения. Любое расширение, которое можно осмысленно назвать,
  проходит: белого списка нет, политика живёт в denylist.
- **denylist** — расширения и хеши из `CL_DENY_EXT` / `CL_DENY_SHA`. По
  умолчанию пуст: решать, что блокировать, оператору, а не коду.
- **webhooks** — POST на `CL_WEBHOOK_URL` при публикации и удалении.

Список и хуки видны на `/stats` и `/api/plugins`.

---

## Плагин для сайтов: `embed.js`

Виджет публикации для любой страницы. Сборка, бэкенд и учётные записи не нужны:

```html
<div class="cheatlab-embed" data-title="Мой скрипт">код, который хочу опубликовать</div>
<script src="https://tatarhost.github.io/cheatlab/embed.js"
        data-api="https://cheatlab.example.workers.dev"
        data-site="https://tatarhost.github.io/cheatlab"
        data-language="luau"
        defer></script>
```

Атрибуты: `data-api` (обязателен), `data-site` (хост сайта, если он отличается
от API), `data-target` (селектор контейнера), `data-language`, `data-label`, а на
самом контейнере — `data-title` и `data-content` для предзаполнения. Виджет
берёт тот же `client id` из `localStorage`, сохраняет выданный ключ рядом с
ключами сайта и показывает ссылку на публикацию.

---

## Хранилище

Файлы адресуются по содержимому: ключ R2 — `blobs/<aa>/<bb>/<sha256>`. Одинаковые
байты хранятся один раз, удаление публикации убирает объект, только если на эти
байты не ссылается больше ни одна строка.

Если понадобится другое хранилище, реализуйте те же четыре метода, что у
`BlobStore` в `worker/src/blobs.js`:

```js
put(readable, maxBytes)   // -> { sha, size, deduped }
get(sha, range)           // -> ReadableStream
head(sha)                 // -> { size, etag } | null
remove(sha)
```

База при этом остаётся D1.

### Резервная копия

У D1 есть встроенный **Time Travel** — 30 дней истории, откат в пару кликов и без
выгрузки:

```bash
# откатить метаданные на момент в прошлом (принимает unix-время или RFC3339)
npx wrangler d1 time-travel restore cheatlab --timestamp=2026-09-01T08:46:42Z
```

Для переносимой копии — обычный дамп:

```bash
npx wrangler d1 export cheatlab --remote --output backup.sql
```

Файлы в R2 — через репликацию бакета: в панели Cloudflare у бакета `cheatlab`
включается **Replication** на второй бакет. Трафик между бакетами R2 не
тарифицируется, копия появляется автоматически. Wrangler умеет только
`r2 object get/put/delete` для одиночных объектов, массовой выгрузки в нём нет —
для разовых задач бакет подключают через S3-совместимый API (`rclone`, `aws s3`).

Восстановление: создать пустой D1, выполнить `backup.sql`, затем положить объекты
обратно в R2 тем же путём. Благодаря адресации по содержимому порядок не важен.

---

## Тесты

```bash
cd worker
npm test
```

142 проверки на локальных шимах: D1 эмулируется через `node:sqlite`, R2 — через
in-memory binding с поддержкой `Range`. Реальный Cloudflare runtime проверяется
только деплоем; тесты ловят логику, маршруты и дедупликацию, но не поведение
платформы.

---

## Что ограничено, а что нет

Не ограничено: страна, ASN, VPN, тип подключения, репутация IP. Запросы
проходят одинаково откуда угодно, включая мобильные операторы и приватные VPN.

Ограничено: частота записи (30 в минуту на устройство), частота чтения
(240 в минуту), размер файла, размер текста, число файлов на публикацию,
структура имени файла и то, что разрешают плагины.

---

Иконки — [Lucide](https://lucide.dev) 1.38.0, лицензия ISC; геометрия перенесена
в спрайт `public/index.html`, поэтому внешних загрузок нет и строгая CSP не
нарушается.
