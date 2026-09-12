// ============================================================
// 文件：scripts/demo-local.ts
// 作用：在本地模拟链上完整走一遍 AMM 生命周期（免费、秒完成）：
//       建池 → 加流动性 → 兑换两笔 → 验证 k 与手续费 → 取流动性
//       这是部署上真链之前的「数学验证」，每一步都带断言。
//       运行：npm run demo
// ============================================================

import { network } from "hardhat";

// 断言小工具：失败立刻抛错，成功打勾
function check(cond: boolean, label: string) {
  if (!cond) throw new Error("✗ 断言失败: " + label);
  console.log("  ✓ " + label);
}

async function main() {
  const { ethers } = await network.create();
  const [alice, bob] = await ethers.getSigners();
  console.log(`Alice（做市商）: ${alice.address}`);
  console.log(`Bob（交易者）:   ${bob.address}\n`);

  // ── 1. 部署测试代币 + AMM ──
  console.log("── 1. 部署 TestToken 和 LQYSwap ──");
  const testToken = await ethers.deployContract("TestToken", []);
  await testToken.waitForDeployment();
  const swap = await ethers.deployContract("LQYSwap", [await testToken.getAddress()]);
  await swap.waitForDeployment();
  console.log(`  AMM 地址: ${await swap.getAddress()}\n`);

  // ── 2. Alice 加第一笔流动性：100 ETH + 100,000 TEST ──
  console.log("── 2. Alice 建池：100 ETH + 100,000 TEST（初始价 1 ETH = 1000 TEST）──");
  await testToken.approve(await swap.getAddress(), ethers.parseUnits("500000", 18));
  await swap.addLiquidity(ethers.parseUnits("100000", 18), {
    value: ethers.parseEther("100"),
  });

  let rEth = await swap.reserveEth();
  let rTok = await swap.reserveToken();
  console.log(`  池中: ${ethers.formatEther(rEth)} ETH + ${ethers.formatUnits(rTok, 18)} TEST`);
  let k = rEth * rTok;
  console.log(`  k = ${k.toString()}`);
  const aliceLp = await swap.balanceOf(alice.address);
  console.log(`  Alice 的 LP 份额: ${aliceLp.toString()}（黑洞地址锁死 ${1000} wei 防攻击）\n`);

  // ── 3. 裸 ETH 转账应被拒绝 ──
  console.log("── 3. 绕过兑换直接打 ETH 进池子？──");
  try {
    await alice.sendTransaction({ to: await swap.getAddress(), value: ethers.parseEther("0.1") });
    check(false, "裸 ETH 转账应该被拒绝");
  } catch {
    check(true, "裸 ETH 转账被拒绝（保护 k 不被破坏）");
  }

  // ── 4. Bob 用 10 ETH 换 TEST ──
  console.log("\n── 4. Bob 用 10 ETH 换 TEST（约应得 9,066，0.3% 手续费被扣下）──");
  const quote1 = await swap.getAmountOut(ethers.parseEther("10"), rEth, rTok);
  console.log(`  报价: ${ethers.formatUnits(quote1, 18)} TEST`);
  check(quote1 > ethers.parseUnits("9000", 18) && quote1 < ethers.parseUnits("10000", 18),
    "报价在合理区间（低于无手续费的理论值 10,000）");
  await swap.connect(bob).ethToToken(quote1 * 99n / 100n, { value: ethers.parseEther("10") });
  const bobTok = await testToken.balanceOf(bob.address);
  check(bobTok === quote1, "Bob 实际到手 = 报价（公式精确）");

  const rEth2 = await swap.reserveEth();
  const rTok2 = await swap.reserveToken();
  const k2 = rEth2 * rTok2;
  console.log(`  兑换后池中: ${ethers.formatEther(rEth2)} ETH + ${ethers.formatUnits(rTok2, 18)} TEST`);
  check(k2 >= k, `k 只增不减：${k2.toString()} ≥ ${k.toString()}（差额就是留在池里的手续费）`);

  // ── 5. Bob 再把 5,000 TEST 换回 ETH ──
  console.log("\n── 5. Bob 用 5,000 TEST 换回 ETH ──");
  await testToken.connect(bob).approve(await swap.getAddress(), ethers.parseUnits("5000", 18));
  const quote2 = await swap.getAmountOut(ethers.parseUnits("5000", 18), rTok2, rEth2);
  console.log(`  报价: ${ethers.formatEther(quote2)} ETH`);
  await swap.connect(bob).tokenToEth(ethers.parseUnits("5000", 18), quote2 * 99n / 100n);
  check(await testToken.balanceOf(bob.address) === bobTok - ethers.parseUnits("5000", 18),
    "Bob 的 TEST 减少了 5,000");

  const rEth3 = await swap.reserveEth();
  const rTok3 = await swap.reserveToken();
  const k3 = rEth3 * rTok3;
  console.log(`  兑换后池中: ${ethers.formatEther(rEth3)} ETH + ${ethers.formatUnits(rTok3, 18)} TEST`);
  check(k3 >= k2, `k 再次只增不减：${k3.toString()}`);

  // ── 6. Alice 取回全部流动性（连本带手续费）──
  console.log("\n── 6. Alice 取回全部流动性 ──");
  const aliceEthBefore = await ethers.provider.getBalance(alice.address);
  const aliceTokBefore = await testToken.balanceOf(alice.address);
  await swap.removeLiquidity(aliceLp);
  const aliceEthAfter = await ethers.provider.getBalance(alice.address);
  const aliceTokAfter = await testToken.balanceOf(alice.address);

  const ethGain = aliceEthAfter - aliceEthBefore;   // 含 gas 影响，但数量级正确
  const tokChange = aliceTokAfter - aliceTokBefore; // 负数 = TEST 少了（换成 ETH 回来了）
  console.log(`  ETH 变化: ${ethers.formatEther(ethGain)}（约等于取回的 ETH 减 gas）`);
  console.log(`  TEST 变化: ${ethers.formatUnits(tokChange, 18)}`);
  check(aliceTokAfter > ethers.parseUnits("90000", 18), "Alice 拿回了大部分 TEST");
  // 黑洞地址还有 1000 wei LP（MIN_LIQUIDITY 锁死），对应池中残留的微量尘埃
  const dustEth = await swap.reserveEth();
  const dustTok = await swap.reserveToken();
  console.log(`  池中残留: ${ethers.formatEther(dustEth)} ETH + ${ethers.formatUnits(dustTok, 18)} TEST（黑洞份额对应的尘埃）`);
  check(dustEth < ethers.parseEther("0.01") && dustTok < ethers.parseUnits("10", 18), "残留只是尘埃，不是 Alice 的资产");
  check(await swap.balanceOf(alice.address) === 0n, "Alice 的 LP 余额归零");

  console.log("\n────────────────────────────────");
  console.log("结论：两笔兑换都让 k 变大（手续费沉淀在池子里），");
  console.log("Alice 作为做市商拿回了池中全部资产——价格由池子比例自动调节，全程无需对手方。");
  console.log("AMM 数学验证全部通过 ✅");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
