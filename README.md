# LQYSwap（DeFi 学习项目 · 阶段 2 + 阶段 3 + 阶段 4）

阶段 2：LQY ⇄ ETH 自动做市池，核心原理 **x\*y=k**（恒定乘积），Uniswap 思路的最简实现。
阶段 3：**LQYFishing 钓鱼挖矿**（GameFi 时间门控版）——canvas 钓鱼小游戏 + 链上发放规则。
阶段 4：**LQYStaking 质押挖矿**（MasterChef 份额记账）——质押 LQP 赚 LQY，SushiSwap 农场同款模型。

## 阶段 2 功能（LQYSwap）

| 函数 | 作用 |
|---|---|
| `addLiquidity(tokenAmount)` payable | 按比例存入 ETH + LQY，铸 LP 份额 |
| `removeLiquidity(lpAmount)` | 烧 LP，按份额取回 ETH + LQY（含手续费） |
| `ethToToken(minTokenOut)` payable | ETH → LQY，0.3% 手续费 |
| `tokenToEth(tokenAmount, minEthOut)` | LQY → ETH，0.3% 手续费 |
| `getAmountOut(amountIn, reserveIn, reserveOut)` | 核心公式：兑换报价 |

## 阶段 3 功能（LQYFishing）

| 函数 | 作用 |
|---|---|
| `fish()` | 钓鱼：冷却已过 + 鱼池够发才放奖励 |
| `depositRewards(amount)` onlyOwner | 老板往鱼池投币 |
| `setCooldown(sec)` onlyOwner | 改冷却（下限 60 秒） |
| `setRewardPerFish(amount)` onlyOwner | 改每次奖励 |
| `remainingCooldown(player)` | 查剩余冷却（前端倒计时用） |
| `pondBalance()` | 查鱼池余额 |

规则：每地址 5 分钟钓一次，每次 10 LQY。核心教学点：**链上合约看不见前端动画**——钓鱼游戏只是皮肤，合约只守时间门控与余额两条规则，谁直调 `fish()` 都能领奖。

## 阶段 4 功能（LQYStaking）

| 函数 | 作用 |
|---|---|
| `stake(amount)` | 质押 LQP 进场，先结旧账再加本金 |
| `withdraw(amount)` | 取出本金 + 待领奖励一起结算 |
| `harvest()` | 只领奖励、本金不动 |
| `emergencyWithdraw()` | 逃生舱：放弃待领、立即取回全部本金 |
| `pendingReward(user)` | 查待领（view，读的是上次结账后的账） |
| `depositRewards(amount)` onlyOwner | 老板注资发工资 |
| `setRewardPerSecond(rate)` onlyOwner | 调速率（0 = 暂停挖矿） |
| `rewardsBalance()` | 查池余额（单一事实来源） |

规则：每秒发 0.01 LQY，按「你的份额 ÷ 总份额」分摊。核心教学点：**份额记账**（全局每股累计收益 × 个人已结算水位 = 待领）；**账本截断**——奖励上限用「累计注入 − 累计已记账」而不是代币余额，否则「已计未领」会被重复计算、债务膨胀。

## 快速命令

```bash
npm install            # 安装依赖
npm run demo           # 阶段 2 本地全流程验证（免费，推荐先跑）
npm run demo:fishing   # 阶段 3 本地全流程验证（14 组断言）
npm run demo:staking   # 阶段 4 本地全流程验证（16 组断言）
npm run compile        # 编译
npm run deploy         # 部署 LQYSwap 到 Sepolia
npm run deploy:fishing # 部署 LQYFishing 到 Sepolia
npm run fund:fishing   # 钓鱼老板投币（approve + depositRewards 一键）
npm run deploy:staking # 部署 LQYStaking 到 Sepolia
npm run fund:staking   # 质押老板投币发工资（approve + depositRewards 一键）
npm run interact       # 查看池子状态和价格
npm run interact:fishing # 查看鱼塘状态
npm run interact:staking # 查看质押矿池状态
```

## 学习要点

1. **恒定乘积**：`x*y=k` 永不减少，手续费让 k 只增不减
2. **价格自动调节**：池中比例即价格，不需要订单簿
3. **滑点保护**：`minTokenOut`/`minEthOut` 防止大额兑换被价格波动坑
4. **LP 份额**：做市商按份额分享池子，手续费沉淀在池子里
5. **MIN_LIQUIDITY 防攻击**：首笔流动性锁死 1000 wei LP 到黑洞地址
6. **皮肤与规则**：前端动画无法被链上验证，游戏化挖矿 = 前端娱乐 + 链上规则引擎
7. **时间门控**：每地址限频防刷（`lastFishTime` 存时间戳，冷却全量重置）
8. **权限控制**：手写 `onlyOwner` 修饰器 = 函数守卫大门（生产用 OZ Ownable）
9. **CEI 顺序**：先记账后转账，外部调用放最后
10. **女巫攻击**：时间门控是「每地址」维度，多地址轮钓无解——真实项目需要验证体系
11. **份额记账**：不发实时工资，全局记账（每股累计收益）+ 个人水位，动作时才结账——省 gas 的惰性结算
12. **1e12 精度因子**：LP 数量可能小到 wei 级，直接整数除法会把小数奖励截没
13. **账本 vs 余额**：奖励截断用「累计注入 − 累计已记账」，不用代币余额（余额含已计未领，会债务膨胀）
14. **时钟纪律**：lastUpdateTime 必须构造时初始化、每个分支都推进——漏了会被回溯冒领
15. **逃生舱**：emergencyWithdraw 放弃待领保本金；弃奖留在池中做余量，不直接分给别人
