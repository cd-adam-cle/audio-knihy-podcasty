#!/usr/bin/env python3
"""Nahraje zvuk knihy do Cloudflare R2 a zapíše "audioBase" do meta.json (+ přegeneruje book.json).

Použití:  .venv/bin/python scripts/upload_audio.py <složka_knihy> [--dry-run]

Přihlašovací údaje se čtou z app/.env (v .gitignore, nikdy se necommituje) nebo z prostředí:
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
  R2_PUBLIC_BASE   veřejná adresa bucketu, např. https://pub-xxxxxxxx.r2.dev
Už nahrané soubory (stejný název a velikost) se přeskakují, takže skript lze pouštět opakovaně.
"""
import argparse, json, mimetypes, os, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
AUDIO_EXT = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".m4b": "audio/mp4"}


def load_env():
    f = APP / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("book_dir", type=Path)
    ap.add_argument("--dry-run", action="store_true", help="jen vypíše, co by se nahrálo (bez přihlášení)")
    args = ap.parse_args()
    load_env()

    book = args.book_dir.expanduser().resolve()
    meta_file = book / "meta.json"
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    book_id = meta["id"]
    files = sorted(p for p in (book / "audio").rglob("*") if p.suffix.lower() in AUDIO_EXT)
    if not files:
        sys.exit(f"V {book/'audio'} nejsou žádné audio soubory.")

    public_base = os.environ.get("R2_PUBLIC_BASE", "").rstrip("/")
    audio_base = f"{public_base}/{book_id}/" if public_base else "(R2_PUBLIC_BASE není nastavená)"
    total = sum(p.stat().st_size for p in files)
    print(f"{len(files)} souborů, {total/1e6:.0f} MB -> bucket klíče {book_id}/audio/…  audioBase = {audio_base}")

    if args.dry_run:
        for p in files:
            print(f"  {p.relative_to(book)}  ({p.stat().st_size/1e6:.1f} MB)")
        return

    missing = [k for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE") if not os.environ.get(k)]
    if missing:
        sys.exit("Chybí v app/.env: " + ", ".join(missing) + "  (vzor je v app/.env.example)")

    import boto3
    from botocore.exceptions import ClientError

    s3 = boto3.client(
        "s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )
    bucket = os.environ["R2_BUCKET"]

    for i, p in enumerate(files, 1):
        key = f"{book_id}/{p.relative_to(book).as_posix()}"
        size = p.stat().st_size
        try:
            if s3.head_object(Bucket=bucket, Key=key)["ContentLength"] == size:
                print(f"[{i}/{len(files)}] přeskočeno (už nahráno): {key}")
                continue
        except ClientError as e:
            if e.response["Error"]["Code"] not in ("404", "NoSuchKey", "NotFound"):
                raise
        print(f"[{i}/{len(files)}] nahrávám {key} ({size/1e6:.1f} MB)…", flush=True)
        s3.upload_file(
            str(p), bucket, key,
            ExtraArgs={"ContentType": AUDIO_EXT[p.suffix.lower()], "CacheControl": "public, max-age=31536000, immutable"},
        )

    meta["audioBase"] = f"{public_base}/{book_id}/"
    meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    subprocess.run([sys.executable, "-I", str(HERE / "build_book.py"), str(book)], check=True)
    print(f"Hotovo. audioBase = {meta['audioBase']}\nTeď commitni meta.json + book.json a pushni – Vercel se nasadí sám.")


if __name__ == "__main__":
    main()
