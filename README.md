# CHEATLAB

Анонимная площадка для публикации скриптов, паст и файлов. Без регистрации, без
входа, без OAuth и без внешних сервисов: браузер сам генерирует идентификатор
устройства, сервер выдаёт ключ редактирования при публикации.

Чёрно-белый интерфейс: один акцент — чёрный, никаких градиентов, скруглений и
эмодзи, только линейные иконки.

Ноль зависимостей. Только Node 22.5+ (`node:http`, `node:sqlite`).

---

## Запуск

```bash
cd cheatlab
npm start                 # http://localhost:8787
```

`npm run dev` — то же самое с автоперезапуском.

### Переменные окружения

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `PORT` | `8787` | порт |
| `HOST` | `0.0.0.0` | интерфейс |
| `CL_DATA_DIR` | `./data` | база и файлы |
| `CL_MAX_FILE_MB` | `25` | лимит одного файла |
| `CL_MAX_TEXT_KB` | `256` | лимит текста публикации |
| `CL_MAX_FILES` | `20` | файлов на публикацию |
| `CL_DENY_EXT` | — | `exe,scr,vbs` — запретить расширения |
| `CL_DENY_SHA` | — | список SHA-256 для блокировки |
| `CL_WEBHOOK_URL` | — | адрес для уведомлений о публикациях |

Никаких `CL_ALLOW_*` флагов не существует: доступ не зависит от страны, ASN,
VPN или типа сети. Единственное ограничение — частота запросов.

---

## Устройство

```
server.mjs            маршруты, лимиты, отдача статики
lib/util.mjs          id, секреты, хеши, mime, разбор имён файлов
lib/store.mjs         SQLite: items, files, clients
lib/blobs.mjs         файлы по содержимому: data/blobs/aa/bb/<sha256>
lib/plugins.mjs       загрузчик серверных плагинов
plugins/*.mjs         upload-guard, denylist, webhooks
public/               интерфейс (vanilla, без сборки)
public/embed.js       виджет для встраивания в чужие сайты
tools/seed.mjs        демонстрационные публикации
```

Данные лежат в `data/`: `cheatlab.db` (SQLite в режиме WAL) и `blobs/` с
файлами, названными по SHA-256. Два одинаковых файла занимают место один раз.

Иконки — [Lucide](https://lucide.dev) 1.38.0, лицензия ISC; геометрия
перенесена в спрайт `public/index.html`, поэтому внешних загрузок нет и строгая
CSP не нарушается.

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
| `GET` | `/f/:fileId` | скачать вложение |
| `GET` | `/f/:fileId/raw` | открыть в браузере, поддерживает `Range` |
| `GET` | `/r/:itemId` | сырой текст без интерфейса |

### Загрузка файла

Тело запроса — сами байты, имя — в заголовке. Multipart не разбирается:

```bash
curl -X POST http://localhost:8787/api/items/abc12345/files \
  -H "x-cheatlab-client: <ваш client id>" \
  -H "x-filename: aimbot.lua" \
  --data-binary @aimbot.lua
```

Имя кодируется в URL-безопасную строку, сервер декодирует и чистит. Размер
проверяется на лету: файл больше лимита не пишется на диск целиком.

Пример создания пасты:

```bash
curl -X POST http://localhost:8787/api/items \
  -H "content-type: application/json" \
  -H "x-cheatlab-client: <ваш client id>" \
  -d '{"type":"paste","title":"хоткейы","body":"F6 — toggle"}'
```

`GET /api/*` отдаётся с `Access-Control-Allow-Origin: *`, поэтому API можно
дёргать с любой страницы.

---

## Серверные плагины

Файл `.mjs` в `plugins/` с default-экспортом:

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
| `file:upload` | **до** записи байт на диск | `{ id, item_id, name, mime }` |
| `file:stored` | после записи | файл с `size` и `sha256`; `throw reject()` откатывает и строку, и файл |
| `file:delete` | после удаления | файл |

`reject(reason)` из `lib/plugins.mjs` помечает ошибку как намеренный отказ;
любая другая ошибка тоже превращается в отказ, но с пометкой `plugin error`.
Возвращённый объект заменяет значение для следующих плагинов. Хуки
выполняются по алфавиту имён файлов. Ошибка в одном плагине не роняет запрос —
все отказы собираются в поле `reasons` ответа.

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
<script src="https://cheatlab.example/embed.js"
        data-api="https://cheatlab.example"
        data-language="luau"
        defer></script>
```

Атрибуты: `data-api` (обязателен), `data-target` (селектор контейнера),
`data-language`, `data-label`, а на самом контейнере — `data-title` и
`data-content` для предзаполнения. Виджет берёт тот же `client id` из
`localStorage`, сохраняет выданный ключ рядом с ключами сайта и показывает
ссылку на публикацию.

---

## Хранилище

Файлы адресуются по содержимому: `data/blobs/<aa>/<bb>/<sha256>`. Одинаковые
байты хранятся один раз, удаление публикации убирает файл, только если на эти
байты не ссылается больше ни одна строка.

Чтобы унести файлы в S3, CDN или bucket, реализуйте те же четыре метода, что у
`BlobStore` в `lib/blobs.mjs`:

```js
put(readable, maxBytes)   // -> { sha, size, deduped }
createReadStream(sha, range)
readBuffer(sha)
remove(sha)
```

База при этом остаётся SQLite.

---

## Развёртывание

За nginx или Caddy: статику можно отдать напрямую, `/api`, `/f`, `/r` — на
Node. `server.keepAliveTimeout` и `headersTimeout` стоит поднять, если за
прокси большие загрузки.

systemd-юнит:

```ini
[Unit]
Description=cheatlab
After=network.target

[Service]
WorkingDirectory=/srv/cheatlab
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.mjs
Environment=PORT=8787
Environment=CL_MAX_FILE_MB=25
Restart=always
User=cheatlab

[Install]
WantedBy=multi-user.target
```

Резервная копия — это каталог `data/`: остановить сервис, скопировать
`cheatlab.db*` и `blobs/`, запустить обратно.

---

## Что ограничено, а что нет

Не ограничено: страна, ASN, VPN, тип подключения, репутация IP. Запросы
проходят одинаково откуда угодно, включая мобильные операторы и приватные VPN.

Ограничено: частота записи (30 в минуту на устройство), частота чтения
(240 в минуту), размер файла, размер текста, число файлов на публикацию,
структура имени файла и то, что разрешают плагины.
