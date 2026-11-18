# Runs the blamethestock-mcp stdio server (used by directories such as Glama to start and inspect it).
# docker build -t blamethestock-mcp . && docker run -i --rm blamethestock-mcp
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY README.md LICENSE ./
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "src/index.js"]
