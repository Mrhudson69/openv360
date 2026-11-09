# syntax=docker/dockerfile:1.7
# Worklens server + dashboard. Build from the repo root: docker build -t worklens .

FROM node:26-slim AS dashboard
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY dashboard/ ./
RUN npm run build

FROM node:26-slim AS server-build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:26-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server/migrations ./migrations
COPY --from=server-build /app/server/dist ./dist
COPY --from=dashboard /app/dashboard/dist /app/dashboard/dist
# Installer templates are optional at build time.
RUN --mount=type=bind,target=/ctx \
    mkdir -p /app/installer && (cp /ctx/installer/install.sh /ctx/installer/install.ps1 /ctx/installer/uninstall.sh /ctx/installer/uninstall.ps1 /app/installer/ 2>/dev/null || true)
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
