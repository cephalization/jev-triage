# The API with the web app built in: one process, one origin, serving `/` and `/api`.
# Build from the repository root: `docker build -f apps/api/Dockerfile .`
# Node and pnpm match the versions pinned in package.json under devEngines.
FROM node:24.21.0-bookworm-slim AS base
RUN npm install -g pnpm@12.4.2
WORKDIR /app

# The web build needs every dev dependency (Vite+); it is thrown away after.
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @triage/web build

# The API runs its TypeScript directly, as `pnpm start` does, so only its production
# dependencies (and the workspace packages it imports) are installed.
FROM base AS runtime
ENV NODE_ENV=production
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter @triage/api...
COPY --from=build /app/apps/web/dist /app/apps/web/dist
ENV WEB_DIST=/app/apps/web/dist
WORKDIR /app/apps/api
EXPOSE 3939
# Migrations are a separate step (`node src/db/migrate.ts`): Railway's pre-deploy command,
# or run it by hand before the first start.
CMD ["node", "src/index.ts"]
