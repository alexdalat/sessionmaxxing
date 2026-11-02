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

ARG CLAUDE_CODE_VERSION=latest
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git openssh-client ripgrep \
        fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
        libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnss3 \
        libpango-1.0-0 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
        libxkbcommon0 libxrandr2 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@12.3.4 \
        @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && npm cache clean --force

ARG RUNTIME_UID
ARG RUNTIME_GID
ARG RUNTIME_HOME
RUN set -eux; \
    for id in RUNTIME_UID RUNTIME_GID; do \
        case "$(printenv "$id")" in ''|*[!0-9]*|0*) echo "$id must be a non-zero numeric id" >&2; exit 1;; esac; \
    done; \
    test -n "$RUNTIME_HOME"; \
    owner="$(getent passwd "$RUNTIME_UID" | cut -d: -f1)"; \
    if [ -n "$owner" ]; then userdel --remove "$owner"; fi; \
    group="$(getent group "$RUNTIME_GID" | cut -d: -f1)"; \
    if [ -n "$group" ]; then groupdel "$group"; fi; \
    groupadd --gid "$RUNTIME_GID" sessionmaxxing; \
    useradd --uid "$RUNTIME_UID" --gid "$RUNTIME_GID" --no-create-home \
        --home-dir "$RUNTIME_HOME" --shell /bin/bash sessionmaxxing; \
    install -d -m 0755 -o "$RUNTIME_UID" -g "$RUNTIME_GID" "$RUNTIME_HOME"

ENV NODE_ENV=production \
    HOME=${RUNTIME_HOME} \
    SESSIONMAXXING_HOST=0.0.0.0 \
    SESSIONMAXXING_PORT=4317 \
    DISABLE_AUTOUPDATER=1
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER ${RUNTIME_UID}:${RUNTIME_GID}
RUN claude --version
EXPOSE 4317
CMD ["node", "dist/server/server/main.js"]
