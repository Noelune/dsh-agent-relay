# dsh-agent-relay broker — optional containerized deployment.
# Build:  docker build -t dsh-agent-relay-broker -f broker/Dockerfile .
# Run:    docker run -p 19121:19121 -v $PWD/broker/data:/app/data dsh-agent-relay-broker
FROM node:20-alpine
WORKDIR /app
COPY broker/package.json ./
RUN npm install --omit=dev || true
COPY broker/src ./src
COPY broker/config.example.yaml ./config.example.yaml
EXPOSE 19121
CMD ["node", "src/index.js"]
