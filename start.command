#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install || { echo "npm install failed"; read -n 1 -s -r -p "Press any key to exit"; exit 1; }
fi
npm run dev &
sleep 2
open http://localhost:3000
wait





