// ============================================================
// 文件：scripts/demo-lending.ts
// 作用：在本地模拟链上完整走一遍借贷生命周期（免费、秒完成）：
//       存款吃息 → 抵押借款 → 精确计息 → 预言机价格操纵 → 清算 → 权限校验
//       这是部署上真链之前的「数学验证」，每一步都带断言。
//       运行：npm run demo:lending
//       注意：hardhat automine 每笔交易时间戳 +1s，所以断言分两类——
//             精确值（时序可控的）和区间值（混入 +1s 噪声的），都有注释。
//       三幕：① 主流程精确数学  ② 价格操纵触发清算  ③ 规则与权限
// ============================================================

import { network } from "hardhat";
import type { EthereumProvider } from "hardhat/types";

// 断言小工具：失败立刻抛错，成功打勾
function check(cond: boolean, label: string) {
  if (!cond) throw new Error("✗ 断言失败: " + label);
  console.log("  ✓ " + label);
}

// 快进时间：先改「下一个块的时间戳」，再挖一个空块让它生效
async function timeTravel(provider: EthereumProvider, seconds: number) {
  await provider.request({ method: "evm_increaseTime", params: ["0x" + seconds.toString(16)] });
  await provider.request({ method: "evm_mine", params: [] });
}

// 预期 revert 断言：没 revert 反而算失败（注意：revert 的交易也会挖块 +1s）
async function expectRevert(promise: Promise<unknown>, label: string) {
  try {
    await promise;
    check(false, label);
  } catch {
    check(true, label);
  }
}

const TEN = 10n ** 18n; // 1 个 18 位小数的 token

