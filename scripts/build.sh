#!/bin/sh
# Build a submittable Thunderbird add-on package (.xpi) from the source tree.
#
# An .xpi is just a zip archive with manifest.json at the top level. We ship
# only the files the extension actually loads (see compose_scripts in
# manifest.json) — no tests, tooling, or docs.
set -eu

cd "$(dirname "$0")/.."

version=$(node -p "require('./manifest.json').version")
out="dist/thundervim-${version}.xpi"

rm -rf dist
mkdir -p dist

zip -r -X "$out" manifest.json src \
  -x '*/.DS_Store' -x '.DS_Store' >/dev/null

echo "Built ${out}"
