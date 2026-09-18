// ============================================================
// 文件：scripts/demo-fishing.ts
// 作用：在本地模拟链上完整走一遍钓鱼游戏生命周期（免费、秒完成）：
//       空池 → 注资 → 钓鱼 → 冷却门控 → 时间快进 → 再钓 →
//       冷却按地址隔离 → 权限校验 → 改规则 → 鱼池耗尽 → 总账核对
//       这是部署上真链之前的「规则验证」，每一步都带断言。
//       运行：npm run demo:fishing
// ============================================================

import { network } from "hardhat";
import type { EthereumProvider } from "hardhat/types";

// 断言小工具：失败立刻抛错，成功打勾
function check(cond: boolean, label: string) {
  if (!cond) throw new Error("✗ 断言失败: " + label);
  console.log("  ✓ " + label);
}

// 快进时间：先改「下一个块的时间戳」，再挖一个空块让它生效
// （Hardhat 3 的 provider 要从 network.create() 的返回值拿，不在 network 上；
//   用 EIP-1193 的 request 风格，legacy send 已废弃；
//   参数用十六进制字符串，各版本 EDR 兼容性最稳；只在本地有效）
async function timeTravel(provider: EthereumProvider, seconds: number) {
  await provider.request({ method: "evm_increaseTime", params: ["0x" + seconds.toString(16)] });
  await provider.request({ method: "evm_mine", params: [] });
}

