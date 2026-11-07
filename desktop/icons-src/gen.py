#!/usr/bin/env python3
"""Shell icons: one alpha mask per glyph in icons-src/*.png (48x48), tinted into qml/icons/<name>_<tone>[_dark].png.

Run from desktop/: python3 icons-src/gen.py  (needs Pillow). The tones match Theme.qml's palette for light and dark.
New glyphs are drawn here at 8x and downsampled, in the same 1.5 px-at-24 stroke style as the packaged set.
"""
import math, os, sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "qml", "icons")
TONES = {
    "primary":   ("#18181B", "#F2F2F3"),
    "secondary": ("#5B5B63", "#A3A3AB"),
    "muted":     ("#9C9CA3", "#6B6B73"),
    "accent":    ("#1F1F23", "#F2F2F3"),
    "onaccent":  ("#FFFFFF", "#111113"),
    "white":     ("#F2F2F3", "#F2F2F3"),
    "danger":    ("#C03A2B", "#E5675A"),
    "warning":   ("#A86A12", "#D9A548"),
    "success":   ("#3F7D58", "#6DBE8C"),
}
S = 8                      # supersampling
W = 48 * S
SW = int(3.1 * S)          # stroke width at 48 px

def canvas():
    im = Image.new("L", (W, W), 0)
    return im, ImageDraw.Draw(im)

def line(d, pts, w=SW):
    pts = [(x * S, y * S) for x, y in pts]
    d.line(pts, fill=255, width=w, joint="curve")
    r = w / 2
    for x, y in (pts[0], pts[-1]):
        d.ellipse((x - r, y - r, x + r, y + r), fill=255)

def circle(d, cx, cy, r, w=SW, fill=False):
    box = ((cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S)
    if fill: d.ellipse(box, fill=255)
    else: d.ellipse(box, outline=255, width=w)

def arc(d, cx, cy, r, a0, a1, w=SW):
    box = ((cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S)
    d.arc(box, a0, a1, fill=255, width=w)

def done(im):
    return im.resize((48, 48), Image.LANCZOS)

def g_settings():          # three sliders
    im, d = canvas()
    for y, k in ((13, 30), (24, 16), (35, 26)):
        line(d, [(8, y), (40, y)])
        circle(d, k, y, 4.2, fill=True)
    # knobs as rings: punch the centre
    m = Image.new("L", (W, W), 0); md = ImageDraw.Draw(m)
    for y, k in ((13, 30), (24, 16), (35, 26)):
        r = 2.4
        md.ellipse(((k - r) * S, (y - r) * S, (k + r) * S, (y + r) * S), fill=255)
    im.paste(0, mask=m)
    return done(im)

def g_sparkle():           # model: two four-point stars with concave sides (astroid-like)
    im, d = canvas()
    def star(cx, cy, R, fill):
        pts = []
        for i in range(240):
            t = 2 * math.pi * i / 240
            c, sn = math.cos(t), math.sin(t)
            k = 0.9       # softness: 1 = astroid, lower = fuller
            x = math.copysign(abs(c) ** (3 * k + (1 - k)), c)
            y = math.copysign(abs(sn) ** (3 * k + (1 - k)), sn)
            pts.append(((cx + R * x) * S, (cy + R * y) * S))
        if fill: d.polygon(pts, fill=255)
        else: d.line(pts + [pts[0]], fill=255, width=SW, joint="curve")
    star(21, 27, 15, False)
    star(37.5, 10.5, 6.5, True)
    return done(im)

def g_bell():
    im, d = canvas()
    line(d, [(12, 33), (12, 21)])
    line(d, [(36, 33), (36, 21)])
    arc(d, 24, 21, 12, 180, 360)
    line(d, [(8, 34), (40, 34)])
    arc(d, 24, 37, 5, 0, 180)
    return done(im)

def g_back():
    im, d = canvas()
    line(d, [(38, 24), (11, 24)])
    line(d, [(22, 12), (10, 24), (22, 36)])
    return done(im)

def g_user():
    im, d = canvas()
    circle(d, 24, 16, 8)
    arc(d, 24, 44, 16, 200, 340)
    return done(im)

def g_grid():              # app launcher: 3x3 dots
    im, d = canvas()
    for i in range(3):
        for j in range(3):
            circle(d, 12 + 12 * i, 12 + 12 * j, 3.6, fill=True)
    return done(im)

def g_more():
    im, d = canvas()
    for x in (12, 24, 36):
        circle(d, x, 24, 3.4, fill=True)
    return done(im)

def g_arrowUp():
    im, d = canvas()
    line(d, [(24, 38), (24, 11)])
    line(d, [(12, 22), (24, 10), (36, 22)])
    return done(im)

DRAWN = {"settings": g_settings, "sparkle": g_sparkle, "bell": g_bell, "back": g_back, "user": g_user,
         "grid": g_grid, "more": g_more, "arrowUp": g_arrowUp}

def masks():
    out = {}
    for f in sorted(os.listdir(HERE)):
        if f.endswith(".png"):
            im = Image.open(os.path.join(HERE, f))
            out[f[:-4]] = im.convert("L") if im.mode in ("L", "1") else im.convert("RGBA").split()[3]
    for k, fn in DRAWN.items():
        out[k] = fn()
    return out

def main():
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith(".png"): os.remove(os.path.join(OUT, f))
    n = 0
    for name, a in masks().items():
        for tone, (light, darkc) in TONES.items():
            for suffix, col in (("", light), ("_dark", darkc)):
                im = Image.new("RGBA", (48, 48), col)
                im.putalpha(a)
                im.save(os.path.join(OUT, f"{name}_{tone}{suffix}.png"), optimize=True)
                n += 1
    print(n, "icons")

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--extract":
        # one-time: masks from the old tinted set (qml/icons/<name>_primary.png)
        for f in os.listdir(OUT):
            if f.endswith("_primary.png"):
                Image.open(os.path.join(OUT, f)).convert("RGBA").split()[3].save(os.path.join(HERE, f.replace("_primary", "")))
    else:
        main()
