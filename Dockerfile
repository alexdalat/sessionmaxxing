FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN npm install --global pnpm@12.3.4
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
COPY server ./server
COPY shared ./shared
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

ARG CLAUDE_CODE_VERSION=2.1.261
ARG CODEX_VERSION=0.153.4
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git ripgrep \
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
