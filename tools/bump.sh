#!/bin/sh
# Оновлює мітку версії в усіх посиланнях на скрипти й стилі, щоб браузери не тримали стару копію.
V=$(date +%Y%m%d%H%M)
cd "$(dirname "$0")/.."
sed -i -E "s/\?v=[0-9a-z]+/?v=$V/g" index.html js/*.js
sed -i -E "s/const VERSION = '[^']*'/const VERSION = '$V'/" js/app.js
echo "version $V"
