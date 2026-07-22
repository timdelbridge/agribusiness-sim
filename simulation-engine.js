/**
 * Purdue Agribusiness Management Simulation Engine
 * Based on the 2010 Purdue Research Foundation manual
 * 
 * This module contains all simulation math and logic.
 * It is intentionally pure JavaScript with no dependencies
 * so it can run in any browser without a build step.
 */

// ============================================================
// CONSTANTS (from manual)
// ============================================================

const WHOLESALE_PRICES = {
  completeFeed:      158.00,
  concentrateFeed:   255.00,
  commGradeFert:      93.00,
  customBlendFert:   106.00,
};

const STARTING_PRICES = {
  completeFeed:      206.00,
  concentrateFeed:   315.00,
  commGradeFert:     138.00,
  customBlendFert:   159.00,
};

// Price must be within $4.00 of market average
const PRICE_RANGE = 4.00;

// Emergency order surcharge over wholesale
const EMERGENCY_SURCHARGE = 0.10;

// Storage
const STORAGE_SQFT_OWNED      = 14000;
const STORAGE_TONS_CAPACITY   = 3271;   // 14000 / 4.28 ≈ 3271
const SQFT_PER_TON            = 4.28;
const STORAGE_COST_PER_SQFT   = 8.50;  // purchase price
const STORAGE_RENTAL_PER_SQFT = 0.75;  // per quarter
const STORAGE_DEPRECIATION_YEARS = 15;
const STORAGE_VARIABLE_COST_PER_TON = 12.50;
const INITIAL_STORAGE_BOOK_VALUE = 297360;

// Trucks
const TRUCKS_OWNED_INITIAL    = 5;
const TRUCK_CAPACITY_PER_TRUCK = 560;  // tons per quarter
const TRUCK_PURCHASE_PRICE    = 35000;
const TRUCK_RENTAL_PER_QUARTER = 3640; // per truck equivalent
const TRUCK_DEPRECIATION_YEARS = 5;
const TRUCK_VARIABLE_COST_PER_TON = 7.00;
const INITIAL_TRUCK_BOOK_VALUE = 105000;

// Labor
const LABOR_TONS_PER_WORKER   = 466;
const LABOR_COST_PER_WORKER   = 7500;  // per quarter
const OVERTIME_COST_PER_WORKER = 11250; // per quarter
const MANAGER_SALARY          = 12500;  // per quarter
const MIN_WORKERS             = 3;
const TRAINING_COST_FULLTIME  = 1000;
const TRAINING_COST_PARTTIME  = 500;

// Misc expenses
const MISC_FIXED_PER_QUARTER  = 2200;
const MISC_VARIABLE_PER_TON   = 0.80;

// Credit policies
const CREDIT_POLICIES = {
  1: { currentCollectionRate: 0.90, badDebtRate: 0.00,  name: '30-day' },
  2: { currentCollectionRate: 0.70, badDebtRate: 0.005, name: '60-day' },
  3: { currentCollectionRate: 0.30, badDebtRate: 0.02,  name: '90-day' },
};

// Interest rate scenarios
const INTEREST_SCENARIOS = {
  A: { regularLow: 0.06, regularHigh: 0.08, emergency: 0.12, investment: 0.03 },
  B: { regularLow: 0.08, regularHigh: 0.11, emergency: 0.15, investment: 0.04 },
  C: { regularLow: 0.10, regularHigh: 0.13, emergency: 0.18, investment: 0.06 },
};

// Loan terms: 10-year, equal quarterly principal payments
const LOAN_QUARTERS = 40; // 10 years * 4 quarters

// Debt/equity threshold for interest rate tier
const DEBT_EQUITY_THRESHOLD = 1.0;

// ============================================================
// SEASONAL DEMAND BASELINE
// Derived from Table 1 historical data (last year as base)
// These represent total market demand per quarter (all teams)
// ============================================================

// Historical seasonal patterns (from Table 1, last year)
// We'll use these to derive seasonal indices
const SEASONAL_BASE = {
  // [Q1, Q2, Q3, Q4]
  completeFeed:    [1295, 1287, 1258, 1402],
  concentrateFeed: [ 767,  339,  334,  590],
  commGradeFert:   [ 305, 1355,  258,  436],
  customBlendFert: [ 396, 1802,  448,  659],
};

// Annual totals from last year
const ANNUAL_BASE = {
  completeFeed:    5242,
  concentrateFeed: 2030,
  commGradeFert:   2354,
  customBlendFert: 3305,
};

