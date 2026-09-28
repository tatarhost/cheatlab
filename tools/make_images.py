"""
Shared drawing helpers for CHEATLAB's documentation imagery.

The palette, rail width and type scale mirror public/style.css so the rendered
mockups stay recognisably the same product as the live site.

Run:  python tools/make_images.py
"""

import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# --- design tokens, same values as :root in public/style.css -----------------
INK = (11, 11, 11)
PAPER = (255, 255, 255)
FOG = (242, 242, 242)
LINE = (212, 212, 212)
MUTE = (111, 111, 111)
CODE_BG = (11, 11, 11)
CODE_FG = (237, 237, 237)

RAIL = 236

MONO = "C:/Windows/Fonts/consola.ttf"
MONO_B = "C:/Windows/Fonts/consolab.ttf"
SANS = "C:/Windows/Fonts/segoeui.ttf"
SANS_SB = "C:/Windows/Fonts/seguisb.ttf"


class Draw(ImageDraw.ImageDraw):
    """Pillow only accepts integer pixel coordinates, and all the layout maths
    here is proportional. Round on the way in instead of at every call site."""

    @staticmethod
    def _i(seq):
        return [int(round(v)) for v in seq]

    def _fix(self, seq):
        if seq is None or len(seq) == 0:
            return seq
        first = seq[0]
        if isinstance(first, (tuple, list)):
            return [self._i(p) for p in seq]
        return self._i(seq)

    def line(self, xy, fill=None, width=1, joint=None):
        return super().line(self._fix(xy), fill=fill, width=max(1, int(round(width))), joint=joint)

    def rectangle(self, xy, fill=None, outline=None, width=1):
        return super().rectangle(self._fix(xy), fill=fill, outline=outline, width=max(1, int(round(width))))

    def rounded_rectangle(self, xy, radius=0, fill=None, outline=None, width=1):
        return super().rounded_rectangle(self._fix(xy), radius=int(round(radius)), fill=fill,
                                         outline=outline, width=max(1, int(round(width))))

    def ellipse(self, xy, fill=None, outline=None, width=1):
        return super().ellipse(self._fix(xy), fill=fill, outline=outline, width=max(1, int(round(width))))

    def arc(self, xy, start, end, fill=None, width=1):
        return super().arc(self._fix(xy), start, end, fill=fill, width=max(1, int(round(width))))

    def polygon(self, xy, fill=None, outline=None):
        return super().polygon(self._fix(xy), fill=fill, outline=outline)


def canvas(w, h, bg=PAPER):
    img = Image.new("RGB", (w, h), bg)
    d = Draw(img)
    d.image = img
    return d


