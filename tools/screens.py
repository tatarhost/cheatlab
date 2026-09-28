"""
Generates the repository imagery:

  public/og.png       1280x640 social preview, used for link unfurls and as the
                      og:image of the deployed site
  docs/feed.png       the main feed across all six post types
  docs/item.png       a publication page: media preview, file table, raw body
  docs/publish.png    the publish form with media types and the drop zone
  docs/stats.png      the public counters panel

Run:  python tools/make_images.py
"""

import os
from PIL import Image, ImageDraw
from make_images import (
    INK, PAPER, FOG, LINE, MUTE, RAIL, CODE_BG, CODE_FG,
    mono, sans, text, line, vline, wrap, icon, app_chrome, row, canvas, save, ROOT,
)


# --------------------------------------------------------------------- og.png

def make_og():
    W, H = 1280, 640
    d = canvas(W, H, INK)

    # hairline grid, the same drafting feel as the site chrome
    for x in range(0, W + 1, 80):
        vline(d, x, 0, H, (26, 26, 26), 1)
    for y in range(0, H + 1, 80):
        line(d, 0, y, W, (26, 26, 26), 1)

    m = 72

    # mark
    d.rectangle([m, m, m + 52, m + 52], fill=PAPER)
    text(d, (m + 26, m + 26), "C", mono(28, True), INK, anchor="mm")

    text(d, (m, m + 92), "CHEAT", mono(128, True), PAPER)
    w_ct = d.textlength("CHEAT", font=mono(128, True))
    text(d, (m + w_ct, m + 92), "LAB", mono(128, True), (110, 110, 110))

    line(d, m, 300, W - m, (48, 48, 48), 2)

    sub = "Скрипты, код, изображения, видео и любые файлы"
    text(d, (m, 322), sub, mono(27), (208, 208, 208))

    sub2 = "Анонимная публикация. Без регистрации и входа."
    text(d, (m, 366), sub2, mono(27), (140, 140, 140))

    # type strip
    types = [("code", "Скрипты"), ("clip", "Пасты"), ("image", "Изображения"),
             ("video", "Видео"), ("file", "Файлы")]
    x = m
    for name, label in types:
        icon(d, name, x, 448, 20, (170, 170, 170), 1.6)
        tw = d.textlength(label, font=mono(20, True))
        text(d, (x + 30, 447), label, mono(20, True), PAPER)
        x += 30 + tw + 44
        if x < W - m - 40:
            d.line([(x - 22, 446), (x - 22, 468)], fill=(64, 64, 64), width=1)

    # stack of hosting labels, bottom right
    y = 552
    for label, col in [("GitHub Pages", (150, 150, 150)),
                       ("Cloudflare Workers", (120, 120, 120)),
                       ("D1 + R2", (90, 90, 90))]:
        tw = d.textlength(label, font=mono(15))
        text(d, (W - m - tw, y), label, mono(15), col)
        y += 26

    text(d, (m, 552), "Бесплатный тариф, без VPS и оплаты за трафик", mono(17), (120, 120, 120))

    out = os.path.join(ROOT, "public", "og.png")
    return save(d, out)


# ------------------------------------------------------------------- feed.png

