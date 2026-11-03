"""Exercise the actual pixel helpers without booting a VM; the toolbar also has a grey-bordered control."""
import ast
from pathlib import Path
import unittest

NAVBG = (0xff, 0xff, 0xff)
TOPBAR = (0xff, 0xff, 0xff)


def detector(filename):
    source = Path(__file__).with_name(filename)
    tree = ast.parse(source.read_text())
    functions = [x for x in tree.body if isinstance(x, ast.FunctionDef) and x.name in ("px", "near", "nav_buttons")]
    namespace = {"NAVBG": NAVBG}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"), namespace)
    return namespace["nav_buttons"]


def frame(buttons, focused=None):
    w, h = 64, 560
    data = bytearray(bytes(NAVBG) * (w * h))
    data[:42 * w * 3] = bytes(TOPBAR) * (42 * w)
    # Toolbar/workspace controls have grey/blue borders, never navigation rails.
    for y in range(6, 36):
        k = (y * w + 17) * 3
        data[k:k + 3] = bytes((0x25, 0x63, 0xeb) if focused is not None else (0xcb, 0xd5, 0xe1))
    # Even a focused selector must not be counted. Its blue border is x=16, away from the rail scan.
    if focused is not None:
        for y in range(6, 36):
            k = (y * w + 17) * 3
            data[k:k + 3] = bytes(NAVBG)
            k = (y * w + 16) * 3
            data[k:k + 3] = bytes((0x25, 0x63, 0xeb))
    for i, (top, bottom) in enumerate(buttons):
        for y in range(top, bottom + 1):
            k = (y * w + 17) * 3
            data[k:k + 3] = bytes((0x25, 0x63, 0xeb) if i == focused else (0x94, 0xa3, 0xb8))
    return w, h, bytes(data)


class NavigationPixelsTest(unittest.TestCase):
    def test_toolbar_control_is_not_a_thirteenth_navigation_button(self):
        expected = [(88 + i * 37, 120 + i * 37) for i in range(12)]
        for filename in ("m5-desktop.py", "m19-iso.py", "m20-sway.py"):
            with self.subTest(filename=filename):
                self.assertEqual(detector(filename)(frame(expected)), expected)

    def test_active_rail_does_not_hide_the_clicked_navigation_item(self):
        expected = [(53 + i * 37, 85 + i * 37) for i in range(12)]
        for filename in ("m5-desktop.py", "m19-iso.py", "m20-sway.py"):
            with self.subTest(filename=filename):
                self.assertEqual(detector(filename)(frame(expected, focused=4)), expected)

    def test_toolbar_alone_cannot_pass_a_navigation_check(self):
        for filename in ("m5-desktop.py", "m19-iso.py", "m20-sway.py"):
            with self.subTest(filename=filename):
                self.assertEqual(detector(filename)(frame([])), [])


if __name__ == "__main__":
    unittest.main()
