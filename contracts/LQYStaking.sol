// ============================================================
// 文件：contracts/LQYStaking.sol
// 作用：质押挖矿——把 LP 代币（LQP）质押进来，按份额持续赚 LQY。
//       核心模型：MasterChef 式份额记账（SushiSwap 农场同款思路）。
//       核心教学点：
//         1. 份额记账：不发「实时工资」，只在动作时一次性结账（惰性结算，省 gas）
//         2. 账本 vs 余额：奖励截断用「累计注入 − 累计产生」而不是余额，
//            否则「已计未领」的钱会被重复计算（债务膨胀 → 最后一人领不到）
//         3. 逃生舱：emergencyWithdraw 放弃待领奖励、立即取回本金
// ============================================================

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract LQYStaking {
    // ── 两种代币 ──
    IERC20 public immutable stakeToken;   // 质押物：LQP（LQYSwap 合约本身就是 ERC20）
    IERC20 public immutable rewardsToken; // 奖励：LQY

    // ── 权限：老板（注资、调速率）──
    // 教学：与 LQYFishing 同款手写 owner 守卫；生产用 OZ Ownable（两步移交）。
    address public owner;

    // ── 规则参数 ──
    uint256 public rewardPerSecond; // 每秒发放奖励（wei；0 = 暂停挖矿）

    // ── 全局账本 ──
    uint256 public totalStaked;    // 当前总质押
    uint256 public lastUpdateTime; // 上次结算时间戳（⚠ 构造时必须初始化，见下）
    // 每股累计收益 ×1e12：想象成「每股分红记录表」，全池共用一份。
    // 乘 1e12 精度因子是因为 LP 数量可能很小（wei 级），
    // 直接做整数除法会把小数奖励全部截没。
    uint256 public accRewardPerShare;
    // 账本与钱袋分离：这两个数只增不减，是「累计」口径——
    // totalDeposited = 老板一共投进池里的钱
    // totalAccrued   = 系统一共「记到账上」的奖励（还没发的待领也算）
    // 截断用 totalDeposited − totalAccrued，而不是读代币余额，
    // 原因见 _updatePool 的注释——这是本合约最重要的一个 bug 教学点。
    uint256 public totalDeposited;
    uint256 public totalAccrued;

    // ── 个人账本 ──
    // rewardDebt = 「已结算水位」：你上次结账时，按当时每股累计收益折算的
    //             你应得总额。待领 = 现在应得 − 已结算水位。
    struct User {
        uint256 amount;     // 质押数量
        uint256 rewardDebt; // 已结算水位
    }
    mapping(address => User) public userInfo;

    // ── 事件：所有改动留痕 ──
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event EmergencyWithdrawn(address indexed user, uint256 amount);
    event RewardsDeposited(uint256 amount);
    event RateUpdated(uint256 newRate);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    constructor(address _stakeToken, address _rewardsToken, uint256 _rewardPerSecond) {
        stakeToken = IERC20(_stakeToken);
        rewardsToken = IERC20(_rewardsToken);
        rewardPerSecond = _rewardPerSecond;
        owner = msg.sender;
        // ⚠ 必须初始化：不初始化的话默认是 0，第一次结算会算出
        //   elapsed = 现在时间戳 − 0 ≈ 20 亿秒，第一个质押的人瞬间领走全池。
        lastUpdateTime = block.timestamp;
    }

    // 收到裸 ETH 转账一律拒绝：本合约不碰 ETH，防止误转锁死
    receive() external payable {
        revert("LQYStaking: no ETH accepted");
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "LQYStaking: only owner");
        _;
    }

    // ============================================================
    // 内部：结算引擎（份额记账的心脏）
    // 惰性结算：奖励不实时转账，只在这里把「每股累计收益」往上记，
    // 等有人 stake / withdraw / harvest 时才一次性把差额算给他。
    // ============================================================
    function _updatePool() internal {
        uint256 nowTs = block.timestamp;
        if (lastUpdateTime >= nowTs) {
            // 同一秒内多笔交易：没产生新奖励，但也把时钟推进（无害）
            lastUpdateTime = nowTs;
            return;
        }
        if (totalStaked == 0) {
            // 没人质押：不产生奖励，只推时钟。
            // 注意：池空期间老板就算早就投了钱，时间也不会被「记账」——
            // 没人干活就不发工资，这笔钱留给以后的质押者。
            lastUpdateTime = nowTs;
            return;
        }

        uint256 elapsed = nowTs - lastUpdateTime;
        // 本段理论产量 = 每秒速率 × 经过秒数
        uint256 accrued = elapsed * rewardPerSecond;
        // ⚠ 截断（账本 vs 余额）：只能记到「老板投的总钱 − 已记到账上的钱」。
        // 这里不能用 rewardsToken.balanceOf(this)：余额里还包含「已记账但
        // 还没被领走」的待领奖励，拿余额当上限会重复计算 → 债务膨胀 →
        // 最后来领的人会领不到钱。用账本口径，数学上保证：
        //   所有人的待领之和 ≤ 累计记账 − 已发出 ≤ 老板注入 − 已发出 = 余额
        // 即：只要老板不撤资，池子永远付得起每一个人的待领。
        uint256 left = totalDeposited - totalAccrued;
        if (accrued > left) accrued = left;
        if (accrued == 0) {
            // 池子发干了：不记账，但时钟必须照推——
            // 否则老板以后补钱时，会把这漫长的「干涸期」也按新钱结算（回溯冒领）。
            lastUpdateTime = nowTs;
            return;
        }

        // 把本期产量摊到每股上（×1e12 精度，见声明处注释）
        accRewardPerShare += (accrued * 1e12) / totalStaked;
        totalAccrued += accrued;
        lastUpdateTime = nowTs;
    }

    // ============================================================
    // 内部：给某人结算待领奖励（转账 + 更新水位）
    // ============================================================
    function _payPending(address user) internal {
        User storage u = userInfo[user];
        uint256 pending = (u.amount * accRewardPerShare) / 1e12 - u.rewardDebt;
        if (pending > 0) {
            // CEI：状态更新发生在所有转账之前（调用方负责先改状态再调这里）。
            // 检查返回值：极少数怪 token 失败只返回 false，生产用 SafeERC20。
            require(
                rewardsToken.transfer(user, pending),
                "LQYStaking: reward transfer failed"
            );
            emit RewardPaid(user, pending);
        }
    }

    // ============================================================
    // 核心：质押 / 取出 / 收获
    // ============================================================

    // 质押 LQP 进场。调用前需先对 LQP 做 approve（前端会自动处理）。
    // 顺序要点：先结算旧账（防止已赚的奖励被新质押摊薄掉），再加本金。
    function stake(uint256 amount) external {
        require(amount > 0, "LQYStaking: zero amount");

        _updatePool();
        _payPending(msg.sender); // 先结旧账

        // CEI：账记完再转账
        require(
            stakeToken.transferFrom(msg.sender, address(this), amount),
            "LQYStaking: transfer failed"
        );
        userInfo[msg.sender].amount += amount;
        totalStaked += amount;
        // 重置水位：从现在起，每股收益的增量才属于新本金
        userInfo[msg.sender].rewardDebt =
            (userInfo[msg.sender].amount * accRewardPerShare) / 1e12;

        emit Staked(msg.sender, amount);
    }

    // 取出一部分本金 + 该笔待领奖励一起带走
    function withdraw(uint256 amount) external {
        require(amount > 0, "LQYStaking: zero amount");
        User storage u = userInfo[msg.sender];
        require(amount <= u.amount, "LQYStaking: exceeds stake");

        _updatePool();
        _payPending(msg.sender); // 先领完账上的奖励

        // CEI：先记账、后转账
        u.amount -= amount;
        totalStaked -= amount;
        u.rewardDebt = (u.amount * accRewardPerShare) / 1e12;

        require(
            stakeToken.transfer(msg.sender, amount),
            "LQYStaking: transfer failed"
        );

        emit Withdrawn(msg.sender, amount);
    }

    // 只领奖励、本金不动。pending 为 0 时调用也只是白花 gas，不 revert。
    function harvest() external {
        _updatePool();
        _payPending(msg.sender);
        userInfo[msg.sender].rewardDebt =
            (userInfo[msg.sender].amount * accRewardPerShare) / 1e12;
    }

    // ============================================================
    // 逃生舱：放弃全部待领奖励，立即取回全部本金。
    // 什么时候用？奖励逻辑出 bug、池子发不出钱、想紧急离场时——
    // 本金比利息重要，先保命。注意：放弃的待领不会分给别人，
    // 它留在池子里成为「余量」（totalDeposited − totalAccrued 变宽），
    // 让池子能多撑一段时间。
    // 故意不调 _updatePool：不进账就不欠账，走得干干净净。
    // ============================================================
    function emergencyWithdraw() external {
        User storage u = userInfo[msg.sender];
        uint256 amount = u.amount;
        require(amount > 0, "LQYStaking: nothing staked");

        u.amount = 0;
        u.rewardDebt = 0;
        totalStaked -= amount;

        require(
            stakeToken.transfer(msg.sender, amount),
            "LQYStaking: transfer failed"
        );

        emit EmergencyWithdrawn(msg.sender, amount);
    }

    // ============================================================
    // 老板操作
    // ============================================================

    // 老板投币：往池里注入 LQY（调用前需先 approve）。
    // 先 _updatePool 再投：把「投币前」这段时间的账先结清，界线分明。
    function depositRewards(uint256 amount) external onlyOwner {
        require(amount > 0, "LQYStaking: zero amount");
        _updatePool();
        require(
            rewardsToken.transferFrom(msg.sender, address(this), amount),
            "LQYStaking: transfer failed"
        );
        totalDeposited += amount;
        emit RewardsDeposited(amount);
    }

    // 老板调速率（0 = 暂停挖矿）。
    // 必须先 _updatePool：否则新速率会「回溯」套用到调参前的时间段。
    function setRewardPerSecond(uint256 _rate) external onlyOwner {
        _updatePool();
        rewardPerSecond = _rate;
        emit RateUpdated(_rate);
    }

    // 单步移交所有权（教学简版；生产用 OZ 两步移交防误传地址）
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "LQYStaking: zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ============================================================
    // 只读查询（前端全靠这些）
    // ============================================================

    // 待领奖励。注意：这是 view，读的是「上次有人动作时」的陈旧账，
    // 前端显示秒级跳动要本地估算 + 定期重新读取校准。
    function pendingReward(address user) external view returns (uint256) {
        User storage u = userInfo[user];
        return (u.amount * accRewardPerShare) / 1e12 - u.rewardDebt;
    }

    // 池子当前余额（直接读代币合约，不另存账本——单一事实来源）
    function rewardsBalance() external view returns (uint256) {
        return rewardsToken.balanceOf(address(this));
    }
}
