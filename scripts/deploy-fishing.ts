// ============================================================
// 文件：scripts/deploy-fishing.ts
// 作用：把 LQYFishing 部署到 Sepolia，连接真实 LQY 代币。
//       运行：npm run deploy:fishing
//       部署后把打印出的合约地址回填到 .env 的 FISHING_ADDRESS。
//       规则：每地址 5 分钟钓一次，每次奖励 10 LQY。
// ============================================================

import { network } from "hardhat";

// LQY 代币地址（.env 里配置；默认是 lqy-token 项目已部署的 Sepolia 地址）
const LQY_ADDRESS = process.env.LQY_ADDRESS ?? "0x32603501302233f4eE2DAbDBeF96EB7951c48aD7";

// 规则参数：冷却 300 秒（5 分钟）/ 每次奖励 10 LQY（18 位小数）
const COOLDOWN = 300;
const REWARD_PER_FISH = 10n * 10n ** 18n;

async function main() {
  const { ethers } = await network.create();

  const [deployer] = await ethers.getSigners();
  console.log(`部署账户: ${deployer.address}`);

  // 构造函数参数：奖励代币地址、冷却秒数、每次奖励
  const contract = await ethers.deployContract("LQYFishing", [
    LQY_ADDRESS,
    COOLDOWN,
    REWARD_PER_FISH,
  ]);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`合约地址: ${address}`);
  console.log("→ 记得把这个地址回填到 .env 的 FISHING_ADDRESS！");

  console.log(`奖励代币: ${await contract.rewardsToken()}`);
  console.log(`冷却规则: ${await contract.cooldown()} 秒 / 次（5 分钟）`);
  console.log(`每次奖励: ${ethers.formatUnits(await contract.rewardPerFish(), 18)} LQY`);
  console.log(`鱼池余额: ${ethers.formatUnits(await contract.pondBalance(), 18)} LQY（还没投币）`);

  console.log("\n下一步：");
  console.log("  1. 验证合约（国内网络先设代理 HTTPS_PROXY=http://127.0.0.1:12000）：");
  console.log(`     npm run verify -- ${address} ${LQY_ADDRESS} ${COOLDOWN} ${REWARD_PER_FISH.toString()}`);
  console.log("     （构造参数顺序必须与部署时一致：LQY地址、冷却秒数、每次奖励）");
  console.log("  2. 老板往鱼池投币：npm run fund:fishing");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
