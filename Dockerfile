# syntax=docker/dockerfile:1

FROM node:26-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Node 26 no longer bundles corepack, so install it first.
RUN npm install --global corepack@0.36.0 && corepack enable
WORKDIR /repo

# Install with only the manifests first so the dependency layer stays cached.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY actions/fix-runner/package.json actions/fix-runner/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
# Standalone server folder with its production dependencies only.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @hinomi/server deploy --prod --legacy /out/server

FROM node:26-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    HINOMI_DATA_DIR=/data \
    PORT=3000

# A fixed high uid/gid so files on the volume never map to a real host user.
RUN addgroup -S -g 10001 hinomi \
    && adduser -S -D -H -u 10001 -G hinomi -h /app hinomi \
    && mkdir -p /data \
    && chown 10001:10001 /data

WORKDIR /app
COPY --from=build --chown=10001:10001 /out/server apps/server
COPY --from=build --chown=10001:10001 /repo/apps/web/dist apps/web/dist
# The fix runner action, spawned by the local runner (HINOMI_LOCAL_RUNNER=1). Inert otherwise.
COPY --from=build --chown=10001:10001 /repo/actions/fix-runner/dist actions/fix-runner/dist

USER 10001:10001
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["node", "apps/server/dist/index.mjs"]
