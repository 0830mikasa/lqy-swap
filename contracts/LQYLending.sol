// ============================================================
// 文件：contracts/LQYLending.sol
// 作用：简化版超额抵押借贷（Compound / Aave 思路的最简版）。
//       存 LQY 吃利息（cToken 式汇率股份），抵押 ETH 借 LQY，
//       健康不足可被任何人清算（清算人拿 5% 奖金）。
//       核心教学点：
//         1. cToken 汇率股份：存款凭证 = ERC20 股份，
//            汇率 (cash+borrows−reserves)/totalSupply 随利息只涨不跌
//         2. 利用率利率曲线：借款利率 = 基础 + 乘数 × 利用率，
//            池子被借得越空，借贷都越贵；存款利率同源派生
//         3. 指数记账 borrowIndex：全局债指数 + 个人快照，
//            是阶段 4 质押「每股累计收益」的负债版，同为惰性结算
//         4. 超额抵押：LTV 75%（最多借）< 清算阈值 80%（触发清算），
//            中间 5% 是缓冲带；健康系数 < 1 即被清算——
//            去中心化世界的风控靠「激励」，不靠「有人值班」
//         5. 预言机：价格读自家 LQYSwap 的现货价（reserve 之比）。
//            demo 会亲手演示「一笔大额兑换把价格打崩 → 健康仓位变
//            可清算」——这就是 AMM 现货预言机的经典操纵攻击，
//            真实项目用 Chainlink 喂价 / TWAP 平均价（本合约故意不防，
//            它就是教学案例）
//       设计简化（诚实说明）：
//         - LQY 是唯一可存可借资产、ETH 是唯一抵押品、单一池
//         - 存款不是抵押品（Compound V3 语义），取款只查池子现金
//         - 抵押用原生 ETH（无需 approve，也无需 WETH）
// ============================================================

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./LQYSwap.sol";

