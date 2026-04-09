FROM node:25-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production image
FROM node:25-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Default data directory
RUN mkdir -p /data

EXPOSE 3000

# Default: HTTP server on port 3000
ENTRYPOINT ["node", "dist/mcp/cli.js"]
CMD ["--path", "/data", "--http", "--host", "0.0.0.0", "--port", "3000"]
