// ============================================================
// 文件：scripts/interact-fishing.ts
// 作用：命令行查看鱼塘状态：鱼池余额、规则、个人数据。
//       运行：npm run interact:fishing
//       前提：.env 里已回填 FISHING_ADDRESS
// ============================================================

import { network } from "hardhat";

const FISHING_ADDRESS = process.env.FISHING_ADDRESS;

async function main() {
  if (!FISHING_ADDRESS) {
    throw new Error("请先在 .env 里填写 FISHING_ADDRESS（部署合约后把地址回填进去）");
  }

  const { ethers } = await network.create();
  const contract = await ethers.getContractAt("LQYFishing", FISHING_ADDRESS);
  const [deployer] = await ethers.getSigners();

  const pond = await contract.pondBalance();
  const reward = await contract.rewardPerFish();
  const cooldown = await contract.cooldown();

  console.log("── 鱼塘状态 ──");
  console.log("奖励代币:", await contract.rewardsToken());
  console.log("老板:", await contract.owner());
  console.log("鱼池余额:", ethers.formatUnits(pond, 18), "LQY");
  console.log("每次奖励:", ethers.formatUnits(reward, 18), "LQY");
  console.log("冷却规则:", Number(cooldown) / 60, "分钟 / 次");

  if (pond >= reward) {
    console.log("可钓鱼次数:", (pond / reward).toString(), "次");
  } else {
    console.log("（鱼池余额已不够发一次奖励——老板该投币了）");
  }

  console.log("\n── 部署账户数据 ──");
  console.log("累计钓鱼:", (await contract.totalFished(deployer.address)).toString(), "条");
  const rem = await contract.remainingCooldown(deployer.address);
  console.log("剩余冷却:", rem > 0n ? `${rem} 秒` : "现在可钓");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
