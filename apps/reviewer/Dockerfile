# The reviewer cell as one image: the bundle esbuild builds here, on the published celld
# runtime. Build from the repository root: `docker build -f apps/reviewer/Dockerfile .`
FROM node:24.21.0-bookworm-slim AS build
RUN npm install -g pnpm@12.4.2
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @triage/reviewer...
RUN pnpm --filter @triage/reviewer build

FROM ghcr.io/denoland/celld:v0.5.0
COPY apps/reviewer/wrangler.jsonc /app/wrangler.jsonc
COPY --from=build /app/apps/reviewer/dist /app/dist
COPY apps/reviewer/entrypoint.sh /usr/local/bin/reviewer
RUN chmod +x /usr/local/bin/reviewer
# Cell state (snapshots, review runs) lives under /app/.celld; mount a volume there to keep
# it across deploys (declared by the platform, not here, so builders never see a VOLUME).
# A review stage can wait a long time on one provider response; see docker-compose.yml.
ENV CELLD_HANDLER_BUDGET_S=1800 CELLD_FETCH_TIMEOUT_S=1800
EXPOSE 9876
ENTRYPOINT ["/usr/local/bin/reviewer"]
