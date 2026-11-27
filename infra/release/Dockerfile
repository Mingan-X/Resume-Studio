# syntax=docker/dockerfile:1
ARG NODE_IMAGE
ARG DOCKER_CLI_IMAGE
FROM ${DOCKER_CLI_IMAGE} AS docker-cli
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION=12.23.0
WORKDIR /app
RUN npm install --global pnpm@${PNPM_VERSION}
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile
COPY tsconfig.json prisma.config.ts eslint.config.js ./
COPY prisma ./prisma
COPY src ./src
COPY test ./test
COPY scripts ./scripts
COPY resources ./resources
# Non-secret build-only values satisfy the existing config guard; generate never connects.
RUN INFRA_TEST_SCOPE=resume-studio-s12-test DATABASE_URL=postgresql://resume_studio_test:build-only@127.0.0.1:55432/resume_studio_s12_test RABBITMQ_URL=amqp://resume_studio_test:build-only@127.0.0.1:55672/resume-studio-s12-test QDRANT_URL=http://127.0.0.1:56333 QDRANT_API_KEY=build-only-non-secret-placeholder pnpm exec prisma generate && pnpm run build

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY infra/compose.yaml infra/compose.observability.yaml ./infra/
USER 1000:1000
ENTRYPOINT ["node", "scripts/process-supervisor.mjs"]
