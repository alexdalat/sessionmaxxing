FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN npm install --global pnpm@12.3.4
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.server.json next.config.ts postcss.config.mjs ./
COPY app ./app
COPY server ./server
COPY shared ./shared
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

ARG CLAUDE_CODE_VERSION=2.1.261
ARG CODEX_VERSION=0.153.4
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git ripgrep \
        fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
        libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnss3 \
        libpango-1.0-0 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
        libxkbcommon0 libxrandr2 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@12.3.4 \
        @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
        @openai/codex@${CODEX_VERSION} \
    && npm cache clean --force

RUN groupadd --gid 1000 user \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash user \
    && install -d -m 0700 -o 1000 -g 1000 /app/data

ENV NODE_ENV=production \
    HOME=/home/user \
    HOST=0.0.0.0 \
    PORT=4317 \
    DISABLE_AUTOUPDATER=1
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER 1000:1000
RUN claude --version && codex --version
EXPOSE 4317
CMD ["node", "dist/server/server/main.js"]
