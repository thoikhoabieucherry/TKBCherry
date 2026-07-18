from __future__ import annotations

import time
import unittest
from pathlib import Path

from agent_helper.tray import create_system_tray


class FakeImage:
    def __init__(self) -> None:
        self.converted = ""

    def convert(self, mode: str) -> "FakeImage":
        self.converted = mode
        return self


class FakeImageModule:
    image = FakeImage()
    opened: Path | None = None

    @classmethod
    def open(cls, path: Path) -> FakeImage:
        cls.opened = path
        return cls.image


class FakeMenuItem:
    def __init__(self, text: str, action: object, **options: object) -> None:
        self.text = text
        self.action = action
        self.options = options


class FakeMenu(tuple):
    SEPARATOR = object()

    def __new__(cls, *items: object) -> "FakeMenu":
        return tuple.__new__(cls, items)


class FakeIcon:
    def __init__(self, name: str, image: object, title: str, menu: FakeMenu) -> None:
        self.name = name
        self.image = image
        self.title = title
        self.menu = menu
        self.ran = False
        self.stopped = False
        self.menu_updates = 0

    def run(self) -> None:
        self.ran = True

    def update_menu(self) -> None:
        self.menu_updates += 1

    def stop(self) -> None:
        self.stopped = True


class FakePystray:
    Menu = FakeMenu
    MenuItem = FakeMenuItem
    Icon = FakeIcon


class TrayTests(unittest.TestCase):
    def test_logo_tray_exposes_show_on_off_and_exit(self) -> None:
        commands: list[str] = []
        online = [True]
        icon_path = Path("favicon-cherry.png")
        tray = create_system_tray(
            icon_path,
            commands.append,
            lambda: online[0],
            pystray_module=FakePystray,
            image_module=FakeImageModule,
        )
        icon = tray._icon
        self.assertEqual(FakeImageModule.opened, icon_path)
        self.assertEqual(FakeImageModule.image.converted, "RGBA")
        items = [item for item in icon.menu if isinstance(item, FakeMenuItem)]
        self.assertEqual(
            [item.text for item in items],
            [
                "Mở TKBCherry Agent",
                "Mở TKBCherry Agent",
                "Bật Agent",
                "Tắt Agent",
                "Thoát",
            ],
        )
        self.assertTrue(items[0].options["default"])
        self.assertFalse(items[0].options["visible"])
        self.assertNotIn("default", items[1].options)
        self.assertFalse(items[2].options["enabled"](items[2]))
        self.assertTrue(items[3].options["enabled"](items[3]))

        items[0].action(icon, items[0])
        self.assertEqual(commands, [], "one tray click must stay hidden")
        items[0].action(icon, items[0])
        self.assertEqual(commands, ["show"], "the second quick click opens the window")
        for item in items[1:]:
            item.action(icon, item)
        self.assertEqual(commands, ["show", "show", "on", "off", "exit"])

        tray.start()
        deadline = time.monotonic() + 1
        while not icon.ran:
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.005)
        tray.update(True)
        self.assertEqual(icon.title, "TKBCherry Agent · ON")
        self.assertEqual(icon.menu_updates, 1)
        tray.stop()
        self.assertTrue(icon.stopped)


if __name__ == "__main__":
    unittest.main()
