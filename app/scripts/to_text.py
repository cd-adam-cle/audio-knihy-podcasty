#!/usr/bin/env python3
"""Převede transcript/NN.json na čitelný text work/NN.txt (jeden řádek = jedna věta: "[sekundy] text").

Použití:  python3 -I scripts/to_text.py <složka_knihy>
Slouží jako vstup pro shrnování kapitol (člověk i model to přečtou snadno po částech).
"""
import json, sys
from pathlib import Path


def main():
    book = Path(sys.argv[1]).expanduser()
    out = book / "work"
    out.mkdir(exist_ok=True)
    for f in sorted((book / "transcript").glob("*.json")):
        segs = json.loads(f.read_text(encoding="utf-8"))["segments"]
        lines = [f"[{int(s['s'])}] {s['t']}" for s in segs]
        (out / f"{f.stem}.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"{f.stem}: {len(lines)} řádků")


if __name__ == "__main__":
    main()
