# FunPay Ops — сервер с собранным интерфейсом. Данные — в томе /app/data.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production FPO_PORT=5181
# серверу сторонние пакеты не нужны: node:http, node:sqlite, fetch
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY package.json ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
EXPOSE 5181
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- --header="Host: 127.0.0.1:5181" http://127.0.0.1:5181/api/health || exit 1
CMD ["node", "server/index.mjs"]
