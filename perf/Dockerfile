FROM oven/bun:1.3

WORKDIR /app

# Copy dependency files first for layer caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy source
COPY src/ src/
COPY perf/ perf/

EXPOSE 3000

CMD ["bun", "run", "perf/server.ts"]
