// ============================================================
// 文件：contracts/LQYFishing.sol
// 作用：钓鱼小游戏挖矿（GameFi 时间门控版）。
//       玩法：前端 canvas 钓鱼游戏是「皮肤」，本合约是「规则引擎」。
//       规则：每个地址每隔 cooldown 秒最多钓一次鱼，
//             每次成功钓鱼从「鱼池」领走固定的 rewardPerFish。
//       核心教学点：链上合约无法验证「你的手感」——动画多炫它都
//             看不见，合约只认时间门控和余额，谁直调 fish() 都能领。
// ============================================================

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract LQYFishing {
    // ── 奖励代币 ──
    IERC20 public immutable rewardsToken; // LQY（部署时指定）

    // ── 权限：老板（往鱼池投币、调规则）──
    // 教学：手写最简 owner 守卫，学会「修饰器 = 函数大门」。
    // 生产项目请用经过审计的 OpenZeppelin Ownable（功能等价、含两步移交）。
    address public owner;

    // ── 规则参数 ──
    uint256 public cooldown;      // 每地址钓鱼间隔（秒），下限 60 防误填 0
    uint256 public rewardPerFish; // 每次钓鱼奖励（wei，LQY 是 18 位小数）

    // ── 账本 ──
    // 存「上次钓鱼的时间戳」而不是「剩余冷却秒数」：
    // 若存剩余秒数，每钓一次要全表清零、语义绕弯；
    // 存时间戳则每次钓完冷却自然重置，还防「提前囤积冷却窗口」。
    mapping(address => uint256) public lastFishTime; // 上次钓鱼时间戳（0 = 从未钓过）
    mapping(address => uint256) public totalFished;  // 个人累计钓鱼数

    // ── 事件：所有改动留痕 ──
    event Fished(address indexed user, uint256 reward);
    event RewardsDeposited(uint256 amount);
    event CooldownUpdated(uint256 newCooldown);
    event RewardUpdated(uint256 newReward);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    constructor(address _rewardsToken, uint256 _cooldown, uint256 _rewardPerFish) {
        rewardsToken = IERC20(_rewardsToken);
        cooldown = _cooldown;
        rewardPerFish = _rewardPerFish;
        owner = msg.sender;
    }

    // 收到裸 ETH 转账一律拒绝：本合约不碰 ETH，防止误转锁死
    receive() external payable {
        revert("LQYFishing: no ETH accepted");
    }

    // 修饰器 = 函数体执行前的守卫大门
    modifier onlyOwner() {
        require(msg.sender == owner, "LQYFishing: only owner");
        _;
    }

    // ============================================================
    // 核心：钓鱼！
    // 任何人直调这个函数也能领奖——这不是漏洞，是本设计的教学点：
    // 「前端游戏只是皮肤，链上规则才是本体」。防刷靠的是下面的
    // 时间门控（每地址限频）而非前端动画。
    // 时间用 block.timestamp 而不用区块号：区块间隔会随网络升级
    // 变化，时间戳才是玩家能理解的稳定单位。
    // ============================================================
    function fish() external {
        // ① 时间门控：距上次钓鱼必须满 cooldown 秒
        require(
            block.timestamp >= lastFishTime[msg.sender] + cooldown,
            "LQYFishing: too soon"
        );
        // ② 鱼池检查：池里必须够发这一条（鱼池需要老板持续投币）
        require(
            rewardsToken.balanceOf(address(this)) >= rewardPerFish,
            "LQYFishing: empty pond"
        );

        // ③ CEI 顺序：先记账、后转账（外部调用放最后，防重入）
        lastFishTime[msg.sender] = block.timestamp;
        totalFished[msg.sender] += 1;

        // ④ 发奖。检查返回值：极少数怪 token 转账失败只返回 false
        //    不 revert（如老版 USDT），生产项目请用 SafeERC20
        require(
            rewardsToken.transfer(msg.sender, rewardPerFish),
            "LQYFishing: transfer failed"
        );

        emit Fished(msg.sender, rewardPerFish);
    }

    // ============================================================
    // 老板投币：往鱼池注入奖励（调用前需先对 LQY 做 approve）
    // ============================================================
    function depositRewards(uint256 amount) external onlyOwner {
        require(amount > 0, "LQYFishing: zero amount");
        require(
            rewardsToken.transferFrom(msg.sender, address(this), amount),
            "LQYFishing: transfer failed"
        );
        emit RewardsDeposited(amount);
    }

    // ── 老板调规则 ──
    function setCooldown(uint256 _cooldown) external onlyOwner {
        require(_cooldown >= 60, "LQYFishing: cooldown below 60s");
        cooldown = _cooldown;
        emit CooldownUpdated(_cooldown);
    }

    function setRewardPerFish(uint256 _reward) external onlyOwner {
        require(_reward > 0, "LQYFishing: zero reward");
        rewardPerFish = _reward;
        emit RewardUpdated(_reward);
    }

    // 单步移交所有权（教学简版；生产用 OZ 两步移交防误传地址）
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "LQYFishing: zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ============================================================
    // 只读查询（前端倒计时/统计全靠这些）
    // ============================================================

    // 该地址距下一次可钓鱼还剩多少秒（0 = 现在就能钓）
    function remainingCooldown(address player) external view returns (uint256) {
        if (lastFishTime[player] == 0) return 0; // 从未钓过，无冷却
        uint256 next = lastFishTime[player] + cooldown;
        return block.timestamp >= next ? 0 : next - block.timestamp;
    }

    // 鱼池当前余额（直接读代币合约，不另存账本——单一事实来源）
    function pondBalance() external view returns (uint256) {
        return rewardsToken.balanceOf(address(this));
    }
}
