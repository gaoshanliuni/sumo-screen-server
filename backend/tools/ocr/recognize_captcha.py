#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import base64
import json
import sys


def probe_mode() -> int:
    try:
        import ddddocr  # type: ignore  # noqa: F401
        print(json.dumps({"ok": True}))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"missing_ddddocr:{exc}"}))
        return 0


def main() -> int:
    if "--probe" in sys.argv:
        return probe_mode()

    payload_text = sys.stdin.read().strip()
    if not payload_text:
        print(json.dumps({"text": "", "confidence": 0.0, "error": "empty_input"}))
        return 0

    try:
        payload = json.loads(payload_text)
    except Exception:
        print(json.dumps({"text": "", "confidence": 0.0, "error": "invalid_json"}))
        return 0

    image_b64 = str(payload.get("imageBase64", "")).strip()
    if not image_b64:
        print(json.dumps({"text": "", "confidence": 0.0, "error": "empty_image"}))
        return 0

    try:
        image_bytes = base64.b64decode(image_b64, validate=False)
    except Exception:
        print(json.dumps({"text": "", "confidence": 0.0, "error": "invalid_base64"}))
        return 0

    try:
        import ddddocr  # type: ignore
    except Exception as exc:
        print(json.dumps({"text": "", "confidence": 0.0, "error": f"missing_ddddocr:{exc}"}))
        return 0

    try:
        ocr = ddddocr.DdddOcr(show_ad=False)
        text = ocr.classification(image_bytes)
        text = str(text or "").strip()
        print(json.dumps({"text": text, "confidence": 1.0}))
    except Exception as exc:
        print(json.dumps({"text": "", "confidence": 0.0, "error": f"ocr_failed:{exc}"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