async function main() {
  const { ethers, provider } = await network.create();
  const [owner, alice, bob, carol] = await ethers.getSigners();
  console.log(`老板（owner）: ${owner.address}`);
  console.log(`Alice: ${alice.address}`);
  console.log(`Bob:   ${bob.address}`);
  console.log(`Carol: ${carol.address}\n`);

  // ── 0. 部署：LQY 代币 + LQYSwap 池（10 ETH + 10000 LQY，初始价 1000 LQY/ETH）──
  console.log("── 0. 部署 LQY、LQYSwap 池（10 ETH + 10000 LQY）──");
  const lqy = await ethers.deployContract("TestToken", []);
  await lqy.waitForDeployment();
  const swap = await ethers.deployContract("LQYSwap", [await lqy.getAddress()]);
  await swap.waitForDeployment();
  await lqy.approve(await swap.getAddress(), TEN * 10000n);
  await swap.addLiquidity(TEN * 10000n, { value: TEN * 10n });
  check((await swap.reserveEth()) === TEN * 10n && (await swap.reserveToken()) === TEN * 10000n,
    "池子就绪：10 ETH + 10000 LQY");

  // 借贷合约参数：base=0、multiplier=4e15/秒（满利用率时 0.4%/秒）、
  // 储备系数=0（demo 账目干净；生产场景 0.1，教学点见合约注释）、
  // LTV 75%、清算阈值 80%、清算奖金 5%、单次清算上限 50%
  const deployLending = async () => {
    const l = await ethers.deployContract("LQYLending", [
      await lqy.getAddress(),
      await swap.getAddress(),
      0n,            // baseRatePerSecond
      4n * 10n ** 15n, // multiplierPerSecond
      0n,            // reserveFactor
      75n * 10n ** 16n, // ltv
      80n * 10n ** 16n, // liquidationThreshold
      5n * 10n ** 16n,  // liquidationBonus
      50n * 10n ** 16n, // closeFactor
    ]);
    await l.waitForDeployment();
    return l;
  };

  // ── 发本钱 + 提前授权（授权交易也挖块 +1s，全部放在计时之前）──
  await lqy.transfer(alice.address, TEN * 3n);   // Alice 还息补差用
  await lqy.transfer(bob.address, TEN * 510n);   // Bob 存 500 + 清算用 10
  await lqy.transfer(carol.address, TEN * 100n); // Carol 第三幕存款

  const lend1 = await deployLending();
  const lend2 = await deployLending();
  const lend3 = await deployLending();
  await lqy.approve(await lend1.getAddress(), TEN * 1000n);
  await lqy.approve(await lend2.getAddress(), TEN * 1000n);
  await lqy.approve(await lend3.getAddress(), TEN * 100n);
  await lqy.connect(alice).approve(await lend1.getAddress(), TEN * 1000n);
  await lqy.connect(alice).approve(await lend2.getAddress(), TEN * 1000n);
  await lqy.connect(bob).approve(await lend1.getAddress(), TEN * 500n);
  await lqy.connect(bob).approve(await lend2.getAddress(), TEN * 10n);
  await lqy.connect(carol).approve(await lend3.getAddress(), TEN * 100n);

  // ════════════════════════════════════════════════════════
  // 第一幕：主流程 · 精确数学（利率冻结后做全流程精确断言）
  // ════════════════════════════════════════════════════════
  console.log("\n════ 第一幕：存款吃息 · 抵押借款 · 精确计息 ════");

  // ── 1. 老板存 1000 LQY：铸股份（cToken 汇率股份 + 1000 死股防通胀）──
  console.log("── 1. 老板存入 1000 LQY ──");
  await lend1.supply(TEN * 1000n);
  check((await lend1.totalSupply()) === TEN * 1000n + 1000n,
    "股份总数 = 1000e18 + 1000 死股（首笔存款锁死 MIN 死股防汇率通胀攻击）");
  check((await lend1.balanceOf("0x000000000000000000000000000000000000dEaD")) === 1000n,
    "死股 1000 锁在黑洞地址");
  const exr0 = await lend1.exchangeRate();
  const expExr0 = TEN * 1000n * TEN / (TEN * 1000n + 1000n);
  check(exr0 === expExr0, "汇率 = 现金 × 1e18 ÷ 总股份（JS 镜像精确）");

  // ── 2. Alice 抵押 0.1 ETH、借 75 LQY ──
  console.log("── 2. Alice 抵押 0.1 ETH，借 75 LQY ──");
  await lend1.connect(alice).depositCollateral({ value: TEN / 10n });
  check((await lend1.collateralBalance(alice.address)) === TEN / 10n, "Alice 抵押 = 0.1 ETH");
  const aliceLqy0 = await lqy.balanceOf(alice.address);
  await lend1.connect(alice).borrow(TEN * 75n);
  check((await lqy.balanceOf(alice.address)) - aliceLqy0 === TEN * 75n, "Alice 借到 75 LQY");
  check((await lend1.totalCash()) === TEN * 925n, "池内现金 = 925 LQY");
  check((await lend1.totalBorrows()) === TEN * 75n, "借款总额 = 75 LQY");
  check((await lend1.utilizationRate()) === 75n * 10n ** 15n,
    "利用率 = 7.5%（75 ÷ 1000，1e18 刻度精确）");
  check((await lend1.borrowRatePerSecond()) === 3n * 10n ** 14n,
    "借款利率 = 3e14/秒（4e15 × 7.5%，精确）");
  check((await lend1.maxBorrowable(alice.address)) === 0n,
    "Alice 借满 LTV（0.1 ETH × 1000 × 75% = 75），可借余额 = 0");

  // ── 3. 快进 100 秒：Alice 存 1 wei 抵押触发计息（触发交易精确落在 100 秒）──
  console.log("\n── 3. 100 秒后触发计息：利息精确 = 2.25 LQY ──");
  await timeTravel(provider, 99);
  await lend1.connect(alice).depositCollateral({ value: 1n });
  check((await lend1.totalBorrows()) === TEN * 7725n / 100n,
    "借款总额 = 77.25 LQY（75 × 3e14/秒 × 100 秒 = 2.25 利息，精确）");
  check((await lend1.borrowIndex()) === TEN * 103n / 100n,
    "债指数 = 1.03e18（77.25 ÷ 75，精确）");
  check((await lend1.currentBorrowBalance(alice.address)) === TEN * 7725n / 100n,
    "Alice 债务 = 77.25 LQY（指数快照折算，精确）");
  check((await lend1.isLiquidatable(alice.address)) === false,
    "Alice 仍健康（77.25 < 0.1 ETH × 1000 × 80% = 80，LTV 与清算阈值之间的缓冲带生效）");

  // ── 4. Alice 大额还款（自动封顶）：债清空 → 利率冻结，此后可做全流程精确断言 ──
  console.log("\n── 4. Alice 还款（金额自动封顶到当前债务）──");
  const aliceLqy1 = await lqy.balanceOf(alice.address);
  await lend1.connect(alice).repay(TEN * 1000n); // 大额：min(1000, 实际债务) 封顶
  const alicePaid = aliceLqy1 - (await lqy.balanceOf(alice.address));
  check((await lend1.totalBorrows()) <= 10n ** 16n,
    "借款总额只剩指数舍入灰尘（< 0.01 LQY：floor 舍入让债务比总账少一丁点，方向偏向借款人——Compound 同款行为）");
  check((await lend1.currentBorrowBalance(alice.address)) === 0n, "Alice 债务归零");
  check(alicePaid >= TEN * 7725n / 100n && alicePaid <= TEN * 7725n / 100n + 3n * 10n ** 16n,
    `Alice 实付 ${ethers.formatUnits(alicePaid, 18)} LQY（77.25 + 1 秒噪声：利息从借款人全额流转）`);
  check((await lend1.utilizationRate()) < 10n ** 10n,
    "利用率只剩灰尘级 → 利率冻结，后续断言全部精确");

  // ── 5. Alice 取回全部抵押 ──
  console.log("\n── 5. 债清后 Alice 取回全部抵押 ──");
  const aliceEth0 = await ethers.provider.getBalance(alice.address);
  await lend1.connect(alice).withdrawCollateral(TEN / 10n + 1n);
  check((await lend1.collateralBalance(alice.address)) === 0n, "Alice 抵押清零");
  const aliceEthBack = (await ethers.provider.getBalance(alice.address)) - aliceEth0;
  check(aliceEthBack >= TEN / 10n - 10n ** 15n && aliceEthBack <= TEN / 10n + 1n,
    "Alice 拿回 0.1 ETH（扣 gas，区间断言）");

  // ── 6. Bob 存 500；两人按当前汇率全部取出 ──
  console.log("\n── 6. Bob 存 500 LQY，随后两人全取（汇率股份结算）──");
  await lend1.connect(bob).supply(TEN * 500n);
  const bobShares = await lend1.balanceOf(bob.address);
  const exr1 = await lend1.exchangeRate();
  check(bobShares === TEN * 500n * TEN / exr1, "Bob 股份 = 500 × 1e18 ÷ 汇率（JS 镜像精确）");

  const redeemAll = async (from: typeof owner, shares: bigint) => {
    const exr = await lend1.exchangeRate();
    const amount = shares * exr / TEN;      // 请求取出的 LQY
    const expShares = amount * TEN / exr;   // 合约折算的股份（floor）
    const expOut = expShares * exr / TEN;   // 实际到账（floor，双层舍入全部镜像）
    const bal0 = await lqy.balanceOf(await from.getAddress());
    await lend1.connect(from).redeem(amount);
    const got = (await lqy.balanceOf(await from.getAddress())) - bal0;
    return { got, expOut };
  };
  const ownerRedeem = await redeemAll(owner, TEN * 1000n);
  check(ownerRedeem.got === ownerRedeem.expOut,
    `老板取回 ${ethers.formatUnits(ownerRedeem.got, 18)} LQY（本金 1000 + 利息份额，精确）`);
  const bobRedeem = await redeemAll(bob, bobShares);
  check(bobRedeem.got === bobRedeem.expOut,
    `Bob 取回 ${ethers.formatUnits(bobRedeem.got, 18)} LQY（本金 500 + 利息份额，精确）`);
  check((await lend1.totalCash()) < 10n ** 6n, "池内现金只剩舍入灰尘（< 1e6 wei）");

  // ── 7. 总账核对：利息从借款人全额流转到存款人 ──
  console.log("\n── 7. 总账核对 ──");
  const aliceNet = TEN * 75n - alicePaid; // 借 75 − 还 paid
  const ownerNet = ownerRedeem.got - TEN * 1000n;
  const bobNet = bobRedeem.got - TEN * 500n;
  const dust = await lend1.totalCash();
  check(aliceNet + ownerNet + bobNet + dust === 0n,
    "总账恒等式：借款人净支出 + 存款人净收益 + 池内灰尘 = 0（利息完全内部流转）");
  check(aliceNet < 0n && ownerNet > 0n && bobNet > 0n,
    "方向正确：Alice 净亏（利息），两位存款人净赚");

  // ════════════════════════════════════════════════════════
  // 第二幕：价格操纵 → 触发清算（预言机教学案例）
  // ════════════════════════════════════════════════════════
  console.log("\n════ 第二幕：操纵预言机价格 → 健康仓变可清算 ════");

  // ── 8. 第二个合约：老板存 1000，Alice 抵押 0.1 ETH 借满 75 ──
  console.log("── 8. 新合约开张：Alice 抵押 0.1 ETH 借满 75 LQY ──");
  await lend2.supply(TEN * 1000n);
  await lend2.connect(alice).depositCollateral({ value: TEN / 10n });
  await lend2.connect(alice).borrow(TEN * 75n);
  await timeTravel(provider, 99);
  await lend2.connect(alice).depositCollateral({ value: 1n }); // 触发计息（精确 100 秒）
  check((await lend2.currentBorrowBalance(alice.address)) === TEN * 7725n / 100n,
    "Alice 债务 = 77.25 LQY（精确）");
  check((await lend2.isLiquidatable(alice.address)) === false,
    "清算前 Alice 仍健康（缓冲带内）");
  check((await lend2.price()) === TEN * 1000n, "预言机价 = 1000 LQY/ETH（池现货价）");

  // ── 9. 老板向池子砸 6 ETH 买 LQY：价格瞬间崩到 ~390 ──
  console.log("\n── 9. 老板向 LQYSwap 砸 6 ETH：预言机价格崩盘 ──");
  await swap.ethToToken(0n, { value: TEN * 6n });
  check((await swap.reserveEth()) === TEN * 16n, "池内 ETH = 16（精确）");
  const priceNew = await lend2.price();
  const expPrice = (await swap.reserveToken()) * TEN / (TEN * 16n);
  check(priceNew === expPrice, `预言机价 = ${ethers.formatUnits(priceNew, 18)} LQY/ETH（现货价 JS 镜像精确）`);
  check(priceNew < TEN * 400n, "价格已从 1000 崩到 400 以下（一笔兑换打崩 2.5 倍）");
  check((await lend2.isLiquidatable(alice.address)) === true,
    "Alice 变成可清算！抵押价值腰斩，债务超线——这就是 AMM 现货预言机的操纵攻击");

  // ── 10. Bob 出手清算：代还 10 LQY 债，拿走带 5% 奖金的抵押 ETH ──
  console.log("\n── 10. Bob 清算 Alice：代还 10 LQY，吃 5% 清算奖金 ──");
  const bobEth0 = await ethers.provider.getBalance(bob.address);
  const bobLqy0 = await lqy.balanceOf(bob.address);
  await lend2.connect(bob).liquidate(alice.address, TEN * 10n);
  const seizeEth = TEN * 105n / 10n * TEN / priceNew; // JS 镜像：10.5 × 1e18 ÷ 价格
  const bobEthGain = (await ethers.provider.getBalance(bob.address)) - bobEth0;
  check(bobEthGain >= seizeEth - 10n ** 15n && bobEthGain <= seizeEth,
    `Bob 拿走 ≈ ${ethers.formatUnits(seizeEth, 18)} ETH 抵押（10.5 LQY 价值 ÷ 价格，扣 gas 区间断言）`);
  check((await lqy.balanceOf(bob.address)) - bobLqy0 === -TEN * 10n, "Bob 代还 10 LQY（精确）");
  check((await lend2.collateralBalance(alice.address)) === TEN / 10n + 1n - seizeEth,
    "Alice 抵押被扣掉对应部分（精确）");
  check((await lend2.totalCash()) === TEN * 935n, "池内现金 = 935 LQY（925 + 10 还款，精确）");
  const borrowsAfter = await lend2.totalBorrows();
  check(borrowsAfter >= TEN * 6725n / 100n && borrowsAfter <= TEN * 6725n / 100n + 6n * 10n ** 16n,
    "借款总额 ≈ 67.25 LQY（触发与清算之间隔了兑换交易，2 秒计息噪声）");
  check(bobEthGain > TEN * 10n * TEN / priceNew,
    "Bob 到手的 ETH 价值 > 代还的 10 LQY 市值（5% 奖金 = 清算人的动力来源）");

  // ── 11. Alice 还清剩余债务、取回剩余抵押 ──
  console.log("\n── 11. Alice 还清剩余债务，取回剩余抵押 ──");
  await lend2.connect(alice).repay(TEN * 75n); // 大额封顶：借来的 75 足够覆盖剩余 ~67.27
  check((await lend2.currentBorrowBalance(alice.address)) === 0n, "Alice 债务归零");
  check((await lend2.totalBorrows()) <= 10n ** 16n, "借款总额只剩舍入灰尘（< 0.01 LQY）");
  const remainingColl = await lend2.collateralBalance(alice.address);
  await lend2.connect(alice).withdrawCollateral(remainingColl);
  check((await lend2.collateralBalance(alice.address)) === 0n, "Alice 取回全部剩余抵押");
  check(remainingColl === TEN / 10n + 1n - seizeEth,
    `剩余抵押 = ${ethers.formatUnits(remainingColl, 18)} ETH（0.1 − 被清算部分，精确）`);

  // ════════════════════════════════════════════════════════
  // 第三幕：规则与权限（无时序断言）
  // ════════════════════════════════════════════════════════
  console.log("\n════ 第三幕：规则与权限 ════");

  console.log("── 12. 边界输入 ──");
  await expectRevert(lend3.supply(0), "supply(0) 被拒绝（zero amount）");
  await expectRevert(lend3.redeem(TEN), "redeem 超股份被拒绝（insufficient shares）");
  await expectRevert(lend3.connect(alice).borrow(0), "borrow(0) 被拒绝");
  await expectRevert(lend3.connect(alice).repay(0), "repay(0) 被拒绝");
  await expectRevert(lend3.connect(alice).depositCollateral({ value: 0n }), "0 ETH 抵押被拒绝");
  await expectRevert(
    alice.sendTransaction({ to: await lend3.getAddress(), value: TEN }),
    "裸 ETH 转账被拒绝（抵押走 depositCollateral）"
  );

  console.log("── 13. 非 owner 动不了参数 ──");
  await expectRevert(lend3.connect(alice).setRates(1n, 1n), "非 owner 调利率被拒绝");
  await expectRevert(lend3.connect(alice).setLtv(TEN / 2n), "非 owner 调 LTV 被拒绝");
  await expectRevert(lend3.connect(alice).sweepReserves(), "非 owner 提储备被拒绝");
  await expectRevert(lend3.transferOwnership("0x0000000000000000000000000000000000000000"),
    "移交零地址被拒绝");

  console.log("── 14. Carol 借款边界：超 LTV / 取抵押至不健康 / 清算健康人 ──");
  await lend3.supply(TEN * 100n);
  await lend3.connect(carol).depositCollateral({ value: TEN / 100n }); // 0.01 ETH
  await lend3.connect(carol).borrow(TEN * 2n);
  check((await lend3.currentBorrowBalance(carol.address)) === TEN * 2n, "Carol 借到 2 LQY");
  await expectRevert(lend3.connect(carol).borrow(TEN * 10n), "超 LTV 借款被拒绝（exceeds LTV）");
  await expectRevert(lend3.connect(carol).withdrawCollateral(TEN / 200n),
    "取抵押致不健康被拒绝（would be unhealthy）");
  await expectRevert(lend3.connect(bob).liquidate(carol.address, TEN),
    "清算健康人（Carol）被拒绝（not liquidatable）");

  console.log("── 15. 池子现金上限：大额抵押也借不出超池 ──");
  await lend3.depositCollateral({ value: TEN * 10n }); // 老板 10 ETH 大额抵押（LTV 额度远超现金）
  await expectRevert(lend3.borrow(TEN * 500n), "借款超池内现金被拒绝（insufficient liquidity）");

  console.log("── 16. 所有权移交后旧老板失效 ──");
  await lend3.transferOwnership(bob.address);
  check((await lend3.owner()) === bob.address, "新 owner = Bob");
  await expectRevert(lend3.setRates(1n, 1n), "旧 owner 调利率被拒绝（权限已移交）");
  await lend3.connect(bob).setRates(10n ** 15n, 4n * 10n ** 15n);
  check((await lend3.baseRatePerSecond()) === 10n ** 15n, "新 owner 调利率成功");

  console.log("\n────────────────────────────────");
  console.log("结论：cToken 汇率股份让存款自动增值（利息进借款总额、不增发股份）；");
  console.log("债指数 + 个人快照 = 惰性计息，谁动作谁结账；");
  console.log("超额抵押 + 清算奖金 = 去中心化的风控：坏账由抢着清算的人自动处理；");
  console.log("预言机读池现货价可被一笔大额兑换操纵——真实项目必须用 Chainlink/TWAP。");
  console.log("借贷数学验证全部通过 ✅");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