contract LQYLending is ERC20 {
    // ── 资产与预言机 ──
    IERC20 public immutable lqy;      // 唯一可存可借资产：LQY
    LQYSwap public immutable swap;    // 预言机：价格读池子 reserve 之比（LQY/ETH）

    // ── 权限：老板（调利率、调风控参数）──
    // 教学：手写 owner 守卫（阶段 3 起同款）；生产用 OZ Ownable（两步移交）。
    address public owner;

    // ── 利率参数（1e18 刻度 = 100%）──
    // 借款利率 = baseRatePerSecond + multiplierPerSecond × 利用率
    // 利用率 = 借出总额 ÷ 池子总量（被借得越空，利率越高——供需定价）
    uint256 public baseRatePerSecond;      // 基础利率/秒
    uint256 public multiplierPerSecond;    // 乘数/秒（满利用率时的附加利率）
    uint256 public reserveFactor;          // 利息进「协议储备」的比例（0.1 = 10%）

    // ── 风控参数（1e18 刻度）──
    uint256 public ltv;                   // 抵押率：最多能借「抵押价值 × 75%」
    uint256 public liquidationThreshold;  // 清算阈值：债务 > 抵押价值 × 80% 即可被清算
    uint256 public liquidationBonus;      // 清算奖金：清算人代还债务，可多拿 5% 抵押品
    uint256 public closeFactor;           // 单次清算最多代还债务的 50%（可多次清算）

    // ── 全局账本（Compound 同款三本账）──
    uint256 public totalCash;             // 池内现金（LQY）——恒等于合约代币余额
    uint256 public totalBorrows;          // 借款总额（本金 + 已累计利息）
    uint256 public totalReserves;         // 协议储备（利息的 reserveFactor 部分）
    uint256 public lastAccrualTime;       // ⚠ 上次计息时间（构造时必须初始化，阶段 4 时钟纪律）
    uint256 public borrowIndex;           // 全局债指数 ×1e18，初始 1e18，只涨不跌

    // ── 个人账本 ──
    // 债务 = borrowPrincipal × 当前borrowIndex ÷ userBorrowIndex。
    // 为什么分两格？惰性结算：不逐人逐秒记息，只在你动作（借/还/被清算）时，
    // 用「全局指数涨了多少」一次性折算你欠了多少——省 gas（阶段 4 同款思路）。
    // borrowPrincipal 存的是「上次结算时的原始债务」——当 borrowIndex 已从
    // 1e18 涨到 1.03e18 时，本金 75 直接存 75（而不是 75÷1.03）。
    // 读的时候乘 borrowIndex÷userBorrowIndex 一次到位。切勿存成「除以指数的
    // 折算值」：那样读账会乘两遍指数，利息被凭空吃掉（Compound 同款
    // borrowBalanceStored 定义，demo 第二幕清算后还清断言会抓住这个 bug）。
    mapping(address => uint256) public collateralBalance;  // 抵押的 ETH（wei，原生 ETH 无需 approve）
    mapping(address => uint256) public borrowPrincipal;    // 原始债务本金（上次结算时点）
    mapping(address => uint256) public userBorrowIndex;    // 个人指数快照（0 = 从未借款）

    // ── 事件：所有改动留痕 ──
    event Supplied(address indexed user, uint256 amount, uint256 shares);
    event Redeemed(address indexed user, uint256 amountLqy, uint256 shares);
    event CollateralDeposited(address indexed user, uint256 ethAmount);
    event CollateralWithdrawn(address indexed user, uint256 ethAmount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event Liquidated(
        address indexed liquidator,
        address indexed borrower,
        uint256 repayLqy,
        uint256 seizeEth
    );
    event RatesUpdated(uint256 base, uint256 multiplier);
    event ParamUpdated(string indexed param, uint256 value);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ReservesSwept(uint256 amount);

    constructor(
        address _lqy,
        address _swap,
        uint256 _base,
        uint256 _multiplier,
        uint256 _reserveFactor,
        uint256 _ltv,
        uint256 _threshold,
        uint256 _bonus,
        uint256 _closeFactor
    ) ERC20("LQY Lending Share", "LqLQY") {
        lqy = IERC20(_lqy);
        swap = LQYSwap(payable(_swap)); // LQYSwap 有 payable receive，普通 address 需先转 payable
        baseRatePerSecond = _base;
        multiplierPerSecond = _multiplier;
        reserveFactor = _reserveFactor;
        ltv = _ltv;
        liquidationThreshold = _threshold;
        liquidationBonus = _bonus;
        closeFactor = _closeFactor;
        // 参数合理性：LTV ≤ 清算阈值 < 100%（否则「最多借」反而超过「清算线」，缓冲带为负）
        require(_ltv > 0 && _threshold >= _ltv && _threshold < 1e18, "LQYLending: bad params");
        owner = msg.sender;
        borrowIndex = 1e18;
        // ⚠ 必须初始化：否则第一笔计息会算出 elapsed = 现在 − 0 ≈ 20 亿秒，
        // 借钱的瞬间背上天价利息（阶段 4 lastUpdateTime 同款教训）。
        lastAccrualTime = block.timestamp;
    }

    // 收到裸 ETH 转账一律拒绝：抵押走 depositCollateral，防止误转锁死
    receive() external payable {
        revert("LQYLending: no bare ETH");
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "LQYLending: only owner");
        _;
    }

    // ============================================================
    // 计息引擎（Compound 的心脏）
    // 惰性结算：利息不实时记到每个人头上，只在这里把「借款总额」往上加，
    // 同时把增量按比例摊进全局债指数。谁有动作，谁再按指数快照折算自己的债。
    // 数学不变量（可写成注释证明）：totalCash 恒等于合约代币余额，
    // 且 totalCash ≥ totalReserves 恒成立（储备全是借款人付的利息，
    // 利息对应的代币已经进了合约），所以池子永远付得起存款人的钱。
    // ============================================================
    function accrueInterest() public {
        uint256 nowTs = block.timestamp;
        if (lastAccrualTime >= nowTs) {
            lastAccrualTime = nowTs; // 同一秒内多笔交易：没产生新利息，时钟照推（无害）
            return;
        }
        if (totalBorrows == 0) {
            // 没人借款：没有利息可记，只推时钟。
            // 注意：必须推进——否则未来有人借款时会把这段空窗期也计息。
            lastAccrualTime = nowTs;
            return;
        }

        uint256 elapsed = nowTs - lastAccrualTime;
        // 利用率 = 借出 ÷ 池子总量（池子总量 = 现金 + 借出 − 储备）。
        // 因为 totalCash ≥ totalReserves，borrows > 0 时池子总量 ≥ borrows > 0，不会除零。
        uint256 util = totalBorrows * 1e18 / (totalCash + totalBorrows - totalReserves);
        // 借款利率：基础 + 乘数 × 利用率（利率随供需走，借得越空越贵）
        uint256 rate = baseRatePerSecond + multiplierPerSecond * util / 1e18;
        uint256 interest = totalBorrows * rate * elapsed / 1e18;
        if (interest > 0) {
            uint256 oldBorrows = totalBorrows;
            totalBorrows += interest;
            totalReserves += interest * reserveFactor / 1e18;
            // 债指数按「借款总额的增幅」等比放大（只涨不跌）：
            // 指数 ×(1 + 利率×时长) 与 指数×新债÷旧债 等价，后者是 Compound 原版写法
            borrowIndex = borrowIndex * totalBorrows / oldBorrows;
        }
        lastAccrualTime = nowTs;
    }

    // ============================================================
    // 内部：按指数折算某人的当前债务，并重置其指数快照
    // （折算会把「记账本金」重新对齐到当前指数，之后继续随指数增长）
    // ============================================================
    function _settleBorrow(address user) internal returns (uint256 debt) {
        uint256 uIdx = userBorrowIndex[user];
        if (uIdx == 0) {
            // 从未借过款：快照从当前指数起步（0 会除零，必须防）
            userBorrowIndex[user] = borrowIndex;
            return 0;
        }
        debt = borrowPrincipal[user] * borrowIndex / uIdx;
        // 重存原始债务（不折算）：下次读账 = 该值 × borrowIndex ÷ userBorrowIndex，
        // 指数只作用一次
        borrowPrincipal[user] = debt;
        userBorrowIndex[user] = borrowIndex;
    }

    // ============================================================
    // 汇率与利率（只读，前端全靠这些）
    // ============================================================

    // cToken 汇率：1 股份 = 多少 LQY。
    // 利息只进「借款总额」，不增发股份 → 汇率随时间只涨不跌 → 股份自动升值。
    function exchangeRate() public view returns (uint256) {
        uint256 totalShares = totalSupply();
        if (totalShares == 0) return 1e18; // 空池起步价：1 股份 = 1 LQY
        return (totalCash + totalBorrows - totalReserves) * 1e18 / totalShares;
    }

    function utilizationRate() public view returns (uint256) {
        uint256 pool = totalCash + totalBorrows - totalReserves;
        if (pool == 0) return 0;
        return totalBorrows * 1e18 / pool;
    }

    function borrowRatePerSecond() public view returns (uint256) {
        return baseRatePerSecond + multiplierPerSecond * utilizationRate() / 1e18;
    }

    // 存款利率 = 借款利率 × 利用率 × (1 − 储备系数)：
    // 存款人分享借款人付的利息，扣除协议自留的储备——存借利率同源，永远存 < 借
    function supplyRatePerSecond() public view returns (uint256) {
        return borrowRatePerSecond() * utilizationRate() * (1e18 - reserveFactor) / 1e36;
    }

    // ── 预言机：LQY 的 ETH 价格 ×1e18（读自家 LQYSwap 池的现货价）──
    // ⚠ 教学重点：现货价可以被一笔大额兑换瞬间打崩（demo 第 2 幕演示），
    // 真实项目必须用 Chainlink 喂价或时间加权均价（TWAP）。本合约故意用现货价。
    function price() public view returns (uint256) {
        uint256 ethR = swap.reserveEth();
        require(ethR > 0, "LQYLending: no oracle liquidity");
        return swap.reserveToken() * 1e18 / ethR;
    }

    // 抵押物价值（折算成 LQY，wei）
    function collateralValue(address user) public view returns (uint256) {
        return collateralBalance[user] * price() / 1e18;
    }

    // 某人当前债务（含未结算利息；view 读的是「上次有人动作时」的陈旧账，
    // 前端显示秒级跳动要本地估算 + 定期重新读取校准）
    function currentBorrowBalance(address user) public view returns (uint256) {
        uint256 uIdx = userBorrowIndex[user];
        if (uIdx == 0) return 0;
        return borrowPrincipal[user] * borrowIndex / uIdx;
    }

    // 还能借多少（抵押价值 × LTV − 已有债务；不足则 0）
    function maxBorrowable(address user) public view returns (uint256) {
        uint256 limit = collateralBalance[user] * price() * ltv / 1e36;
        uint256 debt = currentBorrowBalance(user);
        return limit > debt ? limit - debt : 0;
    }

    // 健康系数 ×1e18：> 1 健康，< 1 可被清算；无债 = 无限健康
    function healthFactor(address user) public view returns (uint256) {
        uint256 debt = currentBorrowBalance(user);
        if (debt == 0) return type(uint256).max;
        return collateralBalance[user] * price() * liquidationThreshold / debt / 1e18;
    }

    function isLiquidatable(address user) public view returns (bool) {
        uint256 debt = currentBorrowBalance(user);
        if (debt == 0) return false;
        // 严格大于：债务 ×100% > 抵押价值 × 清算阈值（floor 向下取整，只清算「明显不健康」的）
        return debt * 1e18 > collateralBalance[user] * price() * liquidationThreshold / 1e18;
    }

    // ============================================================
    // 存款侧：supply / redeem（cToken 汇率股份）
    // ============================================================

    // 存 LQY，按当前汇率铸股份（调用前需先对 LQY 做 approve）。
    function supply(uint256 amount) external {
        require(amount > 0, "LQYLending: zero amount");
        accrueInterest();

        uint256 supply0 = totalSupply();
        uint256 shares = amount * 1e18 / exchangeRate();
        require(shares > 0, "LQYLending: zero shares");

        // CEI：账记完再转账（标准 ERC20 无回调，生产用 SafeERC20 + 对怪 token 加 ReentrancyGuard）
        require(lqy.transferFrom(msg.sender, address(this), amount), "LQYLending: transfer failed");
        totalCash += amount;
        if (supply0 == 0) {
            // 首笔存款铸 1000 股死股锁死（LQYSwap MIN_LIQUIDITY 同款）：
            // 防「汇率通胀攻击」——攻击者先存 1 wei 把汇率炒到天价，后来者的
            // 股份被稀释得只剩灰尘。生产级方案是 ERC4626 的虚拟资产/offset 机制。
            _mint(address(0xdEaD), 1000);
        }
        _mint(msg.sender, shares);

        emit Supplied(msg.sender, amount, shares);
    }

    // 取 LQY：给出「想取多少 LQY」，按当前汇率折算成股份烧掉。
    // 注意：存款不是抵押品（Compound V3 语义简化），取款只查池子现金够不够，
    // 即使你借着款也可以把存款取走（但存款人同时借满的人，健康会掉，可被清算）。
    function redeem(uint256 amountLqy) external {
        require(amountLqy > 0, "LQYLending: zero amount");
        accrueInterest();

        uint256 exr = exchangeRate();
        uint256 shares = amountLqy * 1e18 / exr;
        require(shares > 0, "LQYLending: zero shares");
        require(shares <= balanceOf(msg.sender), "LQYLending: insufficient shares");
        uint256 out = shares * exr / 1e18; // 实际到账 ≤ 请求值（floor 舍入偏向协议）
        require(out <= totalCash, "LQYLending: insufficient cash");

        totalCash -= out;
        _burn(msg.sender, shares);
        require(lqy.transfer(msg.sender, out), "LQYLending: transfer failed");

        emit Redeemed(msg.sender, out, shares);
    }

    // ============================================================
    // 抵押侧：存/取 ETH（原生 ETH，无需 approve）
    // ============================================================

    function depositCollateral() external payable {
        require(msg.value > 0, "LQYLending: zero ETH");
        accrueInterest();
        collateralBalance[msg.sender] += msg.value;
        emit CollateralDeposited(msg.sender, msg.value);
    }

    // 取回抵押 ETH，但取完之后必须仍然健康：
    // 债务 ×100% ≤ 剩余抵押价值 × LTV（防止「先取走抵押再赖账」）
    function withdrawCollateral(uint256 amount) external {
        require(amount > 0, "LQYLending: zero amount");
        accrueInterest();
        uint256 debt = _settleBorrow(msg.sender);

        uint256 coll = collateralBalance[msg.sender];
        require(amount <= coll, "LQYLending: exceeds collateral");
        uint256 remaining = coll - amount;
        require(debt * 1e18 <= remaining * price() * ltv / 1e18, "LQYLending: would be unhealthy");

        // CEI：先记账、后转账（原生 ETH 转账有回调风险，状态必须先落账）
        collateralBalance[msg.sender] = remaining;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "LQYLending: ETH transfer failed");

        emit CollateralWithdrawn(msg.sender, amount);
    }

    // ============================================================
    // 借款侧：borrow / repay
    // ============================================================

    // 借 LQY：能借多少由抵押品决定——(旧债 + 新借) ≤ 抵押价值 × LTV。
    function borrow(uint256 amount) external {
        require(amount > 0, "LQYLending: zero amount");
        accrueInterest();
        uint256 debt = _settleBorrow(msg.sender);

        require(amount <= totalCash, "LQYLending: insufficient liquidity");
        // 健康检查（floor 舍入偏向协议：用户永远占不到舍入便宜）
        require((debt + amount) * 1e18 <= collateralBalance[msg.sender] * price() * ltv / 1e18,
            "LQYLending: exceeds LTV");

        totalCash -= amount;
        totalBorrows += amount;
        borrowPrincipal[msg.sender] = debt + amount; // 原始债务，指数快照同步刷新
        userBorrowIndex[msg.sender] = borrowIndex;
        require(lqy.transfer(msg.sender, amount), "LQYLending: transfer failed");

        emit Borrowed(msg.sender, amount);
    }

    // 还 LQY：金额自动封顶在「当前债务」——多输不会 revert 也不会多扣，
    // 前端「还清」按钮直接填一个大数即可（省去读账与上链之间的利息漂移问题）。
    function repay(uint256 amount) external {
        require(amount > 0, "LQYLending: zero amount");
        accrueInterest();
        uint256 debt = _settleBorrow(msg.sender);

        uint256 repayAmt = amount < debt ? amount : debt;
        require(repayAmt > 0, "LQYLending: no debt");

        require(lqy.transferFrom(msg.sender, address(this), repayAmt), "LQYLending: transfer failed");
        totalCash += repayAmt;
        totalBorrows -= repayAmt;
        // 剩余债务直接存原始值；userBorrowIndex 已被 _settleBorrow 刷到当前指数，
        // 之后读账 = 剩余值 × borrowIndex ÷ userBorrowIndex，指数只作用一次
        borrowPrincipal[msg.sender] = debt - repayAmt;

        emit Repaid(msg.sender, repayAmt);
    }

    // ============================================================
    // 清算（去中心化风控的核心：激励替代值班）
    // 任何人发现某仓位「债务 > 抵押价值 × 清算阈值」时都可以来清算：
    // 代他还一部分债（最多 closeFactor），拿回「等值 ×(1+5%奖金)」的抵押 ETH。
    // 允许自清算（可抢在机器人前面自救），也可多次部分清算。
    // ============================================================
    function liquidate(address borrower, uint256 repayAmount) external {
        require(repayAmount > 0, "LQYLending: zero amount");
        accrueInterest();
        uint256 debt = _settleBorrow(borrower);

        uint256 coll = collateralBalance[borrower];
        require(debt * 1e18 > coll * price() * liquidationThreshold / 1e18,
            "LQYLending: not liquidatable");

        // 单次最多代还债务的 closeFactor（50%），防止一次清算吃光一个仓
        uint256 repayAmt = repayAmount;
        uint256 maxRepay = debt * closeFactor / 1e18;
        if (repayAmt > maxRepay) repayAmt = maxRepay;

        // 清算奖金：按「代还本金的 1.05 倍」折算应拿的抵押 ETH
        uint256 seizeValue = repayAmt * (1e18 + liquidationBonus) / 1e18; // 折算成 LQY 的价值
        uint256 seizeEth = seizeValue * 1e18 / price();
        if (seizeEth > coll) seizeEth = coll; // 封顶：价格崩盘时也不能拿走超过全部抵押

        // CEI：全部记账先行，再做两笔外部调用
        totalCash += repayAmt;
        totalBorrows -= repayAmt;
        borrowPrincipal[borrower] = debt - repayAmt; // 原始债务（同 repay 的约定）
        collateralBalance[borrower] = coll - seizeEth;

        require(lqy.transferFrom(msg.sender, address(this), repayAmt), "LQYLending: transfer failed");
        (bool ok, ) = msg.sender.call{value: seizeEth}("");
        require(ok, "LQYLending: ETH transfer failed");

        emit Liquidated(msg.sender, borrower, repayAmt, seizeEth);
    }

    // ============================================================
    // 老板操作（全部先计息：新参数只对未来生效，不回溯）
    // ============================================================

    function setRates(uint256 _base, uint256 _multiplier) external onlyOwner {
        accrueInterest();
        baseRatePerSecond = _base;
        multiplierPerSecond = _multiplier;
        emit RatesUpdated(_base, _multiplier);
    }

    function setLtv(uint256 _value) external onlyOwner {
        accrueInterest();
        require(_value > 0 && _value <= liquidationThreshold, "LQYLending: bad ltv");
        ltv = _value;
        emit ParamUpdated("ltv", _value);
    }

    function setLiquidationThreshold(uint256 _value) external onlyOwner {
        accrueInterest();
        require(_value >= ltv && _value < 1e18, "LQYLending: bad threshold");
        liquidationThreshold = _value;
        emit ParamUpdated("liquidationThreshold", _value);
    }

    function setLiquidationBonus(uint256 _value) external onlyOwner {
        accrueInterest();
        require(_value < 1e18, "LQYLending: bad bonus");
        liquidationBonus = _value;
        emit ParamUpdated("liquidationBonus", _value);
    }

    function setCloseFactor(uint256 _value) external onlyOwner {
        accrueInterest();
        require(_value > 0 && _value <= 1e18, "LQYLending: bad closeFactor");
        closeFactor = _value;
        emit ParamUpdated("closeFactor", _value);
    }

    function setReserveFactor(uint256 _value) external onlyOwner {
        accrueInterest();
        require(_value <= 1e18, "LQYLending: bad reserveFactor");
        reserveFactor = _value;
        emit ParamUpdated("reserveFactor", _value);
    }

    // 提取协议储备（储备的币也在合约余额里，提走时 totalCash 同步减少——
    // 「账本 = 余额」的单一事实来源纪律不破）
    function sweepReserves() external onlyOwner {
        accrueInterest();
        uint256 amount = totalReserves;
        totalReserves = 0;
        totalCash -= amount;
        require(lqy.transfer(msg.sender, amount), "LQYLending: transfer failed");
        emit ReservesSwept(amount);
    }

    // 单步移交所有权（教学简版；生产用 OZ 两步移交防误传地址）
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "LQYLending: zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