// Seasonal indices (quarter / annual * 4)
function getSeasonalIndices() {
  const indices = {};
  for (const product of Object.keys(SEASONAL_BASE)) {
    const annual = ANNUAL_BASE[product];
    indices[product] = SEASONAL_BASE[product].map(q => (q / annual) * 4);
  }
  return indices;
}

const SEASONAL_INDICES = getSeasonalIndices();

// Market growth rate per year (approximate from Table 1 data)
// Complete feed: ~5%/yr, Concentrate: ~8%/yr, Comm Fert: -3%/yr, Custom: ~7%/yr
const ANNUAL_GROWTH_RATES = {
  completeFeed:    0.05,
  concentrateFeed: 0.08,
  commGradeFert:  -0.03,
  customBlendFert: 0.07,
};

// ============================================================
// DEMAND MODEL
// ============================================================

/**
 * Price elasticity coefficients (score-model form, i.e. the k used in
 * `priceEffect = 1 + (-priceDiff * |k|)` below — not a classical log-log
 * elasticity, though the two are close in magnitude at this price range).
 *
 * Estimated from real historical gameplay data (AGB322, Fall 2021, 4 market
 * areas x ~7 periods x 5 teams) via a within-market-period fixed-effects
 * regression of each team's log market share on its price deviation from
 * the period average, matching the exact share-allocation formula this
 * engine uses. All four coefficients are highly significant (t = -5 to
 * -7.7). Ordering (most to least inelastic):
 *   1. Complete feed       (~10.8)
 *   2. Comm grade fert     (~10.9 — statistically indistinguishable from Complete feed)
 *   3. Concentrate feed    (~13.1)
 *   4. Custom blend fert   (~14.8, most elastic)
 *
 * This is a large upward revision from an earlier guessed set (roughly
 * -0.8 to -1.8): with only a $4 legal price band (~1-2% of price level),
 * a much steeper coefficient is needed for price choice to meaningfully
 * move market share at all, which is exactly the pattern the data shows.
 *
 * Cross-price and advertising elasticities were also estimated from the
 * same data but came back statistically insignificant (t < 1.8, inconsistent
 * signs), so CROSS_ELASTICITY_FEED/FERT and ADVERTISING_ELASTICITY below are
 * intentionally left at their prior guessed values rather than replaced.
 */
const PRICE_ELASTICITY = {
  completeFeed:    -10.8,  // most inelastic
  commGradeFert:   -10.9,
  concentrateFeed: -13.1,
  customBlendFert: -14.8,  // most elastic
};

/**
 * Cross-price elasticity between feed pairs and fert pairs.
 * A higher price for complete feed shifts some demand to concentrate, and vice versa.
 */
const CROSS_ELASTICITY_FEED = 0.3;   // between complete and concentrate
const CROSS_ELASTICITY_FERT = 0.25;  // between comm grade and custom blend

/**
 * Advertising elasticity - how much advertising boosts demand
 * Baseline advertising is $1000/quarter
 */
const ADVERTISING_ELASTICITY = 0.05;
const BASELINE_ADVERTISING = 1000;

/**
 * Credit policy demand multipliers (relative to policy 1)
 */
const CREDIT_DEMAND_MULTIPLIER = {
  1: 1.00,
  2: 1.03,  // 60-day modestly boosts sales
  3: 1.06,  // 90-day more aggressively boosts sales
};

/**
 * Generate a normally-distributed random number using Box-Muller
 */
function randomNormal(mean = 0, std = 1) {
  let u1, u2;
  do { u1 = Math.random(); } while (u1 === 0);
  u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * std;
}

/**
 * Calculate total market demand for a given quarter,
 * before any competitive effects are applied.
 * 
 * @param {number} quarterIndex - 0-based quarter within the game (0=Q1Y1 ... 11=Q4Y3)
 * @param {number} randomSeed - for reproducibility (not used yet, uses Math.random)
 * @returns {object} baseline market demand in tons per product
 */
function calculateBaseMarketDemand(quarterIndex) {
  const year = Math.floor(quarterIndex / 4);       // 0, 1, 2
  const qWithinYear = quarterIndex % 4;            // 0, 1, 2, 3

  const demand = {};
  for (const product of Object.keys(ANNUAL_BASE)) {
    // Apply compound annual growth
    const growthFactor = Math.pow(1 + ANNUAL_GROWTH_RATES[product], year);
    // Apply seasonal index
    const seasonal = SEASONAL_INDICES[product][qWithinYear];
    // Apply random shock (std dev ~10% of expected)
    const shock = randomNormal(1.0, 0.08);
    // Base demand = annual base * growth * seasonal/4 * shock
    demand[product] = (ANNUAL_BASE[product] / 4) * growthFactor * seasonal * shock;
  }
  return demand;
}

