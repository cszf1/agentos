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
