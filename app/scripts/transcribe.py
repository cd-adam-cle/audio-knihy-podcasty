#!/usr/bin/env python3
"""Přepis kapitol audioknihy lokálním Whisperem (mlx-whisper, Apple Silicon).

Použití:  .venv/bin/python scripts/transcribe.py <složka_knihy> [--prompt "slovník"]
Očekává <složka_knihy>/audio/*.mp3, výstup píše do <složka_knihy>/transcript/NN.json.
Už hotové kapitoly přeskakuje, takže se dá kdykoli přerušit a spustit znovu.
"""
import argparse, json, re, sys, time
from pathlib import Path

import mlx_whisper

MODEL = "mlx-community/whisper-large-v3-turbo"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("book_dir", type=Path)
    ap.add_argument("--prompt", default="", help="slovník jmen a pojmů pro lepší přepis")
    args = ap.parse_args()

    audio_dir = args.book_dir / "audio"
    out_dir = args.book_dir / "transcript"
    out_dir.mkdir(exist_ok=True)

    files = sorted(audio_dir.glob("*.mp3"))
    if not files:
        sys.exit(f"V {audio_dir} nejsou žádné mp3.")

    for f in files:
        m = re.match(r"(\d+)", f.name)
        idx = m.group(1) if m else f.stem
        out = out_dir / f"{idx}.json"
        if out.exists():
            print(f"[skip] {f.name}", flush=True)
            continue
        t0 = time.time()
        print(f"[start] {f.name}", flush=True)
        r = mlx_whisper.transcribe(
            str(f),
            path_or_hf_repo=MODEL,
            language="cs",
            initial_prompt=args.prompt or None,
            condition_on_previous_text=True,
            word_timestamps=False,
            verbose=None,
        )
        segs = [
            {"s": round(s["start"], 2), "e": round(s["end"], 2), "t": s["text"].strip()}
            for s in r["segments"]
            if s["text"].strip()
        ]
        tmp = out.with_suffix(".tmp")
        tmp.write_text(json.dumps({"file": f.name, "segments": segs}, ensure_ascii=False), encoding="utf-8")
        tmp.rename(out)
        dur = segs[-1]["e"] if segs else 0
        print(f"[done] {f.name}: {len(segs)} segmentů, {dur/60:.1f} min zvuku za {(time.time()-t0)/60:.1f} min", flush=True)

    print("HOTOVO", flush=True)


if __name__ == "__main__":
    main()
