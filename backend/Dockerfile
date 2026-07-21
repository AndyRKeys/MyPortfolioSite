# Single unified image — includes devDependencies (vitest, puppeteer, playwright) so that
# `docker compose exec backend npm test` and post-deploy browser checks
# work in all environments. Not resource-constrained; image size is acceptable.
#
# Debian bookworm-slim base: Alpine (musl libc) cannot run Playwright's patched
# Firefox build, which is compiled for glibc. Switched in #527.
FROM node:20-bookworm-slim

# System tools + system Chromium (for Puppeteer's five legacy scripts)
# wget: relied on by docker-compose.yml/.local.yml healthchecks and the
# migration-restore.sh / server-setup.sh readiness polls — Debian's slim
# base doesn't ship it the way Alpine's busybox did.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    gnupg \
    chromium \
    git \
    ffmpeg \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI + Compose plugin (official Docker apt repo)
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
       | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose

# /repo is a bind-mount owned by the host user; container runs as root.
# Git 2.35+ (CVE-2022-24765) rejects git commands in directories not owned
# by the current user unless explicitly allowed.
RUN git config --global --add safe.directory /repo

# Puppeteer: use system Chromium (at /usr/bin/chromium on Debian)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Playwright: skip auto-download during npm install (explicit install below)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

COPY package*.json ./
RUN npm install --silent

# Install Playwright's managed Chromium + Firefox (patched builds) with all
# required system libraries. --with-deps runs apt to satisfy browser deps.
RUN npx playwright install --with-deps chromium firefox

COPY . .

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

EXPOSE ${PORT:-8080}
CMD ["node", "server.js"]
