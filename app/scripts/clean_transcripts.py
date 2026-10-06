#!/usr/bin/env python3
"""Vyčistí typické halucinace Whisperu v přepisech:
  - segmenty za koncem zvuku (Whisper si na tichu vymýšlí text až do konce 30s okna),
  - známé „titulkové“ hlášky na konci kapitoly (Titulky vytvořil …, Děkuji za sledování …),
  - zacyklená opakování (stejná věta 3× a víc za sebou; na konci kapitoly 2× a víc).
Idempotentní – lze pouštět opakovaně. Původní soubor se zálohuje jako NN.json.orig (jen poprvé).

Použití:  python3 -I scripts/clean_transcripts.py <složka_knihy>
"""
import json, re, shutil, sys
from pathlib import Path

HALLU = re.compile(r"^\W*(titulky|překlad|přeložil|děkuji za (sledování|pozornost)|dík za sledování|www\.|subtitles|thanks for watching)", re.I)
TAIL = 90.0  # s před koncem, kde hledáme „titulkové“ hlášky
TAIL_REP = 30.0


def norm(t):
    return re.sub(r"\W+", " ", t.lower()).strip()


def clean(segs, dur):
    out, dropped = [], []
    for s in segs:
        if s["s"] >= dur - 0.3:
            dropped.append((s, "za koncem zvuku")); continue
        if s["s"] > dur - TAIL and HALLU.match(s["t"]):
            dropped.append((s, "titulková hláška")); continue
        out.append({**s, "e": round(min(s["e"], dur), 2)})
    # opakování
    res, i = [], 0
    while i < len(out):
        j = i
        while j + 1 < len(out) and norm(out[j + 1]["t"]) == norm(out[i]["t"]):
            j += 1
        run = j - i + 1
        in_tail = out[i]["s"] > dur - TAIL_REP
        if (run >= 3) or (run >= 2 and in_tail):
            for k in range(i + (0 if in_tail else 1), j + 1):
                dropped.append((out[k], f"opakování ×{run}"))
            if not in_tail:
                res.append(out[i])
        else:
            res.extend(out[i:j + 1])
        i = j + 1
    return res, dropped


def main():
    book = Path(sys.argv[1]).expanduser()
    meta = json.loads((book / "book.json").read_text(encoding="utf-8"))
    dur_by_id = {c["id"]: c["duration"] for c in meta["chapters"]}
    total = 0
    for f in sorted((book / "transcript").glob("*.json")):
        data = json.loads(f.read_text(encoding="utf-8"))
        dur = dur_by_id.get(f.stem)
        if dur is None:
            continue
        res, dropped = clean(data["segments"], dur)
        if dropped:
            orig = f.with_suffix(".json.orig")
            if not orig.exists():
                shutil.copy(f, orig)
            data["segments"] = res
            f.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            total += len(dropped)
            for s, why in dropped:
                print(f"  {f.stem} @{int(s['s'])}s [{why}]: {s['t'][:60]}")
    print(f"Odstraněno celkem {total} segmentů.")


if __name__ == "__main__":
    main()
