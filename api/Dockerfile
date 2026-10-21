# Build the bundle first (pnpm --filter @retrysafe/api build): dist/ already contains @retrysafe/core.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Only the runtime npm dependencies the bundle leaves external.
RUN npm install --omit=dev --no-audit --no-fund ts-morph@28 zod@4 picomatch@4 hono@4 @hono/node-server@2

COPY dist ./dist

USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