def make_feed():
    W, H = 1280, 860
    d = canvas(W, H, PAPER)

    x, y = app_chrome(d, W, H, "/", "поиск по названию, тегу, коду")

    text(d, (x, y), "Публикации", sans(30, True), INK)
    text(d, (x, y + 44), "Всё, что опубликовали пользователи.", sans(14), MUTE)

    # sort tabs
    tb = [x + W - x - 300, y - 4]
    d.rectangle([tb[0], tb[1], tb[0] + 300, tb[1] + 34], outline=LINE, width=1)
    d.rectangle([tb[0], tb[1], tb[0] + 150, tb[1] + 34], fill=INK)
    text(d, (tb[0] + 75, tb[1] + 8), "Новые", sans(13, True), PAPER, anchor="ma")
    text(d, (tb[0] + 225, tb[1] + 8), "Популярные", sans(13), INK, anchor="ma")

    y += 84
    w = W - x - 24
    rows = [
        ("code", "Aimbot для лестницы", [("user", "icon"), ("a3f91c", ""), ("eye", "icon"), ("1284", ""), ("Lua", ""), ("2 / 14.2 KB", "")], "2 мин", ["executor", "roblox"], False),
        ("image", "Карта переходников", [("user", "icon"), ("7c02be", ""), ("eye", "icon"), ("311", ""), ("1 / 1.8 MB", "")], "9 мин", ["schematic"], True),
        ("video", "Трейк: как это работает", [("user", "icon"), ("4e51d0", ""), ("eye", "icon"), ("96", ""), ("1 / 24.6 MB", "")], "24 мин", ["tutorial"], False),
        ("clip", "Конфиг для тёмной темы", [("user", "icon"), ("91bb07", ""), ("eye", "icon"), ("48", ""), ("1 / 320 B", "")], "1 ч", [], False),
        ("box", "Сборка 0.9.2 (apk)", [("user", "icon"), ("2d60fa", ""), ("eye", "icon"), ("702", ""), ("1 / 8.4 MB", "")], "3 ч", ["build"], False),
    ]
    for ti, title, meta, right, tags, thumb in rows:
        y += row(d, x, y, w, ti, title, meta, right, tags, thumb) + 1

    # footer
    fy = H - 52
    line(d, x, fy, W - 24, LINE)
    text(d, (x, fy + 16), "CHEATLAB", mono(12), MUTE)
    text(d, (x + 92, fy + 16), "1284 публикаций · 46.3 MB", mono(12), MUTE)
    text(d, (W - 24, fy + 16), "API", mono(12), MUTE, anchor="ra")

    out = os.path.join(ROOT, "docs", "feed.png")
    return save(d, out)


# ------------------------------------------------------------------- item.png

