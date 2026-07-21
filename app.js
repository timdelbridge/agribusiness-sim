/**
 * Agribusiness Sim — shared app logic and state management
 *
 * Owns everything simulation-engine.js does not: persistence
 * (localStorage + gamestate.json), team identity, decision-file
 * parsing/validation, and orchestration around SimEngine's pure
 * functions. Depends on SimEngine (simulation-engine.js) being
 * loaded first via a <script> tag.
 */

const PRODUCTS = ['completeFeed', 'concentrateFeed', 'commGradeFert', 'customBlendFert'];

const STORAGE_KEY = 'agribizSim.gameState.v1';

// ============================================================
// PERSISTENCE — localStorage
// ============================================================

function loadGameState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schemaVersion !== 1) return null;
    return parsed;
  } catch (e) {
    console.error('Failed to load game state from localStorage:', e);
    return null;
  }
}

function saveGameState(gameState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(gameState));
    return true;
  } catch (e) {
    console.error('Failed to save game state to localStorage:', e);
    return false;
  }
}

function clearGameState() {
  localStorage.removeItem(STORAGE_KEY);
}

// ============================================================
// PERSISTENCE — gamestate.json file export/import
// ============================================================

function exportGameStateFile(gameState) {
  const quarterNum = gameState.currentQuarterIndex; // quarters already completed
  const filename = `gamestate_${gameState.gameId}_Q${quarterNum}.json`;
  const blob = new Blob([JSON.stringify(gameState, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return filename;
}

function isValidGameStateShape(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.schemaVersion !== 1) return false;
  if (!Array.isArray(obj.teams) || obj.teams.length < 2 || obj.teams.length > 6) return false;
  if (!obj.teamStates || typeof obj.teamStates !== 'object') return false;
  if (typeof obj.currentQuarterIndex !== 'number') return false;
  if (!['A', 'B', 'C'].includes(obj.interestScenario)) return false;
  for (const t of obj.teams) {
    if (!t.teamId || !t.teamName) return false;
    if (!obj.teamStates[t.teamId]) return false;
  }
  return true;
}

function importGameStateFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!isValidGameStateShape(parsed)) {
          reject(new Error(`"${file.name}" does not look like a valid gamestate.json file.`));
          return;
        }
        resolve(parsed);
      } catch (e) {
        reject(new Error(`"${file.name}" is not valid JSON.`));
      }
    };
    reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
    reader.readAsText(file);
  });
}

// ============================================================
// GAME CREATION
// ============================================================

