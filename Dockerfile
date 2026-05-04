FROM node:22-alpine

WORKDIR /app

# Copy package.json and package-lock.json first for better caching
COPY package*.json ./

# Install dependencies (ignoring scripts to prevent any binary building issues initially)
RUN npm install

# Copy the rest of the application
COPY . .

RUN npm run build

# Expose libp2p listening port and RPC port
EXPOSE 40001
EXPOSE 8080

# Default command
CMD ["npm", "run", "start"]