/**
 * Calculate each team's share of market demand based on their decisions.
 * 
 * @param {Array} teams - array of team decision objects for the quarter
 * @param {object} baseMarketDemand - total market demand in tons
 * @param {object} marketAveragePrices - average prices from last quarter (for reference)
 * @returns {Array} array of per-team demand objects
 */
function calculateTeamDemand(teams, baseMarketDemand, currentAveragePrices) {
  const products = ['completeFeed', 'concentrateFeed', 'commGradeFert', 'customBlendFert'];
  const numTeams = teams.length;

  // Step 1: Calculate each team's relative attractiveness score per product
  // Based on price (lower = more attractive), advertising, and credit policy
  const scores = teams.map(team => {
    const score = {};
    for (const product of products) {
      const avgPrice = currentAveragePrices[product];
      const teamPrice = team.prices[product];
      const priceDiff = (teamPrice - avgPrice) / avgPrice;

      // Price effect: negative price diff means below average (good for sales)
      const priceEffect = 1 + (-priceDiff * Math.abs(PRICE_ELASTICITY[product]));

      // Advertising effect relative to baseline
      const advRatio = team.advertising / BASELINE_ADVERTISING;
      const advEffect = 1 + ADVERTISING_ELASTICITY * (advRatio - 1);

      // Credit effect
      const creditEffect = CREDIT_DEMAND_MULTIPLIER[team.creditPolicy];

      score[product] = Math.max(0.1, priceEffect * advEffect * creditEffect);
    }
    return score;
  });

  // Step 2: Normalize scores to get market share fractions
  const totalScore = {};
  for (const product of products) {
    totalScore[product] = scores.reduce((sum, s) => sum + s[product], 0);
  }

  // Step 3: Apply cross-price elasticity adjustments within pairs
  // (shifts between complete/concentrate and comm/custom)
  const teamDemands = teams.map((team, i) => {
    const demand = {};
    for (const product of products) {
      const share = scores[i][product] / totalScore[product];
      demand[product] = baseMarketDemand[product] * share;
    }

    // Cross-elasticity: if a team prices complete feed below concentrate,
    // some concentrate buyers shift to complete feed
    const feedPriceDiff = (team.prices.completeFeed - team.prices.concentrateFeed) /
                           team.prices.concentrateFeed;
    const feedShift = feedPriceDiff * CROSS_ELASTICITY_FEED;
    // Positive feedPriceDiff means complete is expensive → lose some to concentrate
    demand.completeFeed    *= (1 - feedShift * 0.5);
    demand.concentrateFeed *= (1 + feedShift * 0.5);

    const fertPriceDiff = (team.prices.commGradeFert - team.prices.customBlendFert) /
                           team.prices.customBlendFert;
    const fertShift = fertPriceDiff * CROSS_ELASTICITY_FERT;
    demand.commGradeFert   *= (1 - fertShift * 0.5);
    demand.customBlendFert *= (1 + fertShift * 0.5);

    // Ensure non-negative
    for (const product of products) {
      demand[product] = Math.max(0, demand[product]);
    }
    return demand;
  });

  return teamDemands;
}

// ============================================================
// FINANCIAL CALCULATIONS
// ============================================================

/**
 * Calculate weighted average cost of goods sold
 * (beginning inventory value + purchases) / (beginning inventory tons + ordered tons)
 */
function weightedAvgCost(beginInvTons, beginInvValue, orderedTons, wholesalePrice) {
  const totalTons = beginInvTons + orderedTons;
  if (totalTons === 0) return wholesalePrice;
  const totalValue = beginInvValue + (orderedTons * wholesalePrice);
  return totalValue / totalTons;
}

/**
 * Calculate storage fixed cost (depreciation)
 */
function calcStorageFixedCost(bookValue) {
  return bookValue / (STORAGE_DEPRECIATION_YEARS * 4); // quarterly depreciation
}

/**
 * Calculate truck fixed cost (depreciation)
 */
function calcTruckFixedCost(bookValue) {
  return bookValue / (TRUCK_DEPRECIATION_YEARS * 4); // quarterly depreciation
}

/**
 * Calculate interest expense for the quarter
 */
function calcInterestExpense(bankNote, emergencyLoan, debtEquityRatio, scenario) {
  const rates = INTEREST_SCENARIOS[scenario];
  const regularRate = debtEquityRatio >= DEBT_EQUITY_THRESHOLD
    ? rates.regularHigh
    : rates.regularLow;
  // Interest is quarterly (annual rate / 4)
  const regularInterest  = bankNote * (regularRate / 4);
  const emergencyInterest = emergencyLoan * (rates.emergency / 4);
  return regularInterest + emergencyInterest;
}

