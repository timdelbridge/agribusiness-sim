/**
 * Agribusiness Sim — Firestore data-access layer.
 *
 * Thin wrapper around the Firebase modular SDK. Owns nothing about UI;
 * every function here takes/returns plain data. `simulation-engine.js`
 * must be loaded as a normal <script> tag (not a module) before this
 * module runs, since SimEngine.createInitialState()/processMarketQuarter
 * are referenced as globals below.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, signInAnonymously, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, collection, query, where, orderBy,
  setDoc, updateDoc, runTransaction, writeBatch, onSnapshot, serverTimestamp, increment,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const PRODUCTS = ["completeFeed", "concentrateFeed", "commGradeFert", "customBlendFert"];
const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const JOIN_CODE_LENGTH = 6;
const MAX_JOIN_CODE_ATTEMPTS = 5;

function randomJoinCode() {
  let code = "";
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[Math.floor(Math.random() * JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

function randomPin() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits, no leading-zero surprises
}

function slugifyTeamName(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "team";
}

// ============================================================
// AUTH
// ============================================================

function onInstructorAuthChanged(callback) {
  return onAuthStateChanged(auth, (user) => callback(user && !user.isAnonymous ? user : null));
}

async function registerInstructor(email, password) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  return cred.user;
}

async function signInInstructor(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

async function signOutInstructor() {
  await signOut(auth);
}

/** Ensures the current browser has an anonymous session (students only). */
async function ensureAnonymousSession() {
  if (auth.currentUser) return auth.currentUser;
  const cred = await signInAnonymously(auth);
  return cred.user;
}

// ============================================================
// MARKET (instructor)
// ============================================================

async function createMarket({ name, interestScenario, maxTeams, totalQuarters = 12 }) {
  const instructorUid = auth.currentUser && auth.currentUser.uid;
  if (!instructorUid) throw new Error("Must be signed in as an instructor to create a market.");

  for (let attempt = 0; attempt < MAX_JOIN_CODE_ATTEMPTS; attempt++) {
    const joinCode = randomJoinCode();
    const marketRef = doc(db, "markets", joinCode);
    try {
      await setDoc(marketRef, {
        instructorUid,
        name,
        joinCode,
        interestScenario,
        maxTeams,
        totalQuarters,
        status: "forming",
        currentQuarterIndex: 0,
        teamCount: 0,
        createdAt: serverTimestamp(),
        lockedAt: null,
      });
      return { marketId: joinCode, joinCode };
    } catch (e) {
      // Permission-denied here means the join code is already taken
      // (the doc exists, so this write was classified as an "update" and
      // rejected by rules) -- retry with a fresh random code.
      if (attempt === MAX_JOIN_CODE_ATTEMPTS - 1) throw e;
    }
  }
  throw new Error("Could not generate a unique join code — please try again.");
}

async function lockMarket(marketId) {
  await updateDoc(doc(db, "markets", marketId), { status: "active", lockedAt: serverTimestamp() });
}

