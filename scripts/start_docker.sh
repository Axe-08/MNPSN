#!/bin/bash

echo "========================================="
echo " Starting MNPSN Docker Compose Network"
echo "========================================="

# Load .env if it exists (contains ANCHOR_CONTRACT_ADDRESS, DEPLOYER_PRIVATE_KEY, SEPOLIA_RPC_URL)
if [ -f .env ]; then
  set -a
  source .env
  set +a
  echo "Loaded .env file"
fi

# Shared Genesis Timestamp ensures perfectly synchronized slot boundaries
# Set to 90 seconds in the future to give containers time to start and form mesh
export GENESIS_TIMESTAMP=$(( $(date +%s) * 1000 + 90000 ))
echo "GENESIS_TIMESTAMP set to: $GENESIS_TIMESTAMP (90s from now)"

# Secret keys matching the public keys in nodes.json
export VRF_SECRET_KEY_1="0xf2ea907f06885c6508daa290255500278d6db4aed208eaeaf3a552067e2401df"
export VRF_SECRET_KEY_2="0xdd425607f31fcd6311d430b5521a21864e264452251796403e9e8df0d672d9c3"
export VRF_SECRET_KEY_3="0xda247bd488e6a5f39e1f76f631f86a124fbaa5614ae5ff6e1212bbedd64e4b1c"

# Rebuild and start all containers
echo "Building and starting containers..."
docker-compose up --build -d

echo ""
echo "Nodes started! Each node will wait for peer connections before starting consensus."
echo "Tailing all node logs (Press Ctrl+C to stop)..."
echo ""

# Wait for containers to be up before injecting transactions
echo "Waiting 30 seconds for mesh formation and consensus start..."
sleep 30

echo "========================================="
echo " Injecting Test Transactions to Node 1"
echo "========================================="
curl -s --noproxy "*" -X POST http://127.0.0.1:8080/tx \
  -H "Content-Type: application/json" \
  -d '{"sender": "0xAlice", "payload": "0x1234"}'
echo
curl -s --noproxy "*" -X POST http://127.0.0.1:8080/tx \
  -H "Content-Type: application/json" \
  -d '{"sender": "0xBob", "payload": "0x5678"}'
echo
echo "========================================="

echo ""
echo "Transactions injected! Tailing all node logs..."
docker-compose logs -f