/**
 * Calculate bad debt loss
 */
function calcBadDebtLoss(totalSales, creditPolicy) {
  const policy = CREDIT_POLICIES[creditPolicy];
  return totalSales * policy.badDebtRate;
}

/**
 * Calculate loan repayment schedule
 * 10-year loan, equal quarterly principal + interest on remaining balance
 */
function calcLoanPayment(principal, totalQuarters, quarterNumber, annualRate) {
  const quarterlyPrincipal = principal / totalQuarters;
  const remainingBalance = principal - (quarterlyPrincipal * (quarterNumber - 1));
  const interestPayment = remainingBalance * (annualRate / 4);
  return { principal: quarterlyPrincipal, interest: interestPayment, total: quarterlyPrincipal + interestPayment };
}

// ============================================================
// MAIN QUARTER PROCESSING FUNCTION
// ============================================================

/**
 * Process one quarter for one team.
 * 
 * @param {object} prevState - the team's state at end of previous quarter
 * @param {object} decision - the team's decisions for this quarter
 * @param {object} demand - pre-calculated demand for this team this quarter (tons)
 * @param {object} marketAveragePrices - market average prices this quarter
 * @param {string} interestScenario - 'A', 'B', or 'C'
 * @param {number} quarterIndex - 0-based (0 = Q1 Year 1)
 * @returns {object} new state + full financial report
 */