async function getMarket(marketId) {
  const snap = await getDoc(doc(db, "markets", marketId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

function listenToMarket(marketId, callback) {
  return onSnapshot(doc(db, "markets", marketId), (snap) => {
    callback(snap.exists() ? { id: snap.id, ...snap.data() } : null);
  });
}

/** Normalizes user-typed join codes (case/whitespace) before lookup. */
async function lookupMarketByJoinCode(rawCode) {
  const code = String(rawCode).trim().toUpperCase();
  return getMarket(code);
}

/** Lists markets owned by the given instructor, most recent first. */
async function listMyMarkets(instructorUid) {
  const q = query(
    collection(db, "markets"),
    where("instructorUid", "==", instructorUid),
    orderBy("createdAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ============================================================
// TEAMS
// ============================================================

async function listTeams(marketId) {
  // No composite index needed: this reads the small teams subcollection
  // directly rather than a filtered query. Fine at classroom scale (<=6).
  const snap = await getDocs(collection(db, "markets", marketId, "teams"));
  return snap.docs.map((d) => ({ id: d.id, name: d.data().name }));
}

function listenToTeams(marketId, callback) {
  return onSnapshot(collection(db, "markets", marketId, "teams"), (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, name: d.data().name })));
  });
}

/**
 * Creates a brand-new team. Only succeeds while the market is still
 * 'forming' and under its team cap; enforced by firestore.rules, not just
 * this client-side check (see the transaction below and the maxTeams note
 * in firestore.rules).
 */
async function createTeam(marketId, teamName) {
  const teamId = slugifyTeamName(teamName);
  const marketRef = doc(db, "markets", marketId);
  const teamRef = doc(db, "markets", marketId, "teams", teamId);
  const secretRef = doc(db, "markets", marketId, "teams", teamId, "private", "secret");
  const stateRef = doc(db, "markets", marketId, "teams", teamId, "private", "state");
  const pin = randomPin();

  await runTransaction(db, async (tx) => {
    const [marketSnap, teamSnap] = await Promise.all([tx.get(marketRef), tx.get(teamRef)]);
    if (!marketSnap.exists()) throw new Error("Market not found.");
    const market = marketSnap.data();
    if (market.status !== "forming") throw new Error("Team formation is closed for this market.");
    if (market.teamCount >= market.maxTeams) throw new Error("This market already has its maximum number of teams.");
    if (teamSnap.exists()) throw new Error("A team with that name already exists in this market — pick another name, or select it from the list and enter its PIN.");

    tx.set(teamRef, { name: teamName, createdAt: serverTimestamp() });
    tx.set(secretRef, { pin });
    tx.set(stateRef, window.SimEngine.createInitialState());
    tx.update(marketRef, { teamCount: increment(1) });
  });

  await ensureAnonymousSession();
  await linkSessionToTeam(marketId, teamId, pin);
  return { teamId, pin };
}

/**
 * Attaches the current anonymous session to a team by verifying its PIN.
 * Throws (permission-denied, surfaced as a generic Error by the SDK) if
 * the PIN is wrong -- firestore.rules is the actual authority here.
 */
async function linkSessionToTeam(marketId, teamId, pin) {
  const user = await ensureAnonymousSession();
  const linkRef = doc(db, "teamAuthLinks", `${user.uid}_${teamId}`);
  try {
    await setDoc(linkRef, {
      marketId, teamId, authUid: user.uid, enteredPin: String(pin), createdAt: serverTimestamp(),
    });
  } catch (e) {
    throw new Error("Incorrect PIN.");
  }
  return { teamId };
}

/** Checks whether this browser is already linked to the given team. */
async function findExistingLink(teamId) {
  const user = auth.currentUser;
  if (!user) return false;
  const snap = await getDoc(doc(db, "teamAuthLinks", `${user.uid}_${teamId}`));
  return snap.exists();
}

/**
 * Finds which team (if any) this browser's anonymous session is already
 * linked to within a given market -- lets a returning student skip
 * straight to their decision form without re-entering a PIN.
 */
async function findMyLinkedTeamInMarket(marketId) {
  const user = await ensureAnonymousSession();
  const q = query(
    collection(db, "teamAuthLinks"),
    where("authUid", "==", user.uid),
    where("marketId", "==", marketId)
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  return snap.docs[0].data().teamId;
}

async function fetchTeamState(marketId, teamId) {
  const snap = await getDoc(doc(db, "markets", marketId, "teams", teamId, "private", "state"));
  return snap.exists() ? snap.data() : null;
}

// ============================================================
// DECISIONS
// ============================================================

async function submitDecision(marketId, teamId, quarterIndex, decision) {
  const ref = doc(db, "markets", marketId, "teams", teamId, "decisions", String(quarterIndex));
  await setDoc(ref, { ...decision, submittedAt: serverTimestamp() });
}

async function fetchDecision(marketId, teamId, quarterIndex) {
  const snap = await getDoc(doc(db, "markets", marketId, "teams", teamId, "decisions", String(quarterIndex)));
  return snap.exists() ? snap.data() : null;
}

/**
 * One small onSnapshot listener per team (fine at classroom scale, <=6
 * teams) rather than a collection-group query -- avoids needing a
 * composite Firestore index just to watch live submissions.
 * Calls back with (teamId, decisionOrNull) whenever that team's decision
 * document for this quarter changes.
 */
function listenToRoundDecisions(marketId, teams, quarterIndex, onUpdate) {
  const unsubscribers = teams.map((t) => {
    const ref = doc(db, "markets", marketId, "teams", t.id, "decisions", String(quarterIndex));
    return onSnapshot(ref, (snap) => onUpdate(t.id, snap.exists() ? snap.data() : null));
  });
  return () => unsubscribers.forEach((unsub) => unsub());
}

// ============================================================
// ROUND PROCESSING
// ============================================================

async function fetchAllTeamStates(marketId, teams) {
  const entries = await Promise.all(teams.map(async (t) => [t.id, await fetchTeamState(marketId, t.id)]));
  return Object.fromEntries(entries);
}

async function fetchAllDecisions(marketId, teams, quarterIndex) {
  const entries = await Promise.all(teams.map(async (t) => [t.id, await fetchDecision(marketId, t.id, quarterIndex)]));
  return Object.fromEntries(entries);
}

/**
 * Runs SimEngine.processMarketQuarter (unchanged, client-side) and commits
 * every resulting write in a single atomic WriteBatch: the market round,
 * each team's report, each team's updated state, and the advanced quarter
 * counter (flipping the market to 'completed' if this was the last one).
 */
async function processQuarterAndCommit(market, teams, teamStates, decisions, quarterIndex) {
  const orderedStates = teams.map((t) => teamStates[t.id]);
  const orderedDecisions = teams.map((t) => decisions[t.id]);

  const { teamReports, marketReport } = window.SimEngine.processMarketQuarter(
    orderedStates, orderedDecisions, market.interestScenario, quarterIndex
  );

  const batch = writeBatch(db);
  const marketRef = doc(db, "markets", market.id);
  batch.set(doc(db, "markets", market.id, "rounds", String(quarterIndex)), marketReport);

  teams.forEach((t, i) => {
    const report = teamReports[i];
    batch.set(doc(db, "markets", market.id, "teams", t.id, "reports", String(quarterIndex)), report);
    batch.update(doc(db, "markets", market.id, "teams", t.id, "private", "state"), report.newState);
  });

  const nextQuarterIndex = quarterIndex + 1;
  const completed = nextQuarterIndex >= market.totalQuarters;
  batch.update(marketRef, {
    currentQuarterIndex: nextQuarterIndex,
    status: completed ? "completed" : "active",
  });

  await batch.commit();
  return { teamReports, marketReport };
}

// ============================================================
// REPORTS
// ============================================================

async function fetchTeamReport(marketId, teamId, quarterIndex) {
  const snap = await getDoc(doc(db, "markets", marketId, "teams", teamId, "reports", String(quarterIndex)));
  return snap.exists() ? snap.data() : null;
}

async function fetchMarketRound(marketId, quarterIndex) {
  const snap = await getDoc(doc(db, "markets", marketId, "rounds", String(quarterIndex)));
  return snap.exists() ? snap.data() : null;
}

// ============================================================
// EXPORTS
// ============================================================

export const FirebaseData = {
  PRODUCTS,
  auth, db,
  onInstructorAuthChanged, registerInstructor, signInInstructor, signOutInstructor,
  ensureAnonymousSession,
  createMarket, lockMarket, getMarket, listenToMarket, lookupMarketByJoinCode, listMyMarkets,
  listTeams, listenToTeams, createTeam, linkSessionToTeam, findExistingLink, findMyLinkedTeamInMarket, fetchTeamState,
  submitDecision, fetchDecision, listenToRoundDecisions,
  fetchAllTeamStates, fetchAllDecisions, processQuarterAndCommit,
  fetchTeamReport, fetchMarketRound,
};
