"""Exercise the actual pixel helpers without booting a VM; the toolbar also has a grey-bordered control."""
import ast
from pathlib import Path
import unittest

NAVBG = (0xf3, 0xf4, 0xf6)
TOPBAR = (0x1f, 0x29, 0x37)


def detector(filename):
    source = Path(__file__).with_name(filename)
    tree = ast.parse(source.read_text())
    functions = [x for x in tree.body if isinstance(x, ast.FunctionDef) and x.name in ("px", "near", "nav_buttons")]
    namespace = {"NAVBG": NAVBG}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"), namespace)
    return namespace["nav_buttons"]


def frame(buttons):
    w, h = 64, 560
    data = bytearray(bytes(NAVBG) * (w * h))
    data[:42 * w * 3] = bytes(TOPBAR) * (42 * w)
    # The real topbar's workspace switcher spans y=6..35; it is NOT a navigation button.
    for y in [6, 35] + [edge for top, bottom in buttons for edge in (top, bottom)]:
        k = (y * w + 12) * 3
        data[k:k + 3] = bytes((154, 154, 154))
    return w, h, bytes(data)


class NavigationPixelsTest(unittest.TestCase):
    def test_toolbar_control_is_not_a_thirteenth_navigation_button(self):
        expected = [(88 + i * 37, 120 + i * 37) for i in range(12)]
        for filename in ("m5-desktop.py", "m19-iso.py"):
            with self.subTest(filename=filename):
                self.assertEqual(detector(filename)(frame(expected)), expected)

    def test_toolbar_alone_cannot_pass_a_navigation_check(self):
        for filename in ("m5-desktop.py", "m19-iso.py"):
            with self.subTest(filename=filename):
                self.assertEqual(detector(filename)(frame([])), [])


if __name__ == "__main__":
    unittest.main()
