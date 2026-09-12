# 新项目开工清单（打勾执行版）

> 操作时按顺序打勾。原理讲解看 [GUIDE.md](GUIDE.md)。

## 第 0 步：复制模板

- [ ] 把整个 `dapp-template` 文件夹复制一份，改名成你的项目名
- [ ] 改 `package.json` 里的 `"name"`
- [ ] GitHub 上新建仓库：**Public**；README/.gitignore/license **三个初始化勾选框都不要勾**
- [ ] 新仓库 Settings → Pages → Source 选 **GitHub Actions**（趁早开，忘了会白跑一趟发布）

## 第 1 步：安装与配置

- [ ] 终端运行 `npm install`
- [ ] 复制 `.env.example` 为 `.env`，填四个变量：
  - [ ] `API_URL`：Alchemy 的 Sepolia RPC 地址
  - [ ] `PRIVATE_KEY`：0x + 64 位十六进制（**是私钥不是钱包地址！** 从 MetaMask 导出）
  - [ ] `ETHERSCAN_API_KEY`：验证合约用
  - [ ] `CONTRACT_ADDRESS`：**先留空**，部署后回填
- [ ] 检查 `.gitignore` 里有 `.env`（铁律）

## 第 2 步：写合约

- [ ] `contracts/YourContract.sol` 换成你的合约，保留四要素：
  - [ ] SPDX 许可证 / pragma / 状态变量 / 函数 + 事件
- [ ] 想清楚三问：数据存什么？谁能读？谁能写？

## 第 3 步：编译

- [ ] `npm run compile`，报错就修

## 第 4 步：部署上链

- [ ] 钱包里有 Sepolia 测试币（水龙头领取）
- [ ] `npm run deploy`
- [ ] 把打印出的合约地址**回填到 .env 的 CONTRACT_ADDRESS**

## 第 5 步：开源验证

- [ ] PowerShell 设代理（国内网络必需）：
  ```
  $env:HTTPS_PROXY = "http://127.0.0.1:12000"
  $env:HTTP_PROXY = "http://127.0.0.1:12000"
  ```
- [ ] `npx hardhat verify --network sepolia <合约地址> <构造参数1> <构造参数2>…`
- [ ] ⚠️ 构造参数和部署时**完全一致**，否则验证失败
- [ ] 去 Etherscan 确认显示绿色"已验证"

## 第 6 步：前端

- [ ] 改三样：合约地址 / ABI / 读写函数名
- [ ] ⚠️ ABI 从 `artifacts/contracts/YourContract.sol/YourContract.json` 复制，只取用到的函数和事件
- [ ] ⚠️ 改了合约 → 重新编译 → **重新复制 ABI**！
- [ ] Live Server 本地预览（在真正的 Edge 里打开，内置浏览器没有钱包扩展）
- [ ] MetaMask 读写各测一遍

## 第 7 步：发布

- [ ] `git init -b main`
- [ ] `git add .` → `git commit -m "第一版"`
- [ ] `git remote add origin https://github.com/<用户名>/<仓库名>.git`
- [ ] `git push -u origin main`
- [ ] Actions 页等 deploy 工作流变**绿勾**
- [ ] 打开 `https://<用户名>.github.io/<仓库名>/` 验收
- [ ] 以后更新：`add` → `commit` → `push` 三件套

## 第 8 步：上线前最后检查

- [ ] 私钥/API key 只在 .env，没进 git、没进前端
- [ ] 前端用的是公共 RPC
- [ ] 页面上能读、能写、错误提示正常

---

## 常见坑速查表（都踩过的）

| 症状 | 原因 | 解法 |
|---|---|---|
| `No contracts to compile` | contracts 文件夹里没有 .sol 文件 | 检查文件名和路径 |
| 警告 PRIVATE_KEY 不合法 | 填了钱包地址（42 字符）而不是私钥（66 字符） | 从 MetaMask 导出私钥 |
| 插件报错 / hre.ethers undefined | Hardhat 3 写法变化 | 用模板里的写法：plugins 传对象、`network.create()` |
| 验证失败 | 构造参数不一致 / 没开代理 | 核对参数 + 设代理环境变量 |
| 前端"未检测到钱包" | 在 VS Code 内置浏览器打开 | 用 Edge 打开（Live Server 或已发布的网址） |
| 前端读不到新数据 | 改了合约没同步 ABI | 重新编译 + 复制新 ABI |
| push 被拒绝（Updates were rejected） | 建仓库时勾了初始化（远程有 Initial commit） | `git push -f -u origin main` 覆盖空提交 |
| Pages 发布失败 | Source 没设为 GitHub Actions | Settings → Pages → Source |
| 写操作提示 gas 不足 | 测试币用完了 | 水龙头再领 |
