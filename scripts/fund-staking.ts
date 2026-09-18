// ============================================================
// 文件：scripts/fund-staking.ts
// 作用：老板一键往质押池投币发工资：先授权（approve），再注入（depositRewards）。
//       运行：npm run fund:staking
//       金额：.env 的 FUND_AMOUNT（单位 wei），默认 10000 LQY
//       提醒：速率 0.01 LQY/秒时，10000 LQY 约发 11.5 天，快发完再补
// ============================================================

import { network } from "hardhat";

const STAKING_ADDRESS = process.env.STAKING_ADDRESS;
const LQY_ADDRESS = process.env.LQY_ADDRESS ?? "0x32603501302233f4eE2DAbDBeF96EB7951c48aD7";
// 金额走 env 不走命令行参数（hardhat run 会吞掉 CLI 参数）
const FUND_AMOUNT = BigInt(process.env.FUND_AMOUNT ?? 10000n * 10n ** 18n);

async function main() {
  if (!STAKING_ADDRESS) {
    throw new Error("请先在 .env 里填写 STAKING_ADDRESS（部署合约后把地址回填进去）");
  }

  const { ethers } = await network.create();
  const [owner] = await ethers.getSigners();

  // IERC20 是接口、没有独立 artifact，手动用最小 ABI 构造（只放用到的函数）
  const lqy = new ethers.Contract(LQY_ADDRESS, [
    "function approve(address spender, uint256 value) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
  ], owner);
  const staking = await ethers.getContractAt("LQYStaking", STAKING_ADDRESS);

  // 权限预检：不是老板投币会被合约拒绝，提前提醒省 gas
  if ((await staking.owner()) !== owner.address) {
    throw new Error(`当前账户 ${owner.address} 不是老板（owner = ${await staking.owner()}），投币会被拒绝`);
  }

  const amount = FUND_AMOUNT;
  console.log(`准备投币: ${ethers.formatUnits(amount, 18)} LQY`);

  // ① 授权不足则先 approve（「先授权、后调用」两笔交易）
  const allowance = await lqy.allowance(owner.address, STAKING_ADDRESS);
  if (allowance < amount) {
    console.log("授权中…（approve 质押合约可支配你的 LQY）");
    const tx = await lqy.approve(STAKING_ADDRESS, amount);
    console.log("授权交易已广播:", tx.hash);
    await tx.wait();
    console.log("✓ 授权完成");
  } else {
    console.log("✓ 已有足够授权，跳过 approve");
  }

  // ② 注入矿池
  console.log("投币中…（请在 MetaMask 确认 depositRewards）");
  const tx = await staking.depositRewards(amount);
  console.log("投币交易已广播:", tx.hash);
  await tx.wait();
  console.log("✓ 投币完成");

  const pool = await staking.rewardsBalance();
  const rate = await staking.rewardPerSecond();
  console.log("\n── 投币后矿池 ──");
  console.log("池余额:", ethers.formatUnits(pool, 18), "LQY");
  if (rate > 0n) {
    const runwaySec = pool / rate;
    console.log("按当前速率可发:", (Number(runwaySec) / 86400).toFixed(1), "天");
  }
  console.log("待发总额（含已记账未领）:", ethers.formatUnits(await staking.totalDeposited(), 18), "LQY");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
