# LQYSwap（AMM 学习项目 · 阶段 2）

LQY ⇄ ETH 自动做市池，核心原理 **x\*y=k**（恒定乘积），Uniswap 思路的最简实现。

## 功能

| 函数 | 作用 |
|---|---|
| `addLiquidity(tokenAmount)` payable | 按比例存入 ETH + LQY，铸 LP 份额 |
| `removeLiquidity(lpAmount)` | 烧 LP，按份额取回 ETH + LQY（含手续费） |
| `ethToToken(minTokenOut)` payable | ETH → LQY，0.3% 手续费 |
| `tokenToEth(tokenAmount, minEthOut)` | LQY → ETH，0.3% 手续费 |
| `getAmountOut(amountIn, reserveIn, reserveOut)` | 核心公式：兑换报价 |

## 快速命令

```bash
npm install       # 安装依赖
npm run demo      # 本地模拟链全流程验证（免费，推荐先跑）
npm run compile   # 编译
npm run deploy    # 部署 LQYSwap 到 Sepolia
npm run interact  # 查看池子状态和价格
```

## 学习要点

1. **恒定乘积**：`x*y=k` 永不减少，手续费让 k 只增不减
2. **价格自动调节**：池中比例即价格，不需要订单簿
3. **滑点保护**：`minTokenOut`/`minEthOut` 防止大额兑换被价格波动坑
4. **LP 份额**：做市商按份额分享池子，手续费沉淀在池子里
5. **MIN_LIQUIDITY 防攻击**：首笔流动性锁死 1000 wei LP 到黑洞地址
