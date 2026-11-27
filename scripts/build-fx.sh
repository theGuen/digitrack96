#!/bin/sh
# Compiles fx/*.dsp (Faust) to WebAssembly in src/fx/. Needs the faust CLI (brew install faust).
set -e
cd "$(dirname "$0")/.."
for f in fx/*.dsp; do
  n=$(basename "$f" .dsp)
  faust -lang wasm -json -cn "$n" "$f" -o "src/fx/$n.wasm"
  mv "src/fx/$n.json" "src/fx/$n.json.tmp" 2>/dev/null || true
  [ -f "src/fx/$n.json.tmp" ] && mv "src/fx/$n.json.tmp" "src/fx/$n.json"
  rm -f "src/fx/$n.dsp.json"
  echo "built $n ($(wc -c < "src/fx/$n.wasm") bytes)"
done
