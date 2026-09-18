// ============================================================
// 文件：scripts/demo-staking.ts
// 作用：在本地模拟链上完整走一遍质押挖矿生命周期（免费、秒完成）：
//       首质押 → 按秒计息 → 第二人按份额分账 → 取出 → 池子发干截断 →
//       池空后照常领取 → 暂停挖矿 → 逃生舱 → 权限校验 → 总账核对
//       这是部署上真链之前的「数学验证」，每一步都带断言。
//       运行：npm run demo:staking
//       注意：hardhat automine 每笔交易时间戳 +1s，所以断言分两类——
//             精确值（时序可控的）和区间值（混入 +1s 噪声的），都有注释。
// ============================================================

import { network } from "hardhat";
import type { EthereumProvider } from "hardhat/types";

// 断言小工具：失败立刻抛错，成功打勾
function check(cond: boolean, label: string) {
  if (!cond) throw new Error("✗ 断言失败: " + label);
  console.log("  ✓ " + label);
}

// 快进时间：先改「下一个块的时间戳」，再挖一个空块让它生效
// （Hardhat 3 的 provider 要从 network.create() 的返回值拿；
//   EIP-1193 的 request 风格，参数用十六进制字符串）
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
const E12 = 10n ** 12n; // 份额记账精度因子

