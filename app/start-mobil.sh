#!/bin/zsh
# Spustí Audioknihy i pro telefon ve stejné Wi-Fi (vypíše adresu). Server pak vidí každý v síti – nepoužívej ve veřejné Wi-Fi.
cd "$(dirname "$0")"
HOST=0.0.0.0 exec node server.mjs
