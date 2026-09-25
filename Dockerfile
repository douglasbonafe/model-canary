FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
# the canary only needs tsx + zod at runtime
RUN npm ci --omit=dev
COPY tsconfig.json scenarios.json ./
COPY src ./src
# mount a volume at /app/history to keep the rolling baseline between runs
VOLUME /app/history
ENV MODEL=sim-v1
ENTRYPOINT ["npx", "tsx", "src/canary.ts"]
