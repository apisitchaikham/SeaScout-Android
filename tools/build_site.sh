#!/usr/bin/env bash
# Assemble the website from the app files in this repo (same app as the APK).
set -euo pipefail
rm -rf site && mkdir -p site
cp -r www/. site/
unzip -q -o data/eot20.zip -d site/
cp site_headers site/_headers
echo "site files: $(find site -type f | wc -l)"
