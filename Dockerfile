FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY config/config.example.json ./config/config.json

ENV PORT=3001
ENV TFA_CONFIG=/app/config/config.json
EXPOSE 3001

CMD ["node", "src/server.js"]
