#!/bin/sh
set -eu
mkdir -p dist/server dist/.openai
cp worker/index.js dist/server/index.js
cp LICENSE dist/LICENSE
cp .openai/hosting.json dist/.openai/hosting.json
