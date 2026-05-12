#!/bin/sh
# Run from the arc-agent root where hardhat.config.js lives
cd /workspaces/arc-agent
exec node_modules/.bin/hardhat "$@"
