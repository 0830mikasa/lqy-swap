// ============================================================
// 文件：contracts/TestToken.sol
// 作用：本地模拟链演示用的测试代币（不上真链）。
//       真实部署时 LQYSwap 连接的是 Sepolia 上的 LQY。
// ============================================================

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TestToken is ERC20 {
    constructor() ERC20("Test Token", "TEST") {
        _mint(msg.sender, 1_000_000 * 10 ** 18); // 100 万枚给部署账户
    }
}
