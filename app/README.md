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

Kroky po přepisu (`add_book.py` je zatím nedělá všechny sám):

```sh
.venv/bin/python scripts/patch_gaps.py  ~/Audioknihy/<kniha>   # doplní vynechané úseky řeči
python3 -I scripts/clean_transcripts.py ~/Audioknihy/<kniha>   # odstraní halucinace na tichu
python3 -I scripts/to_text.py           ~/Audioknihy/<kniha>   # text pro shrnování
```

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
