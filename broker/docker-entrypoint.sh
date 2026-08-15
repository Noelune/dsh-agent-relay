#!/bin/sh
set -eu

if grep -q CHANGE_ME_RUN_SETUP_INIT /app/config.yaml; then
  if [ -z "$RELAY_SECRET" ]; then
    echo "RELAY_SECRET is required when config.yaml is not mounted" >&2
    exit 78
  fi
  # Escape sed metacharacters so an arbitrary RELAY_SECRET cannot corrupt the
  # replacement expression or the YAML.
  escaped=$(printf '%s' "$RELAY_SECRET" | sed 's/[&/\]/\\&/g')
  sed -i "s/CHANGE_ME_RUN_SETUP_INIT/$escaped/" /app/config.yaml
fi

exec node src/index.js --config /app/config.yaml
