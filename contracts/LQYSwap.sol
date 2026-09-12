// ============================================================
// 文件：contracts/LQYSwap.sol
// 作用：LQY ⇄ ETH 自动做市池（AMM，Uniswap 思路的最简版）。
//       核心原理：恒定乘积 x * y = k —— 池中两种资产数量的
//       乘积永不减少（手续费只会让它增加）。
//       功能：加流动性（铸 LP 份额）、取流动性（烧 LP）、
//             双向兑换（ETH→LQY / LQY→ETH，每笔收 0.3% 手续费）
// ============================================================

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract LQYSwap is ERC20 {
    // ── 池子的两种资产 ──
    IERC20 public immutable token;   // LQY（任何 ERC-20 都行，部署时指定）
    uint256 public reserveToken;     // 池中 LQY 数量（账本）
    uint256 public reserveEth;       // 池中 ETH 数量（账本）

    // ── 手续费：0.3%（每 1000 收 3）──
    uint256 public constant FEE_BPS = 3;
    uint256 public constant FEE_BASE = 1000;

    // ── 首笔流动性永久锁死的最小份额（1000 wei LP，铸给黑洞地址）──
    // 防「灰尘攻击」：攻击者存 1 wei 变成唯一 LP，操纵池子价格
    uint256 public constant MIN_LIQUIDITY = 1000;

    // ── 事件：所有改动留痕 ──
    event LiquidityAdded(address indexed provider, uint256 ethAmount, uint256 tokenAmount, uint256 lpAmount);
    event LiquidityRemoved(address indexed provider, uint256 ethAmount, uint256 tokenAmount, uint256 lpAmount);
    event Swapped(address indexed trader, bool ethIn, uint256 amountIn, uint256 amountOut);

    constructor(address _token) ERC20("LQY LP Token", "LQP") {
        token = IERC20(_token);
    }

    // 收到裸 ETH 转账一律拒绝：
    // 绕过兑换函数直接注资，会破坏「账本余额 = 合约真实余额」的记账前提
    receive() external payable {
        revert("LQYSwap: use addLiquidity or ethToToken");
    }

    // ============================================================
    // 核心公式：x * y = k
    // 输入 amountIn（自动扣 0.3%），应换出多少 amountOut，使
    //   (reserveIn + 有效输入) × (reserveOut − amountOut) = 兑换前乘积
    // 推导：有效输入 dx' = dx × 0.997
    //   dy = reserveOut × dx' / (reserveIn + dx')
    // 整数运算里分子分母同乘 1000 避免小数：
    //   dy = (dx×997 × reserveOut) / (reserveIn×1000 + dx×997)
    // ============================================================
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public pure returns (uint256)
    {
        uint256 amountInWithFee = amountIn * (FEE_BASE - FEE_BPS); // 乘 997，代替小数 0.997
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * FEE_BASE + amountInWithFee;
        return numerator / denominator;
    }

    // ============================================================
    // 加流动性：同时存入 ETH + LQY，按比例铸 LP 份额
    // ============================================================
    function addLiquidity(uint256 tokenAmount) external payable {
        require(msg.value > 0 && tokenAmount > 0, "need both ETH and tokens");

        uint256 lpAmount;
        if (reserveEth == 0 && reserveToken == 0) {
            // 第一笔流动性：由你定初始价格（1 wei ETH = 1 wei LP），
            // 同时把 MIN_LIQUIDITY 份 LP 铸给黑洞地址永久锁死（防攻击）
            require(msg.value > MIN_LIQUIDITY, "first liquidity too small");
            lpAmount = msg.value - MIN_LIQUIDITY;
            _mint(address(0xdEaD), MIN_LIQUIDITY);
        } else {
            // 之后的流动性必须按池子当前比例存
            uint256 expectedToken = (msg.value * reserveToken) / reserveEth;
            require(tokenAmount >= expectedToken, "tokens below ratio");
            tokenAmount = expectedToken; // 只按比例取走需要的部分，多余的留在你钱包
            lpAmount = (msg.value * totalSupply()) / reserveEth;
            require(lpAmount > 0, "zero lp share");
        }

        token.transferFrom(msg.sender, address(this), tokenAmount);
        reserveEth += msg.value;
        reserveToken += tokenAmount;
        _mint(msg.sender, lpAmount);

        emit LiquidityAdded(msg.sender, msg.value, tokenAmount, lpAmount);
    }

    // ============================================================
    // 取流动性：烧掉 LP，按份额拿回 ETH + LQY
    // （池子越大你的份额越值钱——手续费就赚在这里）
    // ============================================================
    function removeLiquidity(uint256 lpAmount) external {
        require(lpAmount > 0, "zero lp share");
        uint256 total = totalSupply();
        uint256 ethOut = (reserveEth * lpAmount) / total;
        uint256 tokenOut = (reserveToken * lpAmount) / total;

        _burn(msg.sender, lpAmount);
        reserveEth -= ethOut;
        reserveToken -= tokenOut;

        (bool ok, ) = msg.sender.call{value: ethOut}("");
        require(ok, "ETH refund failed");
        token.transfer(msg.sender, tokenOut);

        emit LiquidityRemoved(msg.sender, ethOut, tokenOut, lpAmount);
    }

    // ============================================================
    // 兑换：ETH → LQY（minTokenOut = 滑点保护：最少要换到多少）
    // ============================================================
    function ethToToken(uint256 minTokenOut) external payable {
        require(msg.value > 0, "send ETH");
        uint256 amountOut = getAmountOut(msg.value, reserveEth, reserveToken);
        require(amountOut >= minTokenOut, "slippage exceeded");

        reserveEth += msg.value;
        reserveToken -= amountOut;
        token.transfer(msg.sender, amountOut);

        emit Swapped(msg.sender, true, msg.value, amountOut);
    }

    // ============================================================
    // 兑换：LQY → ETH（minEthOut = 滑点保护）
    // ============================================================
    function tokenToEth(uint256 tokenAmount, uint256 minEthOut) external {
        require(tokenAmount > 0, "zero amount");
        uint256 amountOut = getAmountOut(tokenAmount, reserveToken, reserveEth);
        require(amountOut >= minEthOut, "slippage exceeded");

        token.transferFrom(msg.sender, address(this), tokenAmount);
        reserveToken += tokenAmount;
        reserveEth -= amountOut;
        (bool ok, ) = msg.sender.call{value: amountOut}("");
        require(ok, "ETH transfer failed");

        emit Swapped(msg.sender, false, tokenAmount, amountOut);
    }
}
