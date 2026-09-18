// ============================================================
// 文件：scripts/interact-staking.ts
// 作用：命令行查看质押矿池状态：总质押、速率、池余额、个人数据。
//       运行：npm run interact:staking
//       前提：.env 里已回填 STAKING_ADDRESS
// ============================================================

import { network } from "hardhat";

const STAKING_ADDRESS = process.env.STAKING_ADDRESS;

async function main() {
  if (!STAKING_ADDRESS) {
    throw new Error("请先在 .env 里填写 STAKING_ADDRESS（部署合约后把地址回填进去）");
  }

  const { ethers } = await network.create();
  const contract = await ethers.getContractAt("LQYStaking", STAKING_ADDRESS);
  const [deployer] = await ethers.getSigners();

  const totalStaked = await contract.totalStaked();
  const rate = await contract.rewardPerSecond();
  const pool = await contract.rewardsBalance();

  console.log("── 质押矿池状态 ──");
  console.log("老板:", await contract.owner());
  console.log("质押代币:", await contract.stakeToken(), "（LQP）");
  console.log("奖励代币:", await contract.rewardsToken(), "（LQY）");
  console.log("总质押:", ethers.formatUnits(totalStaked, 18), "LQP");
  console.log("每秒奖励:", ethers.formatUnits(rate, 18), "LQY");
  console.log("每天奖励:", ethers.formatUnits(rate * 86400n, 18), "LQY");
  console.log("池余额:", ethers.formatUnits(pool, 18), "LQY");

  if (rate > 0n) {
    const runwaySec = pool / rate;
    console.log(`可持续: 约 ${(Number(runwaySec) / 86400).toFixed(1)} 天（无人增持前提下）`);
  } else {
    console.log("（速率为 0：挖矿暂停中）");
  }

  if (totalStaked > 0n && rate > 0n) {
    // 全池每日收益率：每天总奖励 / 总质押
    const apy = Number(rate * 86400n * 10000n / totalStaked) / 10000;
    console.log(`全池日收益率: ${(apy * 100).toFixed(2)}%/天（随份额摊薄）`);
  }

  console.log("\n── 部署账户数据 ──");
  const info = await contract.userInfo(deployer.address);
  console.log("已质押:", ethers.formatUnits(info[0], 18), "LQP");
  console.log("待领奖励:", ethers.formatUnits(await contract.pendingReward(deployer.address), 18), "LQY");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
