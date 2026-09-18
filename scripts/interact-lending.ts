// ============================================================
// 文件：scripts/interact-lending.ts
// 作用：命令行查看借贷池状态：现金、借款总额、利用率、借贷 APR、预言机价，
//       以及部署账户的仓位（存款、抵押 ETH、债务、健康系数）。
//       运行：npm run interact:lending
//       前提：.env 里已回填 LENDING_ADDRESS
// ============================================================

import { network } from "hardhat";

const LENDING_ADDRESS = process.env.LENDING_ADDRESS;

// 每秒利率 → 年化百分比（1e18 刻度 × 秒数 / 1e18 = 小数，×100 变百分比）
function toApr(ratePerSecond: bigint): string {
  const yearly = ratePerSecond * 31536000n;
  const pct = Number(yearly * 10000n / 10n ** 18n) / 100; // 两位小数
  return `${pct.toFixed(2)}%`;
}

async function main() {
  if (!LENDING_ADDRESS) {
    throw new Error("请先在 .env 里填写 LENDING_ADDRESS（部署合约后把地址回填进去）");
  }

  const { ethers } = await network.create();
  const contract = await ethers.getContractAt("LQYLending", LENDING_ADDRESS);
  const [deployer] = await ethers.getSigners();

  const cash = await contract.totalCash();
  const borrows = await contract.totalBorrows();
  const reserves = await contract.totalReserves();
  const util = await contract.utilizationRate();
  const borrowRate = await contract.borrowRatePerSecond();
  const supplyRate = await contract.supplyRatePerSecond();
  const price = await contract.price();

  console.log("── 借贷池状态 ──");
  console.log("老板:", await contract.owner());
  console.log("存款代币:", await contract.lqy(), "（LQY）");
  console.log("池内现金:", ethers.formatUnits(cash, 18), "LQY");
  console.log("借款总额:", ethers.formatUnits(borrows, 18), "LQY（本金+累计利息）");
  console.log("协议储备:", ethers.formatUnits(reserves, 18), "LQY（利息抽成，归老板）");
  console.log("利用率:", `${(Number(util) / 1e16).toFixed(2)}%`);
  console.log("借款年化:", toApr(borrowRate), "（随利用率上涨）");
  console.log("存款年化:", toApr(supplyRate), "（借款年化 × 利用率 × 90%）");
  console.log("预言机价:", ethers.formatUnits(price, 18), "LQY / ETH（LQYSwap 现货价）");

  console.log("\n── 部署账户仓位 ──");
  const shares = (await contract.balanceOf(deployer.address)) as bigint;
  const exr = (await contract.exchangeRate()) as bigint;
  const depositValue = shares * exr / 10n ** 18n;
  console.log("存款股份:", ethers.formatUnits(shares, 18), "LqLQY");
  console.log("存款价值:", ethers.formatUnits(depositValue, 18), "LQY");
  console.log("抵押 ETH:", ethers.formatUnits(await contract.collateralBalance(deployer.address), 18));
  const debt = (await contract.currentBorrowBalance(deployer.address)) as bigint;
  console.log("当前债务:", ethers.formatUnits(debt, 18), "LQY");
  console.log("健康系数:", debt === 0n
    ? "∞（无债务，不会被清算）"
    : `${ethers.formatUnits((await contract.healthFactor(deployer.address)) as bigint, 18)}（< 1 会被清算）`);
  console.log("最多可借:", ethers.formatUnits(await contract.maxBorrowable(deployer.address), 18), "LQY");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
