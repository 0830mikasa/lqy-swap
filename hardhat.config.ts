// ============ 【固定】本文件开新项目时一般不用改，只要 .env 填对 ============
import "dotenv/config";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import { defineConfig } from "hardhat/config";

const { API_URL, PRIVATE_KEY, ETHERSCAN_API_KEY } = process.env;

// 私钥必须是 0x + 64 位十六进制字符；填成钱包地址会在这里警告
const accounts =
  PRIVATE_KEY && /^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY) ? [PRIVATE_KEY] : [];
if (PRIVATE_KEY && accounts.length === 0) {
  console.warn(
    "警告：.env 中的 PRIVATE_KEY 不是合法的私钥（应为 0x + 64 位十六进制字符）。" +
      "你可能粘贴了钱包地址——请从钱包（如 MetaMask）导出私钥后填入。"
  );
}

export default defineConfig({
  plugins: [hardhatEthers, hardhatVerify], // Hardhat 3 要求传插件对象，不是字符串
  solidity: { version: "0.8.34" },
  networks: {
    // 【改这里】换别的网络（如 base-sepolia）时写法一样：type/url/accounts
    sepolia: { type: "http", url: API_URL ?? "", accounts },
  },
  verify: {
    etherscan: { apiKey: ETHERSCAN_API_KEY ?? "" },
  },
});
