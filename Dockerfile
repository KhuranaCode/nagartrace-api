# UNTESTED here (no Docker in the build sandbox). Verify on first use.
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
USER node
CMD ["npm","start"]
