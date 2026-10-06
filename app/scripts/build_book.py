#!/usr/bin/env python3
"""Z meta.json + mp3 souborů vyrobí book.json (délky kapitol, globální offsety).

Použití:  python3 scripts/build_book.py <složka_knihy>
"""
import json, re, subprocess, sys
from pathlib import Path


def duration(mp3: Path) -> float:
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(mp3)], capture_output=True, text=True
    ).stderr
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", out)
    if not m:
        raise SystemExit(f"Nepodařilo se zjistit délku: {mp3}")
    h, mi, s = int(m[1]), int(m[2]), float(m[3])
    return round(h * 3600 + mi * 60 + s, 2)


def main():
    book_dir = Path(sys.argv[1]).expanduser()
    meta = json.loads((book_dir / "meta.json").read_text(encoding="utf-8"))
    offset = 0.0
    chapters = []
    for i, ch in enumerate(meta["chapters"], start=1):
        d = duration(book_dir / "audio" / ch["file"])
        chapters.append(
            {
                "index": i,
                "id": f"{i:02d}",
                "title": ch["title"],
                "file": f"audio/{ch['file']}",
                "duration": d,
                "offset": round(offset, 2),
            }
        )
        offset += d
    book = {k: v for k, v in meta.items() if k != "chapters"}
    book["duration"] = round(offset, 2)
    book["chapters"] = chapters
    (book_dir / "book.json").write_text(json.dumps(book, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{book['title']}: {len(chapters)} kapitol, {offset/3600:.2f} h")


if __name__ == "__main__":
    main()
