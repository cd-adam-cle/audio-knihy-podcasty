#!/usr/bin/env python3
"""Najde v přepisech podezřele dlouhé mezery (Whisper občas vynechá úsek řeči) a doplní je
opakovaným přepisem jen tohoto úseku (bez navazování na předchozí text).

Použití:  .venv/bin/python scripts/patch_gaps.py <složka_knihy> [--min-gap 10] [--dry-run]
"""
import argparse, json, shutil, subprocess, sys
from pathlib import Path

import mlx_whisper

MODEL = "mlx-community/whisper-large-v3-turbo"
PAD = 3.0  # s kontextu před a za mezerou


def find_gaps(segs, min_gap):
    return [(a["e"], b["s"]) for a, b in zip(segs, segs[1:]) if b["s"] - a["e"] > min_gap]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("book_dir", type=Path)
    ap.add_argument("--min-gap", type=float, default=10.0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--prompt", default="")
    args = ap.parse_args()

    tmp = args.book_dir / "work" / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    total = 0
    for f in sorted((args.book_dir / "transcript").glob("*.json")):
        data = json.loads(f.read_text(encoding="utf-8"))
        segs = data["segments"]
        gaps = find_gaps(segs, args.min_gap)
        if not gaps:
            continue
        print(f"{f.name}: mezery {[(round(a), round(b)) for a, b in gaps]}", flush=True)
        if args.dry_run:
            continue
        mp3 = args.book_dir / "audio" / data["file"]
        new_segs = []
        for ga, gb in gaps:
            start = max(0.0, ga - PAD)
            wav = tmp / f"{f.stem}_{int(ga)}.wav"
            subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", str(start), "-t", str(gb - ga + 2 * PAD),
                 "-i", str(mp3), "-ac", "1", "-ar", "16000", str(wav)], check=True)
            r = mlx_whisper.transcribe(
                str(wav), path_or_hf_repo=MODEL, language="cs", initial_prompt=args.prompt or None,
                condition_on_previous_text=False, verbose=None)
            for s in r["segments"]:
                t = s["text"].strip()
                s0, s1 = round(s["start"] + start, 2), round(s["end"] + start, 2)
                # bereme jen to, co leží v mezeře (okraje už v přepisu jsou)
                if t and s0 >= ga - 0.3 and s1 <= gb + 0.3:
                    new_segs.append({"s": s0, "e": s1, "t": t})
            wav.unlink(missing_ok=True)
        if new_segs:
            shutil.copy(f, f.with_suffix(".json.bak"))
            merged = sorted(segs + new_segs, key=lambda x: x["s"])
            data["segments"] = merged
            f.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            total += len(new_segs)
            print(f"  doplněno {len(new_segs)} segmentů", flush=True)
        else:
            print("  nic nového nenalezeno (zřejmě opravdu ticho/hudba)", flush=True)
    print(f"Hotovo, doplněno celkem {total} segmentů.")


if __name__ == "__main__":
    main()