function processQuarter(prevState, decision, demand, marketAveragePrices, interestScenario, quarterIndex) {
  const products = ['completeFeed', 'concentrateFeed', 'commGradeFert', 'customBlendFert'];
  const rates = INTEREST_SCENARIOS[interestScenario];

  // --- INVENTORY & SALES ---
  const availableInventory = {};
  const actualSales = {};
  const unfilledOrders = {};
  const endInventory = {};
  const cogsPerTon = {};

  for (const p of products) {
    const beginTons  = prevState.inventory[p].tons;
    const beginValue = prevState.inventory[p].value;
    const ordered    = decision.orders[p];
    const available  = beginTons + ordered;
    const demanded   = demand[p];

    // Weighted average cost
    cogsPerTon[p] = weightedAvgCost(beginTons, beginValue, ordered, WHOLESALE_PRICES[p]);

    // Can we fill demand?
    let sales = Math.min(demanded, available);
    let unfilled = Math.max(0, demanded - available);

    // Emergency orders: recover some unfilled (at 10% surcharge)
    // Per manual: "some portion" recovered — use 70% recovery rate
    let emergencyOrderCost = 0;
    if (decision.placeEmergencyOrders && unfilled > 0) {
      const recovered = unfilled * 0.70;
      emergencyOrderCost += recovered * WHOLESALE_PRICES[p] * (1 + EMERGENCY_SURCHARGE);
      sales += recovered;
      unfilled -= recovered;
    }

    actualSales[p]    = sales;
    unfilledOrders[p] = unfilled;
    endInventory[p]   = {
      tons:  Math.max(0, available - sales),
      value: Math.max(0, available - sales) * cogsPerTon[p],
    };
  }

  // --- REVENUE ---
  const revenue = {};
  let totalRevenue = 0;
  for (const p of products) {
    revenue[p] = actualSales[p] * decision.prices[p];
    totalRevenue += revenue[p];
  }

  // --- COST OF GOODS SOLD ---
  const cogs = {};
  let totalCOGS = 0;
  for (const p of products) {
    cogs[p] = actualSales[p] * cogsPerTon[p];
    totalCOGS += cogs[p];
  }

  // --- GROSS MARGIN ---
  const grossMargin = totalRevenue - totalCOGS;

  // --- STORAGE ---
  // New storage capacity if purchased
  const newStorageSqft = decision.storageExpansionTons * SQFT_PER_TON;
  const storageExpansionCost = newStorageSqft * STORAGE_COST_PER_SQFT;
  const newStorageBookValue = prevState.storageBookValue + storageExpansionCost;
  const storageFCost = calcStorageFixedCost(newStorageBookValue); // depreciation

  // Storage needed: beginning inventory + orders (before sales)
  let totalTonsToStore = 0;
  for (const p of products) {
    totalTonsToStore += prevState.inventory[p].tons + decision.orders[p];
  }
  const sqftNeeded = totalTonsToStore * SQFT_PER_TON;
  const ownedSqft  = prevState.storageSqft + newStorageSqft;
  const rentalSqft = Math.max(0, sqftNeeded - ownedSqft);
  const storageRentalCost = rentalSqft * STORAGE_RENTAL_PER_SQFT;
  const totalSalesTons = Object.values(actualSales).reduce((a, b) => a + b, 0);
  const storageVCost = totalSalesTons * STORAGE_VARIABLE_COST_PER_TON;

  // --- TRUCKS ---
  const newTrucks = decision.truckPurchase;
  const truckPurchaseCost = newTrucks * TRUCK_PURCHASE_PRICE;
  const totalTrucks = prevState.trucksOwned + newTrucks;
  const newTruckBookValue = prevState.truckBookValue + truckPurchaseCost;
  const truckFCost = calcTruckFixedCost(newTruckBookValue);

  const trucksNeeded = totalSalesTons / TRUCK_CAPACITY_PER_TRUCK;
  const truckRentalNeeded = Math.max(0, trucksNeeded - totalTrucks);
  const truckRentalCost = truckRentalNeeded * TRUCK_RENTAL_PER_QUARTER;
  const truckVCost = totalSalesTons * TRUCK_VARIABLE_COST_PER_TON;

  // --- LABOR ---
  const workersNeeded = totalSalesTons / LABOR_TONS_PER_WORKER;
  const workersEmployed = decision.employees;
  const newHires = Math.max(0, workersEmployed - prevState.workersEmployed);
  
  // Training costs for new hires
  const fullTimeNewHires = Math.floor(newHires);
  const partTimeNewHires = newHires - fullTimeNewHires;
  const trainingCost = (fullTimeNewHires * TRAINING_COST_FULLTIME) +
                       (partTimeNewHires * TRAINING_COST_PARTTIME);

  let laborCost = 0;
  let overtimeCost = 0;
  if (workersEmployed >= workersNeeded) {
    laborCost = workersEmployed * LABOR_COST_PER_WORKER;
  } else {
    laborCost = workersEmployed * LABOR_COST_PER_WORKER;
    const overtimeWorkers = workersNeeded - workersEmployed;
    overtimeCost = overtimeWorkers * OVERTIME_COST_PER_WORKER;
  }
  laborCost += trainingCost;

  // --- BAD DEBT ---
  const badDebt = calcBadDebtLoss(totalRevenue, decision.creditPolicy);

  // --- MISC EXPENSES ---
  const miscExpenses = MISC_FIXED_PER_QUARTER + (totalSalesTons * MISC_VARIABLE_PER_TON);

  // --- TOTAL OPERATING EXPENSES ---
  const totalOperatingExpenses =
    storageFCost + storageVCost + storageRentalCost +
    truckFCost + truckVCost + truckRentalCost +
    MANAGER_SALARY + laborCost + overtimeCost +
    badDebt + decision.advertising + miscExpenses;

  // --- FINANCING ---
  // Debt/equity ratio uses beginning state
  const beginDebt = prevState.bankNote + prevState.emergencyLoan;
  const beginEquity = prevState.equity;
  const debtEquityRatio = beginEquity > 0 ? beginDebt / beginEquity : 999;

  // Interest on existing debt
  const interestExpense = calcInterestExpense(
    prevState.bankNote, prevState.emergencyLoan, debtEquityRatio, interestScenario
  );

  // Investment income
  const investmentIncome = prevState.investments * (rates.investment / 4);

  // --- NET PROFIT ---
  const netOperatingProfit = grossMargin - totalOperatingExpenses;
  const netProfitBeforeTax = netOperatingProfit + investmentIncome - interestExpense;

  // --- CASH FLOW ---
  const creditPolicy = CREDIT_POLICIES[decision.creditPolicy];
  const currentQtrCollected = totalRevenue * creditPolicy.currentCollectionRate;
  const newAccountsReceivable = (totalRevenue - currentQtrCollected) * (1 - creditPolicy.badDebtRate);

  // Product purchase costs
  let productPurchaseCost = 0;
  for (const p of products) {
    productPurchaseCost += decision.orders[p] * WHOLESALE_PRICES[p];
  }
  // Add emergency order costs
  // (already calculated above per product, sum them here)
  // Note: emergencyOrderCost was calculated per product above but we need total
  // Recalculate total emergency cost
  let totalEmergencyOrderCost = 0;
  for (const p of products) {
    if (decision.placeEmergencyOrders && unfilledOrders[p] > 0) {
      // unfilled was already reduced by recovery above
      // We need the recovered amount: demand - actualSales - remaining unfilled
      // Simpler: track in products loop above
    }
  }

  // Cash available at start of quarter
  const beginCash = prevState.cash;
  const collectedFromLastQtr = prevState.accountsReceivable; // collected this quarter

  // Loans: borrowing happens at start of quarter
  const borrowed = decision.borrow;
  const repaid   = Math.min(decision.repayLoan, prevState.bankNote);

  // Investment decisions
  const investmentCalled = Math.min(decision.callInvestment, prevState.investments);
  const investmentMade   = decision.makeInvestment;

  // Total cash in
  const totalCashIn =
    beginCash +
    currentQtrCollected +
    collectedFromLastQtr +
    investmentIncome +
    borrowed +
    investmentCalled;

  // Total cash out
  const totalCashOut =
    productPurchaseCost +
    storageVCost + storageRentalCost +
    truckVCost + truckRentalCost +
    MANAGER_SALARY + laborCost + overtimeCost +
    badDebt + decision.advertising + miscExpenses +
    interestExpense +
    storageExpansionCost + truckPurchaseCost +
    repaid + investmentMade;

  let endCash = totalCashIn - totalCashOut;

  // Emergency loan if cash goes negative
  let newEmergencyLoan = prevState.emergencyLoan;
  if (endCash < 0) {
    newEmergencyLoan += Math.abs(endCash);
    endCash = 0;
  }

  // Must repay current portion of bank note + any emergency loan
  // (already included in repaid above for regular, emergency handled separately)

  // --- UPDATED BALANCE SHEET ---
  // Bank note: reduce by required principal payment
  // The loan started at end of Q0, first payment in Q1
  // Equal quarterly principal = original loan / 40
  const originalLoan = prevState.originalLoanPrincipal || prevState.bankNote;
  const requiredPrincipal = originalLoan / LOAN_QUARTERS;
  const newBankNote = Math.max(0, prevState.bankNote - repaid);

  const newInvestments = prevState.investments - investmentCalled + investmentMade;

  // Fixed assets after depreciation
  const endStorageBookValue = newStorageBookValue - storageFCost;
  const endTruckBookValue   = newTruckBookValue - truckFCost;

  // Equity
  const newEquity = prevState.equity + netProfitBeforeTax;

  // --- UTILIZATION METRICS ---
  const storageUtilization = (sqftNeeded / ownedSqft) * 100;
  const truckUtilization   = (totalSalesTons / (totalTrucks * TRUCK_CAPACITY_PER_TRUCK)) * 100;
  const laborUtilization   = (totalSalesTons / (workersEmployed * LABOR_TONS_PER_WORKER)) * 100;

  // --- MARKET AVERAGE PRICES (for next quarter limits) ---
  // This gets averaged across all teams by the market processor

  // ============================================================
  // BUILD RESULT OBJECT
  // ============================================================

  const newState = {
    // Cash & financial assets
    cash:               endCash,
    accountsReceivable: newAccountsReceivable,
    investments:        Math.max(0, newInvestments),

    // Inventory
    inventory: endInventory,

    // Fixed assets
    storageBookValue:   endStorageBookValue,
    storageSqft:        ownedSqft,
    truckBookValue:     endTruckBookValue,
    trucksOwned:        totalTrucks,

    // Liabilities
    bankNote:           newBankNote,
    emergencyLoan:      newEmergencyLoan,
    originalLoanPrincipal: prevState.originalLoanPrincipal,

    // Equity
    equity:             newEquity,

    // Labor
    workersEmployed:    workersEmployed,

    // Prices charged this quarter (needed for market average next quarter)
    prices:             decision.prices,
  };

  const report = {
    // Income statement
    revenue,
    totalRevenue,
    cogs,
    totalCOGS,
    grossMargin,

    // Operating expenses
    expenses: {
      storageFCost,
      storageVCost,
      storageRentalCost,
      truckFCost,
      truckVCost,
      truckRentalCost,
      managerSalary:    MANAGER_SALARY,
      laborCost,
      overtimeCost,
      badDebt,
      advertising:      decision.advertising,
      miscExpenses,
    },
    totalOperatingExpenses,
    netOperatingProfit,

    // Other income/expense
    investmentIncome,
    interestExpense,
    netProfitBeforeTax,

    // Sales detail
    actualSales,
    unfilledOrders,
    totalSalesTons,

    // Balance sheet
    newState,

    // Cash flow
    cashFlow: {
      beginCash,
      currentQtrCollected,
      collectedFromLastQtr,
      investmentIncome,
      borrowed,
      investmentCalled,
      totalCashIn,
      productPurchaseCost,
      totalCashOut,
      endCash,
    },

    // Utilization
    utilization: {
      storageUtilization,
      truckUtilization,
      laborUtilization,
      ownedSqft,
      totalTrucks,
      workersEmployed,
    },

    // Key ratios
    ratios: {
      currentRatio: endCash > 0
        ? (endCash + newAccountsReceivable + Object.values(endInventory).reduce((s,v)=>s+v.value,0) + newInvestments) /
          (newBankNote / LOAN_QUARTERS + newEmergencyLoan)
        : 0,
      debtEquityRatio: newEquity > 0 ? (newBankNote + newEmergencyLoan) / newEquity : 999,
      grossMarginPct:  totalRevenue > 0 ? (grossMargin / totalRevenue) * 100 : 0,
      netProfitPct:    totalRevenue > 0 ? (netProfitBeforeTax / totalRevenue) * 100 : 0,
    },
  };

  return report;
}