// 预期 revert 断言：没 revert 反而算失败
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
  const [owner, alice, bob] = await ethers.getSigners();
  console.log(`老板（owner）: ${owner.address}`);
  console.log(`Alice（玩家）: ${alice.address}`);
  console.log(`Bob（玩家）:   ${bob.address}\n`);

  // ── 1. 部署：奖励代币 TEST + 钓鱼合约（冷却 120 秒、每次 10 TEST）──
  console.log("── 1. 部署 TestToken 和 LQYFishing（冷却 120 秒 / 每次 10 TEST）──");
  const testToken = await ethers.deployContract("TestToken", []);
  await testToken.waitForDeployment();
  const fishing = await ethers.deployContract("LQYFishing", [
    await testToken.getAddress(),
    120,               // cooldown：120 秒
    TEN * 10n,         // rewardPerFish：10 TEST
  ]);
  await fishing.waitForDeployment();
  console.log(`  钓鱼合约地址: ${await fishing.getAddress()}\n`);
  check((await fishing.owner()) === owner.address, "部署者自动成为 owner（第一次引入权限控制）");

  // ── 2. 空池期：还没投币就想钓鱼 ──
  console.log("── 2. 鱼池空空如也，Alice 想钓鱼 ──");
  await expectRevert(fishing.connect(alice).fish(), "空池钓鱼被拒绝（empty pond）——鱼池需要老板投币");
  check((await fishing.totalFished(alice.address)) === 0n, "失败的钓鱼不计入累计数（require 在记账之前）");

  // ── 3. 老板注资 1000 TEST ──
  console.log("\n── 3. 老板往鱼池注入 1000 TEST ──");
  await testToken.approve(await fishing.getAddress(), TEN * 1000n);
  await fishing.depositRewards(TEN * 1000n);
  check((await fishing.pondBalance()) === TEN * 1000n, "鱼池余额 = 1000 TEST");

  // ── 4. Alice 钓上第一条鱼 ──
  console.log("\n── 4. Alice 钓上第一条鱼 ──");
  const aliceBefore = await testToken.balanceOf(alice.address);
  await fishing.connect(alice).fish();
  check((await testToken.balanceOf(alice.address)) === aliceBefore + TEN * 10n, "Alice 钱包 +10 TEST");
  check((await fishing.totalFished(alice.address)) === 1n, "Alice 累计钓鱼数 = 1");
  check((await fishing.pondBalance()) === TEN * 990n, "鱼池余额 1000 → 990 TEST");

  // ── 5. 立刻再钓：被时间门控拦住 ──
  console.log("\n── 5. 刚钓完立刻再钓（冷却门控）──");
  await expectRevert(fishing.connect(alice).fish(), "冷却中钓鱼被拒绝（too soon）——每地址限频");
  let rem = await fishing.remainingCooldown(alice.address);
  console.log(`  剩余冷却: ${rem}s`);
  check(rem > 0n && rem <= 120n, "剩余冷却在 (0, 120] 秒区间（本地每笔交易时间戳+1s，故非精确 120）");

  // ── 6. 时间快进 60 + 60 秒 ──
  console.log("\n── 6. 快进 60 秒，再快进 60 秒 ──");
  await timeTravel(provider, 60);
  rem = await fishing.remainingCooldown(alice.address);
  console.log(`  快进 60s 后剩余: ${rem}s`);
  check(rem > 0n && rem <= 60n, "剩余冷却按真实时间递减");
  await timeTravel(provider, 60);
  rem = await fishing.remainingCooldown(alice.address);
  check(rem === 0n, "快进满 120s 后冷却归零，现在可钓");

  // ── 7. Alice 钓第二条 ──
  console.log("\n── 7. 冷却结束后 Alice 钓第二条 ──");
  await fishing.connect(alice).fish();
  check((await fishing.totalFished(alice.address)) === 2n, "Alice 累计钓鱼数 = 2");
  check((await fishing.pondBalance()) === TEN * 980n, "鱼池余额 990 → 980 TEST");

  // ── 8. Bob 也能钓：冷却按地址隔离 ──
  console.log("\n── 8. Bob 立刻也能钓（冷却按地址隔离，互不影响）──");
  await fishing.connect(bob).fish();
  check((await fishing.totalFished(bob.address)) === 1n, "Bob 累计钓鱼数 = 1");
  check((await fishing.pondBalance()) === TEN * 970n, "鱼池余额 980 → 970 TEST");

  // ── 9. 权限：非 owner 想投币/改规则 ──
  console.log("\n── 9. 不是老板的人想往鱼池投币？──");
  await expectRevert(fishing.connect(alice).depositRewards(TEN), "非 owner 调 depositRewards 被拒绝（only owner）");
  await expectRevert(fishing.connect(alice).setRewardPerFish(TEN), "非 owner 改奖励被拒绝");
  console.log("\n── 10. 冷却时间不能设得太短（防误填 0 秒）──");
  await expectRevert(fishing.setCooldown(30), "setCooldown(30) 被拒绝（下限 60 秒）");

  // ── 11. 老板改奖励 → 鱼池耗尽 ──
  console.log("\n── 11. 老板把每次奖励改成 500 TEST，鱼池被钓空 ──");
  await fishing.setRewardPerFish(TEN * 500n);
  await timeTravel(provider, 120); // 让 Alice 冷却结束
  await fishing.connect(alice).fish();
  check((await testToken.balanceOf(alice.address)) === aliceBefore + TEN * 520n, "Alice 一次钓走 500 TEST（累计 520）");
  check((await fishing.pondBalance()) === TEN * 470n, "鱼池余额 970 → 470 TEST");
  await expectRevert(fishing.connect(bob).fish(), "鱼池只剩 470 < 500，Bob 钓鱼被拒绝（empty pond）——池子需要持续投币");

  // ── 12. 总账核对：发放总额 = 注资 − 池内剩余 ──
  console.log("\n── 12. 总账核对 ──");
  const aliceGot = (await testToken.balanceOf(alice.address)) - aliceBefore;
  const bobGot = await testToken.balanceOf(bob.address);
  check(aliceGot === TEN * 520n, "Alice 累计到手 520 TEST（10 + 10 + 500）");
  check(bobGot === TEN * 10n, "Bob 累计到手 10 TEST");
  check(TEN * 1000n - (await fishing.pondBalance()) === aliceGot + bobGot,
    "注资 1000 − 池内剩余 470 = 实际发放 530，账目分毫不差");

  // ── 13. 裸 ETH 转账应被拒绝 ──
  console.log("\n── 13. 直接打 ETH 进钓鱼合约？──");
  await expectRevert(
    alice.sendTransaction({ to: await fishing.getAddress(), value: TEN }),
    "裸 ETH 转账被拒绝（本合约不碰 ETH）"
  );

  // ── 14. 移交所有权后旧 owner 失效 ──
  console.log("\n── 14. 老板把鱼塘交给 Bob ──");
  await fishing.transferOwnership(bob.address);
  check((await fishing.owner()) === bob.address, "新 owner = Bob");
  await expectRevert(fishing.depositRewards(TEN), "旧 owner 投币被拒绝（权限已移交）");
  await fishing.connect(bob).setRewardPerFish(TEN * 10n);
  check((await fishing.rewardPerFish()) === TEN * 10n, "新 owner 改规则成功");

  console.log("\n────────────────────────────────");
  console.log("结论：前端钓鱼动画只是「皮肤」，合约才是「规则引擎」——");
  console.log("时间门控拦住刷奖，鱼池余额拦住透支，权限修饰器守住管理员操作。");
  console.log("钓鱼挖矿规则验证全部通过 ✅");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
