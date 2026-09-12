// ============================================================
// 文件：scripts/deploy.ts
// 作用：把 LQYSwap 部署到 Sepolia，连接真实 LQY 代币。
//       运行：npm run deploy
//       部署后把打印出的合约地址回填到 .env 的 CONTRACT_ADDRESS。
// ============================================================

import { network } from "hardhat";

// LQY 代币地址（.env 里配置；默认是 lqy-token 项目已部署的 Sepolia 地址）
const LQY_ADDRESS = process.env.LQY_ADDRESS ?? "0x32603501302233f4eE2DAbDBeF96EB7951c48aD7";

async function main() {
  const { ethers } = await network.create();

  const [deployer] = await ethers.getSigners();
  console.log(`部署账户: ${deployer.address}`);

  // 构造函数参数：LQY 代币地址
  const contract = await ethers.deployContract("LQYSwap", [LQY_ADDRESS]);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`合约地址: ${address}`);
  console.log("→ 记得把这个地址回填到 .env 的 CONTRACT_ADDRESS！");

  console.log(`LP 代币: ${await contract.name()}（${await contract.symbol()}）`);
  console.log(`池中 ETH: ${ethers.formatEther(await contract.reserveEth())}`);
  console.log(`池中 LQY: ${ethers.formatUnits(await contract.reserveToken(), 18)}`);
  console.log("\n下一步：往池子里加第一笔流动性（用前端或 interact.ts 脚本）");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