// ============================================================
// INITIAL STATE (Quarter 0 results, all teams start equal)
// ============================================================

function createInitialState() {
  return {
    cash:               3056,
    accountsReceivable: 155643,
    investments:        30000,
    inventory: {
      completeFeed:    { tons: 124.63, value: 19940 },
      concentrateFeed: { tons:  24.87, value:  6292 },
      commGradeFert:   { tons: 195.23, value: 18156 },
      customBlendFert: { tons:   0.00, value:     0 },
    },
    storageBookValue:   297360,
    storageSqft:        14000,
    truckBookValue:     105000,
    trucksOwned:        5,
    bankNote:           275000,  // 268125 long-term + 6875 current = 275000
    emergencyLoan:      0,
    originalLoanPrincipal: 275000,
    equity:             360447,
    workersEmployed:    7,
    prices: { ...STARTING_PRICES },
  };
}

// ============================================================
// MARKET PROCESSOR (runs all teams for one quarter)
// ============================================================

/**
 * Process a full quarter for all teams in a market.
 * 
 * @param {Array} teamStates - array of previous state objects, one per team
 * @param {Array} teamDecisions - array of decision objects, one per team
 * @param {string} interestScenario - 'A', 'B', or 'C'
 * @param {number} quarterIndex - 0-based quarter number (0 = Q1 Year 1)
 * @param {number} randomSeed - optional seed for reproducibility
 * @returns {object} { teamReports, marketReport }
 */