async function main() {
  const { ethers, provider } = await network.create();
  const [owner, alice, bob, carol] = await ethers.getSigners();
  console.log(`老板（owner）: ${owner.address}`);
  console.log(`Alice: ${alice.address}`);
  console.log(`Bob:   ${bob.address}`);
  console.log(`Carol: ${carol.address}\n`);

  // ── 0. 部署：LQP 代币（LP）+ 奖励代币 REW + 质押合约（每秒 1 REW）──
  console.log("── 0. 部署 LQP、REW 和 LQYStaking（每秒 1 REW，账目好算）──");
  const lqp = await ethers.deployContract("TestToken", []);
  await lqp.waitForDeployment();
  const rew = await ethers.deployContract("TestToken", []);
  await rew.waitForDeployment();
  const staking = await ethers.deployContract("LQYStaking", [
    await lqp.getAddress(),
    await rew.getAddress(),
    TEN, // rewardPerSecond：每秒 1 REW
  ]);
  await staking.waitForDeployment();
  console.log(`  质押合约地址: ${await staking.getAddress()}\n`);

  // 老板注资 1000 REW（发工资的钱袋子）
  await rew.approve(await staking.getAddress(), TEN * 1000n);
  await staking.depositRewards(TEN * 1000n);
  check((await staking.totalDeposited()) === TEN * 1000n, "老板注资 1000 REW");

  // 发本钱：Alice 150 LQP（分两笔质押）、Bob 300、Carol 100
  await lqp.transfer(alice.address, TEN * 150n);
  await lqp.transfer(bob.address, TEN * 300n);
  await lqp.transfer(carol.address, TEN * 100n);

  // 提前授权（授权交易也会挖块 +1s，全部放在计时开始之前，不干扰后面的精确时序）
  await lqp.connect(alice).approve(await staking.getAddress(), TEN * 150n);
  await lqp.connect(bob).approve(await staking.getAddress(), TEN * 300n);

  // ── 1. Alice 第一个进场：质押 100 LQP ──
  console.log("── 1. Alice 第一个质押 100 LQP ──");
  await staking.connect(alice).stake(TEN * 100n);
  check((await staking.totalStaked()) === TEN * 100n, "总质押 = 100 LQP");
  check((await staking.pendingReward(alice.address)) === 0n,
    "Alice 待领 = 0（无回溯领奖：进场前的空池期不补发）");

  // ── 2. 快进 100 秒，Alice 收获：应得整整 100 REW ──
  // 时序技巧：timeTravel(99) 挖的块在 T+99，下一笔交易在 T+100，
  // 距 Alice 质押那一刻（T）刚好 100 秒 → 精确值。
  console.log("\n── 2. 100 秒后 Alice 收获 ──");
  await timeTravel(provider, 99);
  const aliceRew0 = await rew.balanceOf(alice.address);
  await staking.connect(alice).harvest();
  check((await rew.balanceOf(alice.address)) - aliceRew0 === TEN * 100n,
    "Alice 恰好 +100 REW（100 秒 × 每秒 1 个 × 100% 份额）");
  const aliceInfo = await staking.userInfo(alice.address);
  check(aliceInfo[1] === TEN * 100n, "Alice 水位更新：100 REW 已结算");

  // ── 3. Bob 进场：质押 300 LQP ──
  console.log("\n── 3. Bob 质押 300 LQP（进场不回溯，从下一账期起按份额分）──");
  await staking.connect(bob).stake(TEN * 300n);
  check((await staking.totalStaked()) === TEN * 400n, "总质押 = 400 LQP");
  check((await staking.pendingReward(bob.address)) === 0n, "Bob 待领 = 0（不补发进场前的账）");
  const bobInfo0 = await staking.userInfo(bob.address);
  check(bobInfo0[1] === TEN * 303n, "Bob 水位 = 303 REW（进场瞬间先结清了 Alice 的 1 秒账）");

  // ── 4. 再快进 100 秒，Alice 收获 ──
  console.log("\n── 4. 又 100 秒后 Alice 收获 ──");
  await timeTravel(provider, 99);
  const aliceRew1 = await rew.balanceOf(alice.address);
  await staking.connect(alice).harvest();
  check((await rew.balanceOf(alice.address)) - aliceRew1 === TEN * 26n,
    "Alice 恰好 +26 REW（1 秒独自占池 = 1，再 100 秒 × 25% 份额 = 25）");

  // ── 5. Bob 的账：75 REW（75% 份额）──
  console.log("\n── 5. Bob 的待领 ──");
  check((await staking.pendingReward(bob.address)) === TEN * 75n,
    "Bob 待领 = 75 REW（100 秒 × 75% 份额）");

  // ── 6. Bob 取出 150 LQP：奖励跟着一起领 ──
  console.log("\n── 6. Bob 取出 150 LQP ──");
  const bobRew0 = await rew.balanceOf(bob.address);
  await staking.connect(bob).withdraw(TEN * 150n);
  const bobGot = (await rew.balanceOf(bob.address)) - bobRew0;
  check(bobGot >= TEN * 75n && bobGot <= TEN * 76n,
    `Bob 领到 ${ethers.formatUnits(bobGot, 18)} REW（75 上下，混入 1 秒噪声）`);
  check((await staking.totalStaked()) === TEN * 250n, "总质押 = 250 LQP");
  check((await staking.pendingReward(bob.address)) === 0n, "Bob 待领清零");

  // ── 7. 快进排干鱼池：账本截断（totalDeposited − totalAccrued）──
  // 已记账 202、老板投了 1000 → 最多还能再记 798。
  // timeTravel(798) 后 Bob 收获触发结算：elapsed 正好 799，截断到 798。
  console.log("\n── 7. 快进 799 秒：奖励池正好发干 ──");
  await timeTravel(provider, 798);
  await staking.connect(bob).harvest();
  check((await staking.totalAccrued()) === TEN * 1000n, "累计记账 = 1000 REW（截断生效，一分不多记）");
  check((await staking.totalDeposited()) === TEN * 1000n, "累计注入 = 1000 REW");
  const alicePending = await staking.pendingReward(alice.address);
  const poolBal = await staking.rewardsBalance();
  check(alicePending >= TEN * 319n && alicePending <= TEN * 320n,
    `Alice 待领 ≈ 319.45 REW（40% × 798.6 秒）`);
  check(alicePending === poolBal,
    "Alice 待领 == 池余额（账本不膨胀：欠所有人的钱 = 池里剩的钱）");

  // ── 8. 池子空了再快进 100 秒：Alice 照样足额领取 ──
  console.log("\n── 8. 池空后再过 100 秒，Alice 收获 ──");
  await timeTravel(provider, 100);
  const aliceRew2 = await rew.balanceOf(alice.address);
  await staking.connect(alice).harvest();
  const aliceLast = (await rew.balanceOf(alice.address)) - aliceRew2;
  check(aliceLast === alicePending, "Alice 领到与第 7 步完全相同的数额（干涸期不再增长，也不缩水）");
  check((await staking.rewardsBalance()) === 0n, "池余额 = 0");

  // ── 9. 总账核对：发放总额 = 注入总额 ──
  console.log("\n── 9. 总账核对 ──");
  const aliceTotal = await rew.balanceOf(alice.address);
  const bobTotal = await rew.balanceOf(bob.address);
  check(aliceTotal + bobTotal === TEN * 1000n,
    `Alice(${ethers.formatUnits(aliceTotal, 18)}) + Bob(${ethers.formatUnits(bobTotal, 18)}) = 1000 REW，分毫不差`);

  // ── 10. 权限：不是老板的人想注资/调速率 ──
  console.log("\n── 10. 权限校验 ──");
  await expectRevert(staking.connect(alice).depositRewards(TEN), "非 owner 注资被拒绝（only owner）");
  await expectRevert(staking.connect(alice).setRewardPerSecond(TEN), "非 owner 调速率被拒绝");
  await expectRevert(staking.transferOwnership("0x0000000000000000000000000000000000000000"),
    "移交零地址被拒绝");

  // ── 11. 暂停挖矿：速率设 0，时间照走、账不再记 ──
  console.log("\n── 11. 老板把速率设为 0（暂停挖矿），Alice 再质押 50 LQP ──");
  await staking.setRewardPerSecond(0);
  await staking.connect(alice).stake(TEN * 50n);
  await timeTravel(provider, 99);
  await staking.connect(alice).harvest();
  check((await staking.pendingReward(alice.address)) === 0n,
    "暂停期间待领 = 0（速率 0：时间照走，账不记）");
  check((await staking.totalStaked()) === TEN * 300n, "总质押 = 300 LQP");
  await staking.setRewardPerSecond(TEN); // 恢复速率

  // ── 12. 逃生舱（新开第二个合约，账目干净）：Carol 质押后放弃奖励 ──
  console.log("\n── 12. 第二个合约：Carol 质押 100 LQP，100 秒后待领 100 REW ──");
  const staking2 = await ethers.deployContract("LQYStaking", [
    await lqp.getAddress(),
    await rew.getAddress(),
    TEN,
  ]);
  await staking2.waitForDeployment();
  await rew.approve(await staking2.getAddress(), TEN * 1000n);
  await staking2.depositRewards(TEN * 1000n);
  // 授权同样提前（见上：授权交易会挖块 +1s）
  await lqp.connect(carol).approve(await staking2.getAddress(), TEN * 100n);
  await lqp.connect(bob).approve(await staking2.getAddress(), TEN * 1n);
  await staking2.connect(carol).stake(TEN * 100n);
  await timeTravel(provider, 99);
  // Bob 存 1 LQP 的灰尘触发结算（pendingReward 是 view、读陈旧账，
  // 必须有人动作过才能看到最新数字）
  await staking2.connect(bob).stake(TEN * 1n);
  check((await staking2.pendingReward(carol.address)) === TEN * 100n,
    "Carol 待领恰好 = 100 REW（100 秒 × 100% 份额）");

  // ── 13. Carol 走逃生舱：弃奖励、保本金 ──
  console.log("\n── 13. Carol 紧急取出（逃生舱）──");
  const carolLp0 = await lqp.balanceOf(carol.address);
  const carolRew0 = await rew.balanceOf(carol.address);
  await staking2.connect(carol).emergencyWithdraw();
  check((await lqp.balanceOf(carol.address)) - carolLp0 === TEN * 100n, "Carol 本金 100 LQP 全数取回");
  check((await rew.balanceOf(carol.address)) - carolRew0 === 0n, "Carol 奖励分文未得（放弃待领）");
  const carolInfo = await staking2.userInfo(carol.address);
  check(carolInfo[0] === 0n, "Carol 质押数归零");
  check((await staking2.rewardsBalance()) === TEN * 1000n, "弃奖留在池中（余额未动）");

  // ── 14. Bob 收获：只拿自己的，弃奖不直接转给别人 ──
  console.log("\n── 14. 100 秒后 Bob 收获 ──");
  await timeTravel(provider, 98);
  const bobRew1 = await rew.balanceOf(bob.address);
  await staking2.connect(bob).harvest();
  check((await rew.balanceOf(bob.address)) - bobRew1 === TEN * 100n,
    "Bob 恰好 +100 REW（只拿自己的份额，不是 200——弃奖不通过账本转移）");
  check((await staking2.rewardsBalance()) === TEN * 900n, "池余额 = 900 REW");
  check((await staking2.totalAccrued()) === TEN * 200n, "累计记账 = 200 REW（弃奖留在 800 的记账余量里）");
  const carol2 = await rew.balanceOf(carol.address) - carolRew0;
  const bob2 = (await rew.balanceOf(bob.address)) - bobRew1;
  check(TEN * 900n + carol2 + bob2 === TEN * 1000n, "总账：池 900 + Bob 100 + Carol 0 = 注入 1000");

  // ── 15. 边界输入：零质押 / 超额取出 / 空手逃生 ──
  console.log("\n── 15. 边界输入校验 ──");
  await expectRevert(staking2.connect(alice).stake(0), "stake(0) 被拒绝（zero amount）");
  await expectRevert(staking2.connect(carol).withdraw(TEN), "超额取出被拒绝（exceeds stake）");
  await expectRevert(staking2.connect(carol).emergencyWithdraw(), "空手逃生被拒绝（nothing staked）");

  // ── 16. 裸 ETH 与所有权移交 ──
  console.log("\n── 16. 裸 ETH 转账应被拒绝；移交所有权后旧老板失效 ──");
  await expectRevert(
    alice.sendTransaction({ to: await staking2.getAddress(), value: TEN }),
    "裸 ETH 转账被拒绝（本合约不碰 ETH）"
  );
  await staking2.transferOwnership(bob.address);
  check((await staking2.owner()) === bob.address, "新 owner = Bob");
  await expectRevert(staking2.depositRewards(TEN), "旧 owner 注资被拒绝（权限已移交）");
  await staking2.connect(bob).setRewardPerSecond(TEN * 5n);
  check((await staking2.rewardPerSecond()) === TEN * 5n, "新 owner 调速率成功");

  console.log("\n────────────────────────────────");
  console.log("结论：份额记账 = 全局记账 + 个人水位，惰性结算省 gas；");
  console.log("账本截断保证「欠所有人的钱 ≤ 池里剩的钱」，池空也不欠债；");
  console.log("逃生舱放弃奖励保本金，弃奖留在池中做余量。");
  console.log("质押挖矿数学验证全部通过 ✅");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
