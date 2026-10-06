#!/usr/bin/env python3
"""Přidá novou audioknihu do knihovny: rozbalí zip, vyrobí meta.json + book.json, přepíše zvuk a připraví text.

Použití:  .venv/bin/python scripts/add_book.py ~/Downloads/kniha.zip [--title "Název"] [--author "Jméno"] [--narrator "Jméno"]
Poznámka: Shrnutí kapitol (složka insights/) se pak dělají v Claude Code příkazem
          „vytvoř shrnutí kapitol pro <složka_knihy>" – viz README.
"""
import argparse, json, re, subprocess, sys, unicodedata, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
LIBRARY = HERE.parent.parent  # ~/Audioknihy


def slugify(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "kniha"


def natural_key(p: Path):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.name)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("zip", type=Path)
    ap.add_argument("--title")
    ap.add_argument("--author", default="")
    ap.add_argument("--narrator", default="")
    args = ap.parse_args()

    title = args.title or re.sub(r"[-_]+", " ", args.zip.stem).strip().capitalize()
    slug = slugify(args.zip.stem)
    book = LIBRARY / slug
    if book.exists():
        sys.exit(f"{book} už existuje – nic nepřepisuju.")
    audio = book / "audio"
    audio.mkdir(parents=True)

    # bezpečné rozbalení (žádné cesty mimo cílovou složku)
    with zipfile.ZipFile(args.zip) as z:
        for m in z.infolist():
            target = (audio / m.filename).resolve()
            if m.is_dir() or not str(target).startswith(str(audio.resolve())):
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(m) as src, open(target, "wb") as dst:
                dst.write(src.read())

    mp3s = sorted([p for p in audio.rglob("*") if p.suffix.lower() in (".mp3", ".m4a", ".m4b")], key=natural_key)
    if not mp3s:
        sys.exit("V archivu nejsou žádné audio soubory.")
    cover = next((p for p in sorted(audio.rglob("*")) if p.suffix.lower() in (".jpg", ".jpeg", ".png")), None)
    if cover:  # obálka mimo audio/ (audio se do gitu nedává, obálka ano)
        dest = book / f"cover{cover.suffix.lower()}"
        dest.write_bytes(cover.read_bytes())
        cover = dest

    chapters = []
    for p in mp3s:
        name = re.sub(r"^\s*\d+\s*[-_.)]*\s*", "", p.stem).replace("_", " ").strip() or p.stem
        chapters.append({"file": str(p.relative_to(audio)), "title": name[:1].upper() + name[1:]})
    meta = {
        "id": slug, "title": title, "author": args.author, "narrator": args.narrator,
        "cover": str(cover.relative_to(book)) if cover else None, "description": "", "chapters": chapters,
    }
    (book / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Rozbaleno: {len(mp3s)} souborů. Názvy kapitol uprav v {book/'meta.json'} a pak spusť znovu build_book.py.")

    py = sys.executable
    subprocess.run([py, "-I", str(HERE / "build_book.py"), str(book)], check=True)
    subprocess.run([py, str(HERE / "transcribe.py"), str(book)], check=True)
    subprocess.run([py, "-I", str(HERE / "to_text.py"), str(book)], check=True)
    print(f"\nHotovo. Kniha je v {book}. Zbývá vytvořit shrnutí kapitol (složka insights/).")


if __name__ == "__main__":
    main()