function processMarketQuarter(teamStates, teamDecisions, interestScenario, quarterIndex) {
  const products = ['completeFeed', 'concentrateFeed', 'commGradeFert', 'customBlendFert'];

  // Validate all team prices are within $4 of market average
  const currentAvgPrices = {};
  for (const p of products) {
    const prices = teamDecisions.map(d => d.prices[p]);
    currentAvgPrices[p] = prices.reduce((a, b) => a + b, 0) / prices.length;
  }

  // Validate prices (flag violations)
  const priceViolations = teamDecisions.map((decision, i) => {
    const violations = [];
    for (const p of products) {
      const diff = Math.abs(decision.prices[p] - currentAvgPrices[p]);
      if (diff > PRICE_RANGE + 0.01) { // small tolerance for floating point
        violations.push({
          product: p,
          teamPrice: decision.prices[p],
          avgPrice: currentAvgPrices[p],
          diff,
        });
      }
    }
    return violations;
  });

  // Generate base market demand (same random draw for all teams)
  // Historical data in the manual is per-store, so scale up by numTeams
  // to get total market demand, then split by competitive share
  const perStoreDemand = calculateBaseMarketDemand(quarterIndex);
  const numTeams = teamStates.length;
  const baseMarketDemand = {};
  for (const p of Object.keys(perStoreDemand)) {
    baseMarketDemand[p] = perStoreDemand[p] * numTeams;
  }

  // Calculate per-team demand
  const teamDemands = calculateTeamDemand(teamDecisions, baseMarketDemand, currentAvgPrices);

  // Process each team
  const teamReports = teamStates.map((state, i) => {
    return processQuarter(
      state,
      teamDecisions[i],
      teamDemands[i],
      currentAvgPrices,
      interestScenario,
      quarterIndex
    );
  });

  // Calculate next quarter price limits
  const nextQtrAvgPrices = {};
  const nextQtrPriceLimits = {};
  for (const p of products) {
    const prices = teamDecisions.map(d => d.prices[p]);
    nextQtrAvgPrices[p] = prices.reduce((a, b) => a + b, 0) / prices.length;
    nextQtrPriceLimits[p] = {
      min: nextQtrAvgPrices[p] - PRICE_RANGE,
      max: nextQtrAvgPrices[p] + PRICE_RANGE,
    };
  }

  // Market share report
  const marketReport = {
    quarterIndex,
    quarterLabel: `Q${(quarterIndex % 4) + 1} Year ${Math.floor(quarterIndex / 4) + 1}`,
    currentAvgPrices,
    nextQtrPriceLimits,
    baseMarketDemand,
    teamSummaries: teamReports.map((r, i) => ({
      teamIndex: i,
      prices:    teamDecisions[i].prices,
      advertising: teamDecisions[i].advertising,
      salesTons: r.actualSales,
      totalSalesTons: r.totalSalesTons,
      marketShare: {},
      priceViolations: priceViolations[i],
    })),
    wholesalePrices: WHOLESALE_PRICES,
  };

  // Calculate market share percentages
  const totalMarketSales = {};
  for (const p of products) {
    totalMarketSales[p] = teamReports.reduce((sum, r) => sum + r.actualSales[p], 0);
  }
  marketReport.teamSummaries.forEach((summary, i) => {
    for (const p of products) {
      summary.marketShare[p] = totalMarketSales[p] > 0
        ? (teamReports[i].actualSales[p] / totalMarketSales[p]) * 100
        : 0;
    }
  });

  return { teamReports, marketReport, priceViolations };
}

