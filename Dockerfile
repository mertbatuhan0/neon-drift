# Neon Drift game server and leaderboard consumer.
# Listens on PORT (default 8787): the game screen, the WebSocket, /health and /leaderboard.
# The leaderboard consumer reads BROKER_TOPIC in group BROKER_GROUP (default team3.leaderboard).
# Pass these at runtime. Do not bake BROKER_PASSWORD into the image:
#   PORT, BROKER_URL, BROKER_USER, BROKER_PASSWORD, BROKER_TOPIC, BROKER_GROUP, LEADERBOARD_PATH
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci

COPY . .
RUN npm run build

ENV PORT=8787
ENV LEADERBOARD_PATH=/tmp/neon-drift/leaderboard.sqlite
EXPOSE 8787

RUN chown -R node:node /app
USER node

CMD ["npm", "start"]
