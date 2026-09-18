# LQYSwap（DeFi 学习项目 · 阶段 2 + 阶段 3）

阶段 2：LQY ⇄ ETH 自动做市池，核心原理 **x\*y=k**（恒定乘积），Uniswap 思路的最简实现。
阶段 3：**LQYFishing 钓鱼挖矿**（GameFi 时间门控版）——canvas 钓鱼小游戏 + 链上发放规则。

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

## 快速命令

```bash
npm install            # 安装依赖
npm run demo           # 阶段 2 本地全流程验证（免费，推荐先跑）
npm run demo:fishing   # 阶段 3 本地全流程验证（14 组断言）
npm run compile        # 编译
npm run deploy         # 部署 LQYSwap 到 Sepolia
npm run deploy:fishing # 部署 LQYFishing 到 Sepolia
npm run fund:fishing   # 老板投币（approve + depositRewards 一键）
npm run interact       # 查看池子状态和价格
npm run interact:fishing # 查看鱼塘状态
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
