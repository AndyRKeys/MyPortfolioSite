# Single unified image — includes devDependencies (vitest, puppeteer) so that
# `docker compose exec backend npm test` and post-deploy error-logger checks
# work in all environments. Not resource-constrained; image size is acceptable.
FROM node:20-alpine

# Install system dependencies for Puppeteer (headless browser testing)
RUN apk add --no-cache \
  ca-certificates \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ttf-freefont \
  libstdc++ \
  git \
  docker-cli \
  docker-compose

WORKDIR /app

# /repo is a bind-mount owned by the host user; container runs as root.
# Git 2.35+ (CVE-2022-24765) rejects git commands in directories not owned
# by the current user unless explicitly allowed.
RUN git config --global --add safe.directory /repo

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
