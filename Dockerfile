# One container: Node server + built web app + the Qloo harness (`qloo mcp`).
# Target: Hugging Face Spaces (Docker SDK, free CPU Basic) or any container host.
# Secrets (QLOO_API_KEY, LLM_API_KEY, ...) are set in the host's secret store, never baked in.
# Official node image via the AWS ECR Public mirror: Docker Hub auth timed out (504) in CI.
FROM public.ecr.aws/docker/library/node:22-slim
WORKDIR /app
RUN npm install --global @qloo/qloo-harness@0.1.26 && qloo --version
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production PORT=7860 QLOO_HOME=/tmp/qloo-home
EXPOSE 7860
USER node
CMD ["node", "server/src/index.ts"]