def make_item():
    W, H = 1280, 900
    d = canvas(W, H, PAPER)

    x, y = app_chrome(d, W, H, "/images", "", publish=False)

    # breadcrumb
    d.rectangle([x, y - 34, x + 82, y + 2], outline=LINE, width=1)
    icon(d, "back", x + 10, y - 28, 12, MUTE, 1.3)
    text(d, (x + 30, y - 31), "Назад", sans(12), MUTE)

    y += 18
    d.rectangle([x, y, x + 128, y + 26], fill=FOG, outline=LINE, width=1)
    icon(d, "image", x + 9, y + 5, 15, MUTE, 1.4)
    text(d, (x + 32, y + 5), "Изображение", sans(12), MUTE)

    y += 46
    text(d, (x, y), "Схема переходников", sans(28, True), INK)

    # sidebar first so the split maths is explicit
    sx = W - 24 - 300
    vline(d, sx - 24, 100, H - 60, LINE)

    sy = 104
    d.rectangle([sx, sy, sx + 300, sy + 214], outline=LINE, width=1)
    text(d, (sx + 16, sy + 16), "СВЕДЕНИЯ", mono(12, True), MUTE)
    kv = [("Тип", "Изображение"), ("Автор", "7c02be"), ("Создано", "9 мин назад"),
          ("Просмотры", "311"), ("Видимость", "в ленте"), ("ID", "k2m9xq4v")]
    ky = sy + 44
    for k, v in kv:
        text(d, (sx + 16, ky), k, mono(12), MUTE)
        text(d, (sx + 284, ky), v, mono(12), INK, anchor="ra")
        ky += 26

    ay = sy + 234
    d.rectangle([sx, ay, sx + 300, ay + 120], outline=LINE, width=1)
    text(d, (sx + 16, ay + 16), "ДЕЙСТВИЯ", mono(12, True), MUTE)
    for i, (ic, label) in enumerate([("link", "Ссылка"), ("download", "Файл"), ("edit", "Изменить")]):
        bx = sx + 16 + (i % 2) * 138
        by = ay + 44 + (i // 2) * 32
        d.rectangle([bx, by, bx + 128, by + 26], outline=INK, width=1)
        icon(d, ic, bx + 10, by + 5, 15, INK, 1.4)
        text(d, (bx + 32, by + 5), label, sans(12), INK)
    text(d, (sx + 16, ay + 88), "Ключ хранится в этом браузере", sans(11), MUTE)

    # media preview: greyscale plate with a drawn schematic, matching the
    # real component's 1px ink border and caption bar
    my = y + 52
    mw = sx - 24 - x
    mh = 300
    d.rectangle([x, my, x + mw, my + mh], fill=FOG)
    g = 214
    d.rectangle([x, my, x + mw, my + 44], fill=(g, g, g))
    for i in range(9):
        vline(d, x + 40 + i * 78, my, my + mh, (198, 198, 198), 1)
    for i in range(6):
        line(d, x, my + 40 + i * 44, x + mw, (198, 198, 198), 1)
    d.line([(x + 40, my + 240), (x + 280, my + 130), (x + 430, my + 196), (x + 640, my + 84), (x + mw - 40, my + 172)], fill=INK, width=3)
    for px, py in [(40, 240), (280, 130), (430, 196), (640, 84), (mw - 40, 172)]:
        d.ellipse([x + px - 7, my + py - 7, x + px + 7, my + py + 7], fill=PAPER, outline=INK, width=3)
    d.rectangle([x, my, x + mw, my + mh], outline=INK, width=1)

    cy = my + mh
    d.rectangle([x, cy, x + mw, cy + 40], fill=PAPER, outline=INK, width=1)
    text(d, (x + 10, cy + 12), "transition-map.png", mono(12), INK)
    d.rectangle([x + mw - 104, cy + 7, x + mw - 8, cy + 33], outline=INK, width=1)
    icon(d, "download", x + mw - 94, cy + 13, 14, INK, 1.4)
    text(d, (x + mw - 74, cy + 12), "Скачать", sans(12), INK)

    # file table
    fy = cy + 60
    d.rectangle([x, fy, x + mw, fy + 34], fill=INK)
    text(d, (x + 12, fy + 10), "Файл", mono(12), PAPER)
    text(d, (x + 280, fy + 10), "SHA-256", mono(12), PAPER)
    text(d, (x + mw - 12, fy + 10), "Размер", mono(12), PAPER, anchor="ra")
    d.rectangle([x, fy, x + mw, fy + 34 + 42], outline=LINE, width=1)
    text(d, (x + 12, fy + 46), "transition-map.png", mono(12), INK)
    text(d, (x + 280, fy + 46), "9f2c81ab44d0e715", mono(12), MUTE)
    text(d, (x + mw - 12, fy + 46), "1.8 MB", mono(12), MUTE, anchor="ra")
    text(d, (x + 12, fy + 88), "Медиа отдаётся с поддержкой Range: видео перематывается без загрузки целиком.", sans(11), MUTE)

    out = os.path.join(ROOT, "docs", "item.png")
    return save(d, out)


# ---------------------------------------------------------------- publish.png

def make_publish():
    W, H = 1280, 860
    d = canvas(W, H, PAPER)

    x, y = app_chrome(d, W, H, "/new", "")

    # type tabs
    tabs = [("code", "Скрипт"), ("box", "Приложение"), ("clip", "Паста"),
            ("image", "Изображение"), ("video", "Видео"), ("file", "Файл")]
    tw_total = sum(d.textlength(l, font=sans(13, True)) + 60 for _, l in tabs)
    tx = x
    for i, (ic, label) in enumerate(tabs):
        wdt = d.textlength(label, font=sans(13, True)) + 60
        on = i == 0
        d.rectangle([tx, y, tx + wdt, y + 38], fill=INK if on else PAPER,
                    outline=INK, width=1)
        icon(d, ic, tx + 14, y + 10, 17, PAPER if on else MUTE, 1.5)
        text(d, (tx + 40, y + 10), label, sans(13, True), PAPER if on else INK)
        tx += wdt + 6

    y += 62
    text(d, (x, y), "Название", sans(12, True), INK)
    d.rectangle([x, y + 20, x + tw_total - 6, y + 58], outline=LINE, width=1)
    text(d, (x + 12, y + 31), "Aimbot для лестницы", sans(15), INK)

    y += 80
    text(d, (x, y), "Теги", sans(12, True), INK)
    d.rectangle([x, y + 20, x + tw_total - 6, y + 58], outline=LINE, width=1)
    text(d, (x + 12, y + 31), "executor, roblox", sans(15), MUTE)
    text(d, (x + tw_total + 14, y + 31), "до 8 штук, через запятую", sans(12), MUTE)

    y += 80
    text(d, (x, y), "Содержимое", sans(12, True), INK)
    d.rectangle([x + 150, y - 4, x + 258, y + 24], outline=LINE, width=1)
    icon(d, "copy", x + 160, y - 1, 15, MUTE, 1.4)
    text(d, (x + 182, y - 1), "Вставить", sans(12), MUTE)

    cb_y = y + 36
    code = [
        "-- перехват шага игрока",
        "local Players = game:GetService('Players')",
        "local Run = game:GetService('RunService')",
        "",
        "local STEP = 6.5",
        "",
        "Run.Heartbeat:Connect(function()",
        "    local root = workspace:FindFirstChildWhichIsA('Model')",
        "    if not root then return end",
        "",
        "    for _, part in ipairs(root:GetDescendants()) do",
        "        if part:IsA('BasePart') and part.Name == 'HumanoidRootPart' then",
        "            local dir = part.CFrame.LookVector * STEP",
        "            part.CFrame = part.CFrame + dir * RunService.Step()",
        "        end",
        "    end",
        "end)",
    ]
    d.rectangle([x, cb_y, x + tw_total - 6, cb_y + 30], fill=PAPER, outline=INK, width=1)
    icon(d, "term", x + 10, cb_y + 7, 15, MUTE, 1.4)
    text(d, (x + 32, cb_y + 7), "Luau", mono(12), MUTE)
    text(d, (x + tw_total - 6, cb_y + 7), "8 строк", mono(12), MUTE, anchor="ra")
    d.rectangle([x, cb_y + 30, x + tw_total - 6, cb_y + 30 + len(code) * 20 + 24], fill=CODE_BG)
    for i, ln in enumerate(code):
        col = (120, 120, 120) if ln.strip().startswith("--") else CODE_FG
        text(d, (x + 14, cb_y + 42 + i * 20), ln, mono(13), col)

    dy = cb_y + 30 + len(code) * 20 + 46
    text(d, (x, dy), "Файлы", sans(12, True), INK)
    d.rectangle([x, dy + 20, x + tw_total - 6, dy + 88], outline=INK, width=1)
    icon(d, "upload", x + (tw_total - 6) / 2 - 12, dy + 38, 24, INK, 1.6)
    text(d, (x + (tw_total - 6) / 2, dy + 68), "Перетащи файлы сюда или нажми, чтобы выбрать",
         sans(12), MUTE, anchor="ma")

    qy = dy + 100
    d.rectangle([x, qy, x + tw_total - 6, qy + 30], fill=FOG, outline=LINE, width=1)
    text(d, (x + 12, qy + 7), "executor.lua", mono(12), INK)
    text(d, (x + 240, qy + 7), "14.2 KB", mono(12), MUTE)
    d.rectangle([x + 380, qy + 11, x + tw_total - 14, qy + 19], fill=INK)

    # right column: publication panel
    sx = W - 24 - 300
    vline(d, sx - 24, 100, H - 60, LINE)
    d.rectangle([sx, 104, sx + 300, 104 + 210], outline=LINE, width=1)
    text(d, (sx + 16, 120), "ПУБЛИКАЦИЯ", mono(12, True), MUTE)
    text(d, (sx + 16, 156), "Язык", sans(12, True), INK)
    d.rectangle([sx + 16, 178, sx + 284, 210], outline=LINE, width=1)
    text(d, (sx + 28, 186), "Luau", sans(13), INK)
    d.rectangle([sx + 250, 188, sx + 276, 200], outline=INK, width=1)
    d.polygon([(sx + 259, 192), (sx + 267, 192), (sx + 263, 197)], fill=INK)

    d.rectangle([sx + 16, 224, sx + 34, 242], outline=INK, width=1)
    text(d, (sx + 44, 224), "Не показывать в ленте", sans(13), INK)

    d.rectangle([sx + 16, 264, sx + 284, 300], fill=INK)
    icon(d, "plus", sx + 130, 274, 15, PAPER, 1.6)
    text(d, (sx + 152, 274), "Опубликовать", sans(14, True), PAPER)

    text(d, (sx, 330), "Без регистрации и входа.", sans(12), MUTE)
    for i, ln in enumerate(wrap(d, "Ключ редактирования выдаётся один раз и хранится в этом браузере. Его можно экспортировать в разделе «Мои загрузки».", sans(12), 300)[:4]):
        text(d, (sx, 352 + i * 18), ln, sans(12), MUTE)

    out = os.path.join(ROOT, "docs", "publish.png")
    return save(d, out)


# ------------------------------------------------------------------ stats.png

def make_stats():
    W, H = 1280, 700
    d = canvas(W, H, PAPER)

    x, y = app_chrome(d, W, H, "/stats", "", publish=False)

    text(d, (x, y), "Статистика", sans(30, True), INK)
    text(d, (x, y + 44), "Публичные счётчики и состояние плагинов API.", sans(14), MUTE)

    y += 92
    cards = [("1 284", "публикаций"), ("6", "типов"), ("3 412", "файлов"),
             ("46.3 MB", "всего"), ("892", "устройств")]
    cw = (W - x - 24 - 4 * 14) / 5
    for i, (v, label) in enumerate(cards):
        cx = x + i * (cw + 14)
        d.rectangle([cx, y, cx + cw, y + 108], outline=LINE, width=1)
        text(d, (cx + 18, y + 22), v, mono(30, True), INK)
        text(d, (cx + 18, y + 68), label, sans(13), MUTE)

    y += 140
    text(d, (x, y), "ПЛАГИНЫ API", mono(12, True), MUTE)
    y += 26
    d.rectangle([x, y, x + W - x - 24, y + 34], fill=INK)
    text(d, (x + 12, y + 10), "Плагин", mono(12), PAPER)
    text(d, (x + 240, y + 10), "Описание", mono(12), PAPER)
    text(d, (x + W - x - 36, y + 10), "Хуки", mono(12), PAPER, anchor="ra")

    plugs = [
        ("upload-guard", "отклоняет некорректные имена до записи байтов", "file:upload"),
        ("denylist", "блок-лист оператора: расширения и хеши", "file:upload, file:stored"),
        ("webhooks", "уведомления о новых публикациях", "item:published, item:delete"),
    ]
    ry = y + 34
    for i, (n, desc, hooks) in enumerate(plugs):
        d.rectangle([x, ry, x + W - x - 24, ry + 42], outline=LINE, width=1)
        text(d, (x + 12, ry + 14), n, mono(12), INK)
        text(d, (x + 240, ry + 14), desc, sans(12), MUTE)
        text(d, (x + W - x - 36, ry + 14), hooks, mono(12), MUTE, anchor="ra")
        ry += 42

    out = os.path.join(ROOT, "docs", "stats.png")
    return save(d, out)


if __name__ == "__main__":
    for fn in (make_og, make_feed, make_item, make_publish, make_stats):
        p = fn()
        print(f"{os.path.relpath(p, ROOT)}  {os.path.getsize(p) // 1024} KB")
