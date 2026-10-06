# Audioknihy

Osobní přehrávač audioknih s přepisem, orientací v celé knize a shrnutím kapitol. Všechno běží lokálně na tomhle Macu.

## Spuštění

- `./start.sh` – otevře `http://localhost:4321` (jen tento Mac)
- `./start-mobil.sh` – totéž, ale dostupné i z telefonu ve stejné Wi-Fi (vypíše adresu). Server pak vidí každý v síti, nepoužívej ve veřejné Wi-Fi.

Pozice poslechu, rychlost a záložky se ukládají na serveru (`data/progress.json`) a v prohlížeči. Mac i telefon tak mají stejnou pozici.

## Co aplikace umí

- **Orientace**: celá kniha jako osa kapitol s časem začátku, délkou a jednou větou o obsahu; každou kapitolu lze rozbalit na jednotlivé části (kliknutím přeskočíš).
- **Kde jsi skončil**: kapitola, čas, procenta a zbývající čas; co se řešilo před tím a v aktuální části; poslední věty, které jsi slyšel.
- **Přepis** synchronizovaný se zvukem (klik na větu = přeskok), **Poznatky** (shrnutí, 5–8 poznatků, průvodce kapitolou, pojmy), **Hledat** v celé knize.
- Přetáčení ±15/30 s, rychlost 0,8–2×, časovač spánku, záložky, ovládání ze zamčené obrazovky a sluchátek.
- Klávesy: `mezerník` přehrát/pauza, `←`/`→` −15/+30 s, `B` záložka.

## Nová kniha

```sh
cd ~/Audioknihy/app
.venv/bin/python scripts/add_book.py ~/Downloads/kniha.zip --title "Název" --author "Autor" --narrator "Předčítá"
```

Rozbalí zip, zjistí délky, přepíše zvuk (Whisper large-v3-turbo, cca 10× rychleji než realtime) a připraví text. Potom v Claude Code řekni „vytvoř shrnutí kapitol pro knihu <složka>" – shrnutí se ukládají do `insights/NN.json`.

`add_book.py` po přepisu sám doplní vynechané úseky řeči (`patch_gaps.py`), odstraní halucinace na tichu (`clean_transcripts.py`) a připraví text (`to_text.py`). Shrnutí se dělají až z opraveného přepisu.

## Web na Vercelu (poslech odkudkoli)

Git a Vercel nesou jen kód a text; **zvuk se do gitu nedává** (kniha = ~0,5 GB, GitHub odmítne soubor nad 100 MB). Zvuk jde do Cloudflare R2 a aplikace ho čte přes `audioBase` v `meta.json`.

1. Cloudflare dashboard > R2 > vytvoř bucket (např. `audioknihy`) a v jeho nastavení zapni **Public access (R2.dev subdomain)**.
2. R2 > Manage R2 API Tokens > nový token s oprávněním *Object Read & Write* pro ten bucket.
3. `cp .env.example .env` a doplň údaje (soubor `.env` je v `.gitignore`).
4. `.venv/bin/python scripts/upload_audio.py ~/Audioknihy/<kniha>` – nahraje zvuk a zapíše `audioBase`.
5. Commitni `meta.json` + `book.json` a pushni; Vercel se nasadí sám (`vercel.json` je v repu, nic nastavovat nemusíš).

Přepisy a shrnutí (`transcript/`, `insights/`) jsou v `.gitignore`, dokud je GitHub repo veřejné; po přepnutí na soukromé ty dva řádky smaž. Podcasty se nestahují: do `file` kapitoly dej přímo URL epizody a hraje se z původního serveru.

## Struktura

```
~/Audioknihy/
  app/                      kód (server.mjs, public/, scripts/)
  <kniha>/
    audio/  meta.json  book.json
    transcript/NN.json      přepis (věty s časy)
    insights/NN.json        shrnutí kapitoly, poznatky, části, pojmy
    work/NN.txt             čitelný přepis pro shrnování
```
