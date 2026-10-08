import pathlib
import time

import serial


PORT = "COM3"
BAUD = 115200
LOG_PATH = pathlib.Path(r"d:\dachicunhouduan\live_serial.log")


def main() -> None:
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(f"\n===== monitor start {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n")
        f.flush()
        while True:
            try:
                with serial.Serial(PORT, BAUD, timeout=0.2) as ser:
                    f.write(f"[monitor] opened {PORT} @ {BAUD}\n")
                    f.flush()
                    while True:
                        data = ser.read(4096)
                        if data:
                            f.write(data.decode("utf-8", errors="replace"))
                            f.flush()
            except Exception as exc:
                f.write(f"[monitor] reopen after error: {exc}\n")
                f.flush()
                time.sleep(1.0)


if __name__ == "__main__":
    main()
