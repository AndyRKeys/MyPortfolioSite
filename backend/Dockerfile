# ── dev stage ──────────────────────────────────────────────────────────────────────────────
# Installs ALL dependencies (including devDependencies) so that
# `docker compose exec backend npm test` works inside the running container.
# Used automatically by docker-compose.yml in local dev (source is volume-mounted).
FROM node:20-alpine AS dev

# Install system dependencies for Puppeteer (headless browser testing)
RUN apk add --no-cache \
  ca-certificates \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ttf-freefont \
  libstdc++

WORKDIR /app

# Tell Puppeteer to use system Chromium instead of downloading its own
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY package*.json ./
RUN npm install --silent

COPY . .

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

EXPOSE ${PORT:-8080}
CMD ["node", "server.js"]

# ── prod stage ───────────────────────────────────────────────────────────────────────────
# Omits devDependencies for a leaner production image.
# prod-deploy.sh builds with: docker build --target prod .
FROM node:20-alpine AS prod

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --silent

COPY . .

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

EXPOSE ${PORT:-8080}
CMD ["node", "server.js"]