// ============================================================
// INPUT VALIDATION
// ============================================================

/**
 * Validate a team's decision and return warnings/errors.
 */
function validateDecision(decision, prevState, currentAvgPrices) {
  const warnings = [];
  const errors   = [];
  const products = ['completeFeed', 'concentrateFeed', 'commGradeFert', 'customBlendFert'];

  // Price range check
  for (const p of products) {
    const avg = currentAvgPrices[p];
    const diff = Math.abs(decision.prices[p] - avg);
    if (diff > PRICE_RANGE) {
      errors.push(`Price for ${p} ($${decision.prices[p]}) is $${diff.toFixed(2)} from market average — exceeds $4.00 limit.`);
    }
    if (decision.prices[p] < WHOLESALE_PRICES[p]) {
      warnings.push(`Price for ${p} ($${decision.prices[p]}) is below wholesale cost ($${WHOLESALE_PRICES[p]}) — selling at a loss.`);
    }
  }

  // Order quantity sanity
  for (const p of products) {
    if (decision.orders[p] < 0) errors.push(`Order for ${p} cannot be negative.`);
    if (decision.orders[p] > 10000) warnings.push(`Order for ${p} (${decision.orders[p]} tons) seems very large.`);
  }

  // Storage check
  let totalTonsToStore = 0;
  for (const p of products) {
    totalTonsToStore += (prevState.inventory[p]?.tons || 0) + decision.orders[p];
  }
  const ownedSqft = prevState.storageSqft + (decision.storageExpansionTons * SQFT_PER_TON);
  const sqftNeeded = totalTonsToStore * SQFT_PER_TON;
  if (sqftNeeded > ownedSqft * 1.5) {
    warnings.push(`Storage needs (${sqftNeeded.toFixed(0)} sqft) significantly exceed owned capacity (${ownedSqft.toFixed(0)} sqft) — high rental cost expected.`);
  }

  // Workers
  if (decision.employees < MIN_WORKERS) {
    errors.push(`Must employ at least ${MIN_WORKERS} workers. Decision has ${decision.employees}.`);
  }

  // Cash flow rough check
  const approxPurchaseCost = Object.values(decision.orders).reduce((s, v) => s, 0);
  // (simplified — full check runs during processing)

  // Credit policy
  if (![1, 2, 3].includes(decision.creditPolicy)) {
    errors.push(`Credit policy must be 1, 2, or 3.`);
  }

  // Advertising
  if (decision.advertising < 0) errors.push(`Advertising cannot be negative.`);
  if (decision.advertising === 0) warnings.push(`Zero advertising may significantly reduce sales.`);
  if (decision.advertising > 20000) warnings.push(`Advertising ($${decision.advertising}) is unusually high.`);

  return { warnings, errors, isValid: errors.length === 0 };
}

// ============================================================
// EXPORTS (for use in browser via script tag or Node.js)
// ============================================================

const SimEngine = {
  // Constants
  WHOLESALE_PRICES,
  STARTING_PRICES,
  PRICE_RANGE,
  CREDIT_POLICIES,
  INTEREST_SCENARIOS,
  SEASONAL_INDICES,

  // Core functions
  createInitialState,
  processMarketQuarter,
  validateDecision,
  calculateBaseMarketDemand,

  // Helpers
  randomNormal,
};

// Support both browser (window) and Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SimEngine;
} else if (typeof window !== 'undefined') {
  window.SimEngine = SimEngine;
}
