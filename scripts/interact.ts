// ============================================================
// 文件：scripts/interact.ts
// 作用：命令行查看池子状态：存量、价格、示例报价。
//       运行：npm run interact
//       前提：.env 里已回填 CONTRACT_ADDRESS
// ============================================================

import { network } from "hardhat";

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

async function main() {
  if (!CONTRACT_ADDRESS) {
    throw new Error("请先在 .env 里填写 CONTRACT_ADDRESS（部署合约后把地址回填进去）");
  }

  const { ethers } = await network.create();
  const contract = await ethers.getContractAt("LQYSwap", CONTRACT_ADDRESS);

  const reserveEth = await contract.reserveEth();
  const reserveToken = await contract.reserveToken();

  console.log("── 池子状态 ──");
  console.log("ETH 存量:", ethers.formatEther(reserveEth));
  console.log("LQY 存量:", ethers.formatUnits(reserveToken, 18));

  if (reserveEth > 0n && reserveToken > 0n) {
    // 当前价格：1 ETH 能换多少 LQY（用合约核心公式实时算）
    const perEth = await contract.getAmountOut(ethers.parseEther("1"), reserveEth, reserveToken);
    console.log("1 ETH ≈", ethers.formatUnits(perEth, 18), "LQY");

    const perLqy = await contract.getAmountOut(ethers.parseUnits("1", 18), reserveToken, reserveEth);
    console.log("1 LQY ≈", ethers.formatEther(perLqy), "ETH");

    // 乘积 k（恒定乘积的「恒定」指的就是它只增不减）
    console.log("k =", (reserveEth * reserveToken).toString());
  } else {
    console.log("（池子还是空的——先加第一笔流动性）");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
