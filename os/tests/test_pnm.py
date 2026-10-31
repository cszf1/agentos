"""Pure screenshot decoder regressions; run in the cloud with python3 -B os/tests/test_pnm.py."""
import unittest
from pnm import pnm_rgb


class PnmTest(unittest.TestCase):
    def test_colour(self):
        self.assertEqual(pnm_rgb(b"P6\n2 1\n255\n" + bytes([1, 2, 3, 254, 255, 0])),
                         (2, 1, bytes([1, 2, 3, 254, 255, 0])))

    def test_grey_to_rgb(self):
        self.assertEqual(pnm_rgb(b"P5\n3 1\n255\n" + bytes([0, 127, 255])),
                         (3, 1, bytes([0, 0, 0, 127, 127, 127, 255, 255, 255])))

    def test_comments_and_crlf(self):
        self.assertEqual(pnm_rgb(b"P5\r\n# greeter frame\r\n1 1\r\n255\r\n#"),
                         (1, 1, b"###"))

    def test_first_raster_bytes_are_not_trimmed(self):
        for data in (b" \n\t", b"#\r\n", b"\x00\xff\x0b"):
            with self.subTest(data=data):
                self.assertEqual(pnm_rgb(b"P6\n1 1\n255\n" + data), (1, 1, data))

    def test_invalid_or_incomplete_frames_fail_closed(self):
        for data in (b"", b"P5", b"P5\n# no newline", b"P4\n1 1\n255\n\0",
                     b"P5\n0 1\n255\n", b"P6\n-1 1\n255\n",
                     b"P5\n1 1\n65535\n\0\0", b"P5\n1 1\n255",
                     b"P6\n1 1\n255\n\0\0", b"P5\n1 1\n255\n\0\0"):
            with self.subTest(data=data):
                with self.assertRaises(ValueError):
                    pnm_rgb(data)


if __name__ == "__main__":
    unittest.main()