function makeGameId() {
  return `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function slugifyTeamId(index) {
  return `team${index + 1}`;
}

/**
 * @param {object} opts
 * @param {string[]} opts.teamNames - 2-6 team display names
 * @param {'A'|'B'|'C'} opts.interestScenario
 * @param {number} [opts.totalQuarters]
 */
function createNewGame({ teamNames, interestScenario, totalQuarters = 12 }) {
  if (!Array.isArray(teamNames) || teamNames.length < 2 || teamNames.length > 6) {
    throw new Error('A game requires between 2 and 6 teams.');
  }
  if (!['A', 'B', 'C'].includes(interestScenario)) {
    throw new Error('Interest rate scenario must be A, B, or C.');
  }

  const teams = teamNames.map((name, i) => ({
    teamId: slugifyTeamId(i),
    teamName: String(name).trim() || `Team ${i + 1}`,
  }));

  const teamStates = {};
  for (const t of teams) {
    teamStates[t.teamId] = SimEngine.createInitialState();
  }

  const gameState = {
    schemaVersion: 1,
    gameId: makeGameId(),
    createdAt: new Date().toISOString(),
    interestScenario,
    totalQuarters,
    teams,
    teamStates,
    currentQuarterIndex: 0,
    pendingDecisions: {},
    history: [],
  };

  return gameState;
}

// ============================================================
// DECISION FILE PARSING (untrusted input — structural validation)
// ============================================================

const DECISION_NUMERIC_FIELDS = [
  'storageExpansionTons', 'truckPurchase', 'employees', 'advertising',
  'borrow', 'repayLoan', 'callInvestment', 'makeInvestment',
];

function isFiniteNonNegNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Structural/type validation of a raw parsed decision object, independent of
 * SimEngine.validateDecision's business-rule checks. Returns { ok, decision, errors }.
 * `decision` is only populated when ok === true.
 */
function validateDecisionShape(raw, gameState) {
  const errors = [];

  if (!raw || typeof raw !== 'object') {
    return { ok: false, decision: null, errors: ['File does not contain a JSON object.'] };
  }

  if (raw.gameId !== gameState.gameId) {
    errors.push(`This file belongs to a different game (expected game "${gameState.gameId}", got "${raw.gameId}").`);
  }

  if (typeof raw.teamId !== 'string' || !gameState.teams.some(t => t.teamId === raw.teamId)) {
    errors.push(`Unknown team id "${raw.teamId}" — does not match any team in this game.`);
  }

  if (raw.quarterIndex !== gameState.currentQuarterIndex) {
    errors.push(`This decision is for quarter index ${raw.quarterIndex}, but the game is currently on quarter index ${gameState.currentQuarterIndex}.`);
  }

  if (!raw.prices || typeof raw.prices !== 'object') {
    errors.push('Missing "prices" object.');
  } else {
    for (const p of PRODUCTS) {
      if (!isFiniteNonNegNumber(raw.prices[p])) {
        errors.push(`Price for ${p} is missing or not a valid non-negative number.`);
      }
    }
  }

  if (!raw.orders || typeof raw.orders !== 'object') {
    errors.push('Missing "orders" object.');
  } else {
    for (const p of PRODUCTS) {
      if (!isFiniteNonNegNumber(raw.orders[p])) {
        errors.push(`Order quantity for ${p} is missing or not a valid non-negative number.`);
      }
    }
  }

  if (typeof raw.placeEmergencyOrders !== 'boolean') {
    errors.push('"placeEmergencyOrders" must be true or false.');
  }

  for (const field of DECISION_NUMERIC_FIELDS) {
    if (!isFiniteNonNegNumber(raw[field])) {
      errors.push(`"${field}" is missing or not a valid non-negative number.`);
    }
  }

  if (![1, 2, 3].includes(raw.creditPolicy)) {
    errors.push('"creditPolicy" must be 1, 2, or 3.');
  }

  if (errors.length > 0) {
    return { ok: false, decision: null, errors };
  }

  // Build a clean decision object with only known fields (defensive against
  // extra/unexpected keys in an externally-supplied file).
  const decision = {
    gameId: raw.gameId,
    teamId: raw.teamId,
    teamName: raw.teamName,
    quarterIndex: raw.quarterIndex,
    prices: {
      completeFeed: raw.prices.completeFeed,
      concentrateFeed: raw.prices.concentrateFeed,
      commGradeFert: raw.prices.commGradeFert,
      customBlendFert: raw.prices.customBlendFert,
    },
    orders: {
      completeFeed: raw.orders.completeFeed,
      concentrateFeed: raw.orders.concentrateFeed,
      commGradeFert: raw.orders.commGradeFert,
      customBlendFert: raw.orders.customBlendFert,
    },
    placeEmergencyOrders: raw.placeEmergencyOrders,
    storageExpansionTons: raw.storageExpansionTons,
    truckPurchase: raw.truckPurchase,
    employees: raw.employees,
    creditPolicy: raw.creditPolicy,
    advertising: raw.advertising,
    borrow: raw.borrow,
    repayLoan: raw.repayLoan,
    callInvestment: raw.callInvestment,
    makeInvestment: raw.makeInvestment,
  };

  return { ok: true, decision, errors: [] };
}

function parseDecisionFile(file, gameState) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      let raw;
      try {
        raw = JSON.parse(reader.result);
      } catch (e) {
        resolve({ ok: false, decision: null, errors: [`"${file.name}" is not valid JSON.`] });
        return;
      }
      resolve(validateDecisionShape(raw, gameState));
    };
    reader.onerror = () => {
      resolve({ ok: false, decision: null, errors: [`Could not read "${file.name}".`] });
    };
    reader.readAsText(file);
  });
}

// ============================================================
// QUARTER PROCESSING ORCHESTRATION
// ============================================================

function getOrderedTeamStates(gameState) {
  return gameState.teams.map(t => gameState.teamStates[t.teamId]);
}

function getOrderedDecisions(gameState) {
  return gameState.teams.map(t => gameState.pendingDecisions[t.teamId]);
}

/**
 * Reference average prices for pre-check validation of a single incoming
 * decision file, before all teams' files are in hand. Uses the previous
 * quarter's actual market average, or the manual's STARTING_PRICES for Q1.
 */
function getReferenceAvgPrices(gameState) {
  if (gameState.history.length > 0) {
    return gameState.history[gameState.history.length - 1].marketReport.currentAvgPrices;
  }
  return { ...SimEngine.STARTING_PRICES };
}

/**
 * True quarter-average validation once every team's decision is present.
 * Returns { [teamId]: { warnings, errors, isValid } }.
 */
function validateAllPendingDecisions(gameState) {
  const decisions = getOrderedDecisions(gameState);
  if (decisions.some(d => !d)) return null; // not all teams submitted yet

  const avgPrices = {};
  for (const p of PRODUCTS) {
    const prices = decisions.map(d => d.prices[p]);
    avgPrices[p] = prices.reduce((a, b) => a + b, 0) / prices.length;
  }

  const results = {};
  gameState.teams.forEach((t, i) => {
    const decision = decisions[i];
    const prevState = gameState.teamStates[t.teamId];
    results[t.teamId] = SimEngine.validateDecision(decision, prevState, avgPrices);
  });
  return results;
}

function allTeamsSubmitted(gameState) {
  return gameState.teams.every(t => !!gameState.pendingDecisions[t.teamId]);
}

/**
 * Runs SimEngine.processMarketQuarter for the current quarter, applies the
 * results to gameState (new team states, history entry, advances the
 * quarter counter, clears pending decisions), and persists to localStorage.
 * Does NOT auto-export the json file — caller decides when to trigger that
 * (kept separate so callers can show a confirmation UI first if desired).
 */
function processCurrentQuarter(gameState) {
  if (!allTeamsSubmitted(gameState)) {
    throw new Error('Cannot process: not all teams have submitted a decision.');
  }

  const teamStates = getOrderedTeamStates(gameState);
  const decisions = getOrderedDecisions(gameState);
  const quarterIndex = gameState.currentQuarterIndex;

  const { teamReports, marketReport } = SimEngine.processMarketQuarter(
    teamStates, decisions, gameState.interestScenario, quarterIndex
  );

  const newTeamStates = {};
  const teamReportsById = {};
  gameState.teams.forEach((t, i) => {
    newTeamStates[t.teamId] = teamReports[i].newState;
    teamReportsById[t.teamId] = teamReports[i];
  });

  gameState.teamStates = newTeamStates;
  gameState.history.push({
    quarterIndex,
    quarterLabel: marketReport.quarterLabel,
    marketReport,
    teamReports: teamReportsById,
  });
  gameState.pendingDecisions = {};
  gameState.currentQuarterIndex = quarterIndex + 1;

  saveGameState(gameState);
  return gameState;
}

// ============================================================
// REPORT PAYLOADS (passed to report-template.html via URL hash)
// ============================================================

function buildReportPayload(gameState, teamId, quarterIndex) {
  const historyEntry = gameState.history.find(h => h.quarterIndex === quarterIndex);
  if (!historyEntry) throw new Error(`No processed history for quarter index ${quarterIndex}.`);
  const team = gameState.teams.find(t => t.teamId === teamId);
  if (!team) throw new Error(`Unknown team id "${teamId}".`);

  return {
    type: 'team',
    gameId: gameState.gameId,
    teamId,
    teamName: team.teamName,
    quarterIndex,
    quarterLabel: historyEntry.quarterLabel,
    interestScenario: gameState.interestScenario,
    report: historyEntry.teamReports[teamId],
  };
}

function buildInstructorSummaryPayload(gameState, quarterIndex) {
  const historyEntry = gameState.history.find(h => h.quarterIndex === quarterIndex);
  if (!historyEntry) throw new Error(`No processed history for quarter index ${quarterIndex}.`);

  return {
    type: 'instructor-summary',
    gameId: gameState.gameId,
    quarterIndex,
    quarterLabel: historyEntry.quarterLabel,
    interestScenario: gameState.interestScenario,
    teams: gameState.teams,
    marketReport: historyEntry.marketReport,
    teamReports: historyEntry.teamReports,
  };
}

function openReport(payload) {
  const encoded = encodeURIComponent(JSON.stringify(payload));
  const win = window.open(`report-template.html#${encoded}`, '_blank');
  if (!win) {
    console.error('Could not open report — popup may have been blocked.');
  }
  return win;
}

// ============================================================
// EXPORTS
// ============================================================

const AppState = {
  PRODUCTS,
  loadGameState,
  saveGameState,
  clearGameState,
  exportGameStateFile,
  importGameStateFile,
  isValidGameStateShape,
  createNewGame,
  validateDecisionShape,
  parseDecisionFile,
  getOrderedTeamStates,
  getOrderedDecisions,
  getReferenceAvgPrices,
  validateAllPendingDecisions,
  allTeamsSubmitted,
  processCurrentQuarter,
  buildReportPayload,
  buildInstructorSummaryPayload,
  openReport,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppState;
} else if (typeof window !== 'undefined') {
  window.AppState = AppState;
}
