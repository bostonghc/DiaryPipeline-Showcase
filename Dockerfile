FROM node:24.14.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:24.14.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY server.ts ./server.ts
# The server imports several TypeScript modules from this directory at runtime.
COPY services ./services
COPY firebase-applet-config.json ./firebase-applet-config.json

USER node
CMD ["npm", "start"]
