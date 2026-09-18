// ============================================================
// 文件：scripts/deploy-staking.ts
// 作用：把 LQYStaking 部署到 Sepolia，连接真实 LQP（LQYSwap）和 LQY。
//       运行：npm run deploy:staking
//       部署后把打印出的合约地址回填到 .env 的 STAKING_ADDRESS。
//       规则：质押 LQP 赚 LQY，每秒发 0.01 LQY（每天 864 个）。
// ============================================================

import { network } from "hardhat";

// LQYSwap 合约地址（质押物 LQP 就是它的 ERC20；.env 里配置，默认已部署的 Sepolia 地址）
const SWAP_ADDRESS = process.env.CONTRACT_ADDRESS ?? "0x6BCe945a06EeAe8Af4b3dA8779Ce05133ac6EB26";
// LQY 代币地址（.env 里配置；默认是 lqy-token 项目已部署的 Sepolia 地址）
const LQY_ADDRESS = process.env.LQY_ADDRESS ?? "0x32603501302233f4eE2DAbDBeF96EB7951c48aD7";

// 规则参数：每秒 0.01 LQY（18 位小数）= 每天 864 LQY，够注资 10000 的池子发 11 天半
const REWARD_PER_SECOND = 10n ** 16n;

async function main() {
  const { ethers } = await network.create();

  const [deployer] = await ethers.getSigners();
  console.log(`部署账户: ${deployer.address}`);

  // 构造函数参数：质押代币地址（LQP）、奖励代币地址（LQY）、每秒奖励
  const contract = await ethers.deployContract("LQYStaking", [
    SWAP_ADDRESS,
    LQY_ADDRESS,
    REWARD_PER_SECOND,
  ]);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`合约地址: ${address}`);
  console.log("→ 记得把这个地址回填到 .env 的 STAKING_ADDRESS！");

  console.log(`质押代币: ${await contract.stakeToken()}（LQP = LQYSwap 本身）`);
  console.log(`奖励代币: ${await contract.rewardsToken()}（LQY）`);
  console.log(`每秒奖励: ${ethers.formatUnits(await contract.rewardPerSecond(), 18)} LQY`);
  console.log(`池余额:   ${ethers.formatUnits(await contract.rewardsBalance(), 18)} LQY（还没投币）`);

  console.log("\n下一步：");
  console.log("  1. 验证合约（国内网络先设代理 HTTPS_PROXY=http://127.0.0.1:12000）：");
  console.log(`     npm run verify -- ${address} ${SWAP_ADDRESS} ${LQY_ADDRESS} ${REWARD_PER_SECOND.toString()}`);
  console.log("     （构造参数顺序必须与部署时一致：LQP地址、LQY地址、每秒奖励）");
  console.log("  2. 老板注资发工资：npm run fund:staking");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
