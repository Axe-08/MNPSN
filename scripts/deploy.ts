import { ethers } from "hardhat";

async function main() {
  const factory = await ethers.getContractFactory("SequencerAnchor");
  const anchor = await factory.deploy();
  await anchor.waitForDeployment();
  const address = await anchor.getAddress();
  console.log(`SequencerAnchor deployed to: ${address}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
