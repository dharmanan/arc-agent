# syntax=docker/dockerfile:1
# ─── Arc Agent Backend ────────────────────────────────────────────────────────
# Secrets are NEVER baked into the image; Railway injects them at runtime only.
FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer cache)
COPY backend/package*.json ./
RUN npm install --omit=dev --ignore-scripts

# Copy application source
COPY backend/src ./src

EXPOSE 3001

CMD ["node", "src/server.js"]
