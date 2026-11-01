"""Locate the rendered primary Login button rather than relying on ReGreet's initial keyboard focus."""
import unittest
from pnm import greeter_login_button


def frame(boxes, holes=False):
    w, h = 360, 220
    rgb = bytearray((246, 245, 244) * (w * h))
    for x0, y0, bw, bh in boxes:
        for y in range(y0, y0 + bh):
            for x in range(x0, x0 + bw):
                p = (y * w + x) * 3
                rgb[p:p + 3] = bytes((53, 132, 228))
    if holes:
        for x in range(255, 285, 5):
            for y in range(125, 134):
                p = (y * w + x) * 3
                rgb[p:p + 3] = b'\xff\xff\xff'
    return w, h, bytes(rgb)


class GreeterInputTest(unittest.TestCase):
    def test_button_center_survives_white_label_and_small_blue_noise(self):
        self.assertEqual(greeter_login_button(frame([(230, 115, 85, 34), (8, 8, 10, 5)], holes=True)), (272, 131))

    def test_wide_dropdown_is_not_the_login_button(self):
        self.assertEqual(greeter_login_button(frame([(10, 65, 280, 30), (230, 130, 85, 34)])), (272, 146))

    def test_missing_primary_button_fails_instead_of_typing_a_password(self):
        with self.assertRaisesRegex(AssertionError, "expected one rendered Login button"):
            greeter_login_button(frame([]))

    def test_ambiguous_primary_buttons_are_not_guessed(self):
        with self.assertRaisesRegex(AssertionError, "expected one rendered Login button"):
            greeter_login_button(frame([(20, 110, 80, 32), (210, 110, 80, 32)]))


if __name__ == "__main__":
    unittest.main()
