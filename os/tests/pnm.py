# Binary PNM emitted by pngtopnm: a monochrome/grey frame is P5, a colour frame is P6.
# Keep the raster byte-for-byte (its first byte can itself be whitespace or '#').
def pnm_rgb(raw: bytes) -> tuple[int, int, bytes]:
    whitespace = b" \t\r\n\v\f"
    parts: list[bytes] = []
    i = 0
    while len(parts) < 4:
        while i < len(raw):
            if raw[i] in whitespace:
                i += 1
            elif raw[i] == 35:
                end = raw.find(b"\n", i)
                if end < 0:
                    raise ValueError("unterminated PNM comment")
                i = end + 1
            else:
                break
        start = i
        while i < len(raw) and raw[i] not in whitespace and raw[i] != 35:
            i += 1
        if i == start:
            raise ValueError("incomplete PNM header")
        parts.append(raw[start:i])
    magic, width, height, maximum = parts
    if magic not in (b"P5", b"P6") or not all(x.isdigit() for x in parts[1:]):
        raise ValueError("unsupported PNM header")
    w, h = int(width), int(height)
    if w <= 0 or h <= 0 or int(maximum) != 255:
        raise ValueError("expected positive dimensions and 8-bit samples")
    if i >= len(raw) or raw[i] not in whitespace:
        raise ValueError("missing PNM raster separator")
    i += 2 if raw[i:i + 2] == b"\r\n" else 1
    data = raw[i:]
    channels = 3 if magic == b"P6" else 1
    if len(data) != w * h * channels:
        raise ValueError("PNM raster length does not match its dimensions")
    if magic == b"P5":
        rgb = bytearray(w * h * 3)
        rgb[0::3] = data
        rgb[1::3] = data
        rgb[2::3] = data
        data = bytes(rgb)
    return w, h, data


def greeter_login_button(img):
    """The frozen GTK theme's primary Login control; never guess among missing/ambiguous controls."""
    w, h, rgb = img
    assert len(rgb) == w * h * 3
    blue = set()
    for y in range(h):
        for x in range(w):
            k = (y * w + x) * 3
            if abs(rgb[k] - 53) <= 18 and abs(rgb[k + 1] - 132) <= 18 and abs(rgb[k + 2] - 228) <= 18:
                blue.add((x, y))
    candidates = []
    while blue:
        start = blue.pop()
        todo = [start]
        xs, ys, count = [start[0]], [start[1]], 0
        while todo:
            x, y = todo.pop()
            xs.append(x); ys.append(y); count += 1
            for p in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if p in blue:
                    blue.remove(p)
                    todo.append(p)
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        bw, bh = x1 - x0 + 1, y1 - y0 + 1
        if 50 <= bw <= 220 and 24 <= bh <= 64 and count >= bw * bh * 0.45 and h * 0.2 < y0 < y1 < h * 0.9:
            candidates.append(((x0 + x1) // 2, (y0 + y1) // 2))
    assert len(candidates) == 1, f"expected one rendered Login button, found {candidates}"
    return candidates[0]


def log_failure_screen(m, tag):
    """Keep the actual scanout in failure logs even when Nix discards a failed derivation's PNG files."""
    import base64
    from pathlib import Path
    m.screenshot(tag)
    encoded = base64.b64encode((Path(m.out_dir) / (tag + ".png")).read_bytes()).decode("ascii")
    for i in range(0, len(encoded), 4096):
        print("FAILED-SCREEN", tag, i, encoded[i:i + 4096], flush=True)
