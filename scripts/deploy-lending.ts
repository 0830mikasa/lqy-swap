// ============================================================
// 文件：scripts/deploy-lending.ts
// 作用：把 LQYLending 部署到 Sepolia，连接真实 LQY 和 LQYSwap（当预言机）。
//       运行：npm run deploy:lending
//       部署后把打印出的合约地址回填到 .env 的 LENDING_ADDRESS。
//       利率公式：borrowRate = base + multiplier × 利用率（每秒，1e18 刻度）。
//       池子不用老板注资——资金由存款人提供（存 LQY 的人就是流动性来源）。
// ============================================================

import { network } from "hardhat";

// LQY 代币地址（.env 里配置；默认是 lqy-token 项目已部署的 Sepolia 地址）
const LQY_ADDRESS = process.env.LQY_ADDRESS ?? "0x32603501302233f4eE2DAbDBeF96EB7951c48aD7";
// LQYSwap 合约地址（预言机：价格读它的 reserveToken ÷ reserveEth）
const SWAP_ADDRESS = process.env.CONTRACT_ADDRESS ?? "0x6BCe945a06EeAe8Af4b3dA8779Ce05133ac6EB26";

// 利率参数（每秒 ×1e18）：
//   base = 1e9       → 年化 ≈ 1e9 × 31536000 / 1e18 ≈ 3.2% 底息
//   multiplier = 1e10 → 利用率拉满时再加 ≈ 31.5% 年化（利率随池子被借空而上涨）
const BASE_RATE = 10n ** 9n;
const MULTIPLIER = 10n ** 10n;
// 协议储备：每笔利息的 10% 归协议（其余 90% 归存款人）
const RESERVE_FACTOR = 10n ** 17n;
// 风控三件套：LTV 75%（最多借）< 清算阈值 80%（触发清算），中间 5% 是缓冲带；
// 清算人代还后拿 (1 + 5%) 价值的抵押 ETH；单次清算最多代还债务的 50%
const LTV = 75n * 10n ** 16n;
const THRESHOLD = 80n * 10n ** 16n;
const BONUS = 5n * 10n ** 16n;
const CLOSE_FACTOR = 50n * 10n ** 16n;

async function main() {
  const { ethers } = await network.create();

  const [deployer] = await ethers.getSigners();
  console.log(`部署账户: ${deployer.address}`);

  // 构造函数参数顺序：LQY、LQYSwap（预言机）、底息、乘数、储备率、LTV、清算阈值、清算奖金、清算上限
  const contract = await ethers.deployContract("LQYLending", [
    LQY_ADDRESS,
    SWAP_ADDRESS,
    BASE_RATE,
    MULTIPLIER,
    RESERVE_FACTOR,
    LTV,
    THRESHOLD,
    BONUS,
    CLOSE_FACTOR,
  ]);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`合约地址: ${address}`);
  console.log("→ 记得把这个地址回填到 .env 的 LENDING_ADDRESS！");

  console.log(`存款代币: ${await contract.lqy()}（LQY）`);
  console.log(`预言机:   ${await contract.swap()}（LQYSwap 现货价）`);
  console.log(`股份代号: ${await contract.symbol()}（存款凭证，汇率随利息上涨）`);
  console.log(`底息:     ${ethers.formatUnits(await contract.baseRatePerSecond(), 18)}/秒（≈3.2% 年化）`);
  console.log(`乘数:     ${ethers.formatUnits(await contract.multiplierPerSecond(), 18)}/秒（利用率拉满再加 ≈31.5% 年化）`);
  console.log(`池内现金: ${ethers.formatUnits(await contract.totalCash(), 18)} LQY（还没有存款人）`);

  console.log("\n下一步：");
  console.log("  1. 验证合约（国内网络先设代理 HTTPS_PROXY=http://127.0.0.1:12000）：");
  console.log(`     npm run verify -- ${address} ${LQY_ADDRESS} ${SWAP_ADDRESS} ${BASE_RATE.toString()} ${MULTIPLIER.toString()} ${RESERVE_FACTOR.toString()} ${LTV.toString()} ${THRESHOLD.toString()} ${BONUS.toString()} ${CLOSE_FACTOR.toString()}`);
  console.log("     （构造参数顺序必须与部署时一致）");
  console.log("  2. 查看状态：npm run interact:lending");
  console.log("  3. 存第一笔 LQY 开池 → 抵押 ETH → 借 LQY（前端或 Etherscan 直接调）");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
