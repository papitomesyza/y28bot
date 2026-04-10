FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
RUN cd dashboard && npm ci

COPY . .

RUN cd dashboard && npm run build

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server/index.js"]
