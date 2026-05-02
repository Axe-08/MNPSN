#!/bin/bash

# Cleanup previous runs
rm -f node1.log node2.log node3.log

echo "========================================="
echo " Starting MNPSN Local E2E Test"
echo "========================================="

echo "Starting Node 1 (RPC 8080)..."
GENESIS_TIMESTAMP=$(date +%s000)
NODE_ID="node-1" PORT="40001" RPC_PORT="8080" GENESIS_TIMESTAMP="$GENESIS_TIMESTAMP" VRF_SECRET_KEY="0xf2ea907f06885c6508daa290255500278d6db4aed208eaeaf3a552067e2401df" npm run dev > node1.log 2>&1 &
NODE1_PID=$!

echo "Waiting for Node 1 to generate its Peer ID..."
# Loop until we find the multiaddr in the log file
while ! grep -q "/ip4/127.0.0.1/tcp/40001/p2p/" node1.log; do
  sleep 0.5
  # Failsafe if Node 1 crashes
  if ! kill -0 $NODE1_PID 2>/dev/null; then
    echo "Node 1 crashed. Check node1.log"
    exit 1
  fi
done

# Extract the multiaddr
BOOTSTRAP_MULTIADDR=$(grep -o "/ip4/127.0.0.1/tcp/40001/p2p/[a-zA-Z0-9]*" node1.log | head -n 1)
echo "Node 1 ready! Multiaddr: $BOOTSTRAP_MULTIADDR"

echo "Starting Node 2 (RPC 8081) and bootstrapping to Node 1..."
NODE_ID="node-2" PORT="40002" RPC_PORT="8081" BOOTSTRAP_NODES="$BOOTSTRAP_MULTIADDR" GENESIS_TIMESTAMP="$GENESIS_TIMESTAMP" VRF_SECRET_KEY="0xdd425607f31fcd6311d430b5521a21864e264452251796403e9e8df0d672d9c3" npm run dev > node2.log 2>&1 &
NODE2_PID=$!

echo "Starting Node 3 (RPC 8082) and bootstrapping to Node 1..."
NODE_ID="node-3" PORT="40003" RPC_PORT="8082" BOOTSTRAP_NODES="$BOOTSTRAP_MULTIADDR" GENESIS_TIMESTAMP="$GENESIS_TIMESTAMP" VRF_SECRET_KEY="0xda247bd488e6a5f39e1f76f631f86a124fbaa5614ae5ff6e1212bbedd64e4b1c" npm run dev > node3.log 2>&1 &
NODE3_PID=$!

echo "Waiting 5 seconds for GossipSub mesh to connect..."
sleep 5

echo "========================================="
echo " Injecting Test Transactions"
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

echo "Transactions injected! Tailing Node 1 logs (Press Ctrl+C to stop all nodes)..."

# Ensure all nodes are killed when the script exits
trap "echo -e '\nShutting down nodes...'; kill $NODE1_PID $NODE2_PID $NODE3_PID 2>/dev/null" EXIT

# Tail the logs so you can see the consensus in real time!
tail -f node1.log
