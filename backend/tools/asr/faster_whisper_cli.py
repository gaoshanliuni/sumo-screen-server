#!/usr/bin/env python3
import argparse
import json
import os
import sys


def build_parser():
    parser = argparse.ArgumentParser(
        description="Transcribe one audio file with faster-whisper and print JSON to stdout."
    )
    parser.add_argument("file", help="Audio file path")
    parser.add_argument("--model", default=os.environ.get("FASTER_WHISPER_MODEL", "small"))
    parser.add_argument("--language", default=os.environ.get("FASTER_WHISPER_LANGUAGE", "zh"))
    parser.add_argument("--output_format", default="json")
    parser.add_argument("--output_dir", default="")
    parser.add_argument("--beam_size", type=int, default=int(os.environ.get("FASTER_WHISPER_BEAM_SIZE", "5")))
    parser.add_argument("--device", default=os.environ.get("FASTER_WHISPER_DEVICE", "auto"))
    parser.add_argument("--compute_type", default=os.environ.get("FASTER_WHISPER_COMPUTE_TYPE", "int8"))
    return parser


def write_result(output_dir, output_format, payload):
    if not output_dir:
        return
    os.makedirs(output_dir, exist_ok=True)
    if output_format == "json":
        target = os.path.join(output_dir, "transcript.json")
        with open(target, "w", encoding="utf-8") as fp:
            json.dump(payload, fp, ensure_ascii=False)
    elif output_format == "txt":
        target = os.path.join(output_dir, "transcript.txt")
        with open(target, "w", encoding="utf-8") as fp:
            fp.write(payload.get("text", ""))


def main():
    args = build_parser().parse_args()
    if not os.path.exists(args.file):
        print(json.dumps({"text": "", "error": "audio file not found"}, ensure_ascii=False))
        return 2

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        print(
            json.dumps(
                {
                    "text": "",
                    "error": "faster-whisper is not installed",
                    "detail": str(exc),
                },
                ensure_ascii=False,
            )
        )
        return 3

    try:
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
        segments, info = model.transcribe(args.file, language=args.language or None, beam_size=args.beam_size)
        normalized_segments = []
        texts = []
        for segment in segments:
            text = (segment.text or "").strip()
            if text:
                texts.append(text)
            normalized_segments.append(
                {
                    "start": float(segment.start or 0),
                    "end": float(segment.end or 0),
                    "text": text,
                }
            )
        payload = {
            "text": "".join(texts).strip(),
            "language": getattr(info, "language", args.language),
            "duration": float(getattr(info, "duration", 0) or 0),
            "segments": normalized_segments,
        }
        write_result(args.output_dir, args.output_format, payload)
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"text": "", "error": str(exc)}, ensure_ascii=False))
        return 4


if __name__ == "__main__":
    sys.exit(main())