def save(d, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    d.image.save(path, "PNG", optimize=True)
    return path


def mono(size, bold=False):
    return ImageFont.truetype(MONO_B if bold else MONO, size)


def sans(size, bold=False):
    return ImageFont.truetype(SANS_SB if bold else SANS, size)


def text(d, xy, s, font, fill=INK, anchor="la"):
    d.text(xy, s, font=font, fill=fill, anchor=anchor)


def rrect(d, box, radius, fill=None, outline=None, width=1):
    """Rounded rect. The product itself has square corners, so radius is 0
    almost everywhere; kept for the thumbnail and logo marks."""
    if radius <= 0:
        d.rectangle(box, fill=fill, outline=outline, width=width)
    else:
        d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def line(d, x0, y, x1, color=LINE, width=1):
    d.line([(x0, y), (x1, y)], fill=color, width=width)


def vline(d, x, y0, y1, color=LINE, width=1):
    d.line([(x, y0), (x, y1)], fill=color, width=width)


def wrap(d, s, font, max_w):
    words, out, cur = s.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if d.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            if cur:
                out.append(cur)
            cur = w
    if cur:
        out.append(cur)
    return out


def icon(d, name, x, y, size=16, color=INK, width=1.6):
    """Minimal stroke glyphs matching the sprite ids used in the app."""
    s = size
    if name == "code":
        d.line([(x + s * 0.62, y + s * 0.15), (x + s * 0.20, y + s * 0.5), (x + s * 0.62, y + s * 0.85)], fill=color, width=width)
        d.line([(x + s * 0.38, y + s * 0.15), (x + s * 0.80, y + s * 0.5), (x + s * 0.38, y + s * 0.85)], fill=color, width=width)
    elif name == "clip":
        d.rectangle([x + s * 0.28, y + s * 0.1, x + s * 0.72, y + s * 0.34], outline=color, width=width)
        d.rectangle([x + s * 0.18, y + s * 0.44, x + s * 0.82, y + s * 0.9], outline=color, width=width)
    elif name == "box":
        d.rectangle([x + s * 0.12, y + s * 0.20, x + s * 0.88, y + s * 0.86], outline=color, width=width)
        d.line([(x + s * 0.5, y + s * 0.20), (x + s * 0.5, y + s * 0.86)], fill=color, width=width)
    elif name == "image":
        d.rectangle([x + s * 0.1, y + s * 0.18, x + s * 0.9, y + s * 0.82], outline=color, width=width)
        d.ellipse([x + s * 0.30, y + s * 0.32, x + s * 0.44, y + s * 0.46], outline=color, width=width)
        d.line([(x + s * 0.16, y + s * 0.74), (x + s * 0.44, y + s * 0.50), (x + s * 0.84, y + s * 0.78)], fill=color, width=width)
    elif name == "video":
        d.rectangle([x + s * 0.08, y + s * 0.26, x + s * 0.66, y + s * 0.74], outline=color, width=width)
        d.polygon([(x + s * 0.72, y + s * 0.38), (x + s * 0.92, y + s * 0.28), (x + s * 0.92, y + s * 0.72), (x + s * 0.72, y + s * 0.62)], outline=color)
    elif name == "file":
        d.polygon([(x + s * 0.22, y + s * 0.10), (x + s * 0.62, y + s * 0.10), (x + s * 0.80, y + s * 0.30),
                   (x + s * 0.80, y + s * 0.90), (x + s * 0.22, y + s * 0.90)], outline=color)
        d.line([(x + s * 0.62, y + s * 0.10), (x + s * 0.62, y + s * 0.30), (x + s * 0.80, y + s * 0.30)], fill=color, width=width)
    elif name == "user":
        d.ellipse([x + s * 0.32, y + s * 0.16, x + s * 0.68, y + s * 0.52], outline=color, width=width)
        d.arc([x + s * 0.16, y + s * 0.56, x + s * 0.84, y + s * 1.24], 180, 360, fill=color, width=width)
    elif name == "eye":
        d.ellipse([x + s * 0.08, y + s * 0.26, x + s * 0.92, y + s * 0.74], outline=color, width=width)
        d.ellipse([x + s * 0.38, y + s * 0.38, x + s * 0.62, y + s * 0.62], outline=color, width=width)
    elif name == "download":
        d.line([(x + s * 0.5, y + s * 0.12), (x + s * 0.5, y + s * 0.62)], fill=color, width=width)
        d.line([(x + s * 0.24, y + s * 0.40), (x + s * 0.5, y + s * 0.66), (x + s * 0.76, y + s * 0.40)], fill=color, width=width)
    elif name == "plus":
        d.line([(x + s * 0.16, y + s * 0.5), (x + s * 0.84, y + s * 0.5)], fill=color, width=width)
        d.line([(x + s * 0.5, y + s * 0.16), (x + s * 0.5, y + s * 0.84)], fill=color, width=width)
    elif name == "search":
        d.ellipse([x + s * 0.12, y + s * 0.12, x + s * 0.70, y + s * 0.70], outline=color, width=width)
        d.line([(x + s * 0.66, y + s * 0.66), (x + s * 0.90, y + s * 0.90)], fill=color, width=width)
    elif name == "term":
        d.rectangle([x + s * 0.12, y + s * 0.16, x + s * 0.88, y + s * 0.84], outline=color, width=width)
        d.line([(x + s * 0.28, y + s * 0.40), (x + s * 0.40, y + s * 0.52), (x + s * 0.28, y + s * 0.64)], fill=color, width=width)
        d.line([(x + s * 0.48, y + s * 0.64), (x + s * 0.72, y + s * 0.64)], fill=color, width=width)
    elif name == "upload":
        d.line([(x + s * 0.5, y + s * 0.82), (x + s * 0.5, y + s * 0.18)], fill=color, width=width)
        d.line([(x + s * 0.26, y + s * 0.42), (x + s * 0.5, y + s * 0.18), (x + s * 0.74, y + s * 0.42)], fill=color, width=width)
    elif name == "lock":
        d.rectangle([x + s * 0.18, y + s * 0.44, x + s * 0.82, y + s * 0.88], outline=color, width=width)
        d.arc([x + s * 0.30, y + s * 0.14, x + s * 0.70, y + s * 0.60], 180, 360, fill=color, width=width)
    elif name == "copy":
        d.rectangle([x + s * 0.32, y + s * 0.32, x + s * 0.88, y + s * 0.88], outline=color, width=width)
        d.rectangle([x + s * 0.12, y + s * 0.12, x + s * 0.68, y + s * 0.68], outline=color, width=width)


def app_chrome(d, w, h, active_nav, search_text, publish=True):
    """Left rail + topbar, shared by every screen mockup."""
    # rail
    d.rectangle([0, 0, RAIL, h], fill=PAPER)
    vline(d, RAIL, 0, h, LINE)

    rrect(d, [22, 26, 62, 66], 0, fill=INK)
    text(d, (51, 46), "C", mono(24, True), PAPER, anchor="mm")
    text(d, (74, 40), "CHEAT", sans(17, True), INK)
    text(d, (74 + d.textlength("CHEAT", font=sans(17, True)), 40), "LAB", sans(17, True), MUTE)

    line(d, 22, 88, RAIL - 22, LINE)

    items = [
        ("code", "Скрипты", "/scripts"),
        ("box", "Приложения", "/apps"),
        ("clip", "Пасты", "/pastes"),
        ("image", "Изображения", "/images"),
        ("video", "Видео", "/videos"),
        ("file", "Файлы", "/files"),
        ("user", "Мои загрузки", "/me"),
    ]
    y = 104
    for name, label, path in items:
        on = active_nav == path
        if on:
            d.rectangle([0, y - 8, RAIL, y + 28], fill=INK)
        col = PAPER if on else MUTE
        icon(d, name, 22, y, 16, col)
        text(d, (52, y - 1), label, sans(14, on), col)
        y += 44

    d.rectangle([0, h - 108, RAIL, h], fill=PAPER)
    line(d, 22, h - 108, RAIL - 22, LINE)
    for i, ln in enumerate(wrap(d, "Без регистрации и входа. Ключ редактирования хранится в этом браузере.", sans(11), RAIL - 44)[:3]):
        text(d, (22, h - 94 + i * 15), ln, sans(11), MUTE)
    text(d, (22, h - 40), "1284 публикаций", mono(12, True), INK)

    # topbar
    d.rectangle([RAIL, 0, w, 72], fill=PAPER)
    line(d, RAIL, 72, w, LINE)
    box = [RAIL + 24, 20, w - (24 + (140 if publish else 0)), 52]
    d.rectangle(box, outline=LINE, width=1)
    icon(d, "search", box[0] + 12, box[1] + 10, 16, MUTE)
    if search_text:
        text(d, (box[0] + 40, box[1] + 9), search_text, sans(14), MUTE)
    if publish:
        pb = [w - 24 - 140, 20, w - 24, 52]
        d.rectangle(pb, fill=INK)
        icon(d, "plus", pb[0] + 16, pb[1] + 10, 16, PAPER)
        text(d, (pb[0] + 44, pb[1] + 10), "Опубликовать", sans(14, True), PAPER)

    return RAIL + 24, 96  # content origin


def row(d, x, y, w, type_icon, title, meta_left, meta_right, tags=None, thumb=False):
    h = 92 if tags else 74
    d.rectangle([x, y, x + w, y + h], fill=PAPER)
    line(d, x, y + h, x + w, LINE)
    if thumb:
        rrect(d, [x + 18, y + 18, x + 74, y + 74], 0, fill=FOG, outline=LINE)
        icon(d, "image", x + 34, y + 34, 24, MUTE)
    else:
        icon(d, type_icon, x + 18, y + 18, 16, MUTE)
    tx = x + (96 if thumb else 52)
    text(d, (tx, y + 18), title, sans(15, True), INK)
    mx = tx
    for label, kind in meta_left:
        col = MUTE
        if kind == "icon":
            icon(d, label, mx, y + 46, 13, MUTE, 1.3)
            mx += 18
        mx += d.textlength(label, font=mono(11.5)) + 16
    text(d, (x + w - 20, y + 18), meta_right, mono(11.5), MUTE, anchor="ra")
    if tags:
        cx = tx
        for t in tags:
            tw = d.textlength(t, font=mono(11.5)) + 16
            d.rectangle([cx, y + 64, cx + tw, y + 86], outline=LINE, width=1)
            text(d, (cx + 8, y + 69), f"#{t}", mono(11.5), MUTE)
            cx += tw + 8
    return h
