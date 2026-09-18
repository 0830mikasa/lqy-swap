// ============================================================
// 文件：scripts/fund-fishing.ts
// 作用：老板一键往鱼池投币：先授权（approve），再注入（depositRewards）。
//       运行：npm run fund:fishing
//       金额：.env 的 FUND_AMOUNT（单位 wei），默认 10000 LQY
//       提醒：投币前最好自己先钓/质押点东西，否则空池期无人领奖
// ============================================================

import { network } from "hardhat";

const FISHING_ADDRESS = process.env.FISHING_ADDRESS;
const LQY_ADDRESS = process.env.LQY_ADDRESS ?? "0x32603501302233f4eE2DAbDBeF96EB7951c48aD7";
// 金额走 env 不走命令行参数（hardhat run 会吞掉 CLI 参数）
const FUND_AMOUNT = BigInt(process.env.FUND_AMOUNT ?? 10000n * 10n ** 18n);

async function main() {
  if (!FISHING_ADDRESS) {
    throw new Error("请先在 .env 里填写 FISHING_ADDRESS（部署合约后把地址回填进去）");
  }

  const { ethers } = await network.create();
  const [owner] = await ethers.getSigners();

  // IERC20 是接口、没有独立 artifact，手动用最小 ABI 构造（只放用到的函数）
  const lqy = new ethers.Contract(LQY_ADDRESS, [
    "function approve(address spender, uint256 value) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
  ], owner);
  const fishing = await ethers.getContractAt("LQYFishing", FISHING_ADDRESS);

  // 权限预检：不是老板投币会被合约拒绝，提前提醒省 gas
  if ((await fishing.owner()) !== owner.address) {
    throw new Error(`当前账户 ${owner.address} 不是老板（owner = ${await fishing.owner()}），投币会被拒绝`);
  }

  const amount = FUND_AMOUNT;
  console.log(`准备投币: ${ethers.formatUnits(amount, 18)} LQY`);

  // ① 授权不足则先 approve（「先授权、后调用」两笔交易）
  const allowance = await lqy.allowance(owner.address, FISHING_ADDRESS);
  if (allowance < amount) {
    console.log("授权中…（approve 钓鱼合约可支配你的 LQY）");
    const tx = await lqy.approve(FISHING_ADDRESS, amount);
    console.log("授权交易已广播:", tx.hash);
    await tx.wait();
    console.log("✓ 授权完成");
  } else {
    console.log("✓ 已有足够授权，跳过 approve");
  }

  // ② 注入鱼池
  console.log("投币中…（请在 MetaMask 确认 depositRewards）");
  const tx = await fishing.depositRewards(amount);
  console.log("投币交易已广播:", tx.hash);
  await tx.wait();
  console.log("✓ 投币完成");

  const pond = await fishing.pondBalance();
  const reward = await fishing.rewardPerFish();
  console.log("\n── 投币后鱼塘 ──");
  console.log("鱼池余额:", ethers.formatUnits(pond, 18), "LQY");
  console.log("可钓鱼次数:", (pond / reward).toString(), "次");

  if (pond === amount) {
    console.log("\n⚠ 注意：鱼池是空的（此前无人投币）。");
    console.log("  若一直没人来钓，这段奖励没有影响；但教学上建议你自己先在网页上钓几次试试。");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
