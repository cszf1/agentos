"""Exercise the VM checks' real dock detector (m5/m19/m20 dock()) on synthetic frames, without booting a VM."""
import ast
from pathlib import Path
import unittest

DESK, DOCKBG, DOCKON, DOCKHOVER, BORDER = (0xf3, 0xf3, 0xf1), (0xff, 0xff, 0xff), (0xea, 0xea, 0xe7), (0xf1, 0xf1, 0xee), (0xe7, 0xe7, 0xe3)
ICON = (0x5b, 0x5b, 0x63)


def detector(filename):
    source = Path(__file__).with_name(filename)
    tree = ast.parse(source.read_text())
    keep = [x for x in tree.body if isinstance(x, ast.FunctionDef) and x.name in ("px", "near", "dock")]
    keep += [x for x in tree.body if isinstance(x, ast.Assign) and any(isinstance(t, ast.Tuple) and any(getattr(e, "id", "") == "DOCKON" for e in t.elts) or getattr(t, "id", "") == "DOCK_ITEMS" for t in x.targets)]
    namespace = {}
    exec(compile(ast.Module(body=keep, type_ignores=[]), str(source), "exec"), namespace)
    return namespace["dock"]


def frame(scale=1.0, active=0, hover=None, w=1280, h=800, with_dock=True):
    data = bytearray(bytes(DESK) * (w * h))

    def fill(x0, y0, x1, y1, c):
        for y in range(max(0, y0), min(h, y1)):
            k = (y * w + max(0, x0)) * 3
            data[k:k + 3 * (min(w, x1) - max(0, x0))] = bytes(c) * (min(w, x1) - max(0, x0))

    # top bar controls on the left/right never count
    fill(10, 6, 140, 30, (0xea, 0xea, 0xe7))
    fill(w - 60, 6, w - 34, 30, (0xea, 0xea, 0xe7))
    if with_dock:
        s = scale
        dw, dh = round(200 * s), round(56 * s)
        left, top = round(w / 2 - dw / 2), h - round(12 * s) - dh
        fill(left, top, left + dw, top + dh, BORDER)
        fill(left + 1, top + 1, left + dw - 1, top + dh - 1, DOCKBG)
        for i in range(4):
            x0 = left + round((6 + 48 * i) * s)
            y0 = top + round(6 * s)
            c = DOCKON if i == active else (DOCKHOVER if i == hover else DOCKBG)
            fill(x0, y0, x0 + round(44 * s), y0 + round(44 * s), c)
            ic = x0 + round(22 * s)
            fill(ic - round(10 * s), y0 + round(12 * s), ic + round(10 * s), y0 + round(32 * s), ICON)
    return w, h, bytes(data)


FILES = ("m5-desktop.py", "m19-iso.py", "m20-sway.py")


class DockPixelsTest(unittest.TestCase):
    def test_finds_the_dock_and_the_current_place(self):
        for filename in FILES:
            for active in range(4):
                with self.subTest(filename=filename, active=active):
                    d = detector(filename)(frame(active=active))
                    self.assertIsNotNone(d)
                    self.assertEqual(d["active"], active)
                    self.assertEqual(len(d["centers"]), 4)
                    self.assertAlmostEqual(d["scale"], 1.0, delta=0.05)

    def test_click_targets_are_inside_each_place(self):
        img = frame(active=1)
        d = detector(FILES[0])(img)
        w = img[0]
        left = round(w / 2 - 100)
        for i, c in enumerate(d["centers"]):
            self.assertTrue(left + 6 + 48 * i < c < left + 50 + 48 * i, (i, c))

    def test_hover_tint_is_not_the_current_place(self):
        for filename in FILES:
            with self.subTest(filename=filename):
                d = detector(filename)(frame(active=2, hover=0))
                self.assertEqual(d["active"], 2)

    def test_zoom_widens_the_dock(self):
        for filename in FILES:
            with self.subTest(filename=filename):
                a = detector(filename)(frame(scale=1.0))
                b = detector(filename)(frame(scale=1.125))
                self.assertGreater(b["width"], a["width"] + 10)

    def test_top_bar_alone_is_not_a_shell_frame(self):
        for filename in FILES:
            with self.subTest(filename=filename):
                self.assertIsNone(detector(filename)(frame(with_dock=False)))


if __name__ == "__main__":
    unittest.main()
