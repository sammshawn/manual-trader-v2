// ============================================
//  AUTO TRADER PRO — v14.0 (Rise/Fall Support)
//  Added: Rise/Fall mode with continuous trading
// ============================================

const CLIENT_ID = "34XvCEo3LsxqfQz1GEpYN"; // Your App ID
const REDIRECT_URI = window.location.origin + window.location.pathname;
const AUTH_URL = "https://auth.deriv.com/oauth2/auth";
const TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const API_BASE = "https://api.derivws.com/trading/v1/options";

let accessToken = null;
let activeAccount = null;
let ws = null;
let reqId = 1;
let pingInterval = null; 
let reconnectAttempts = 0;

const STATE = { IDLE: "IDLE", PRICING: "PRICING", BUYING: "BUYING", MONITORING: "MONITORING" };
let currentState = STATE.IDLE;

let currentMarket = "R_100";
let selectedBarrier = 5;
let lastDigit = null;
let currentContractId = null;

let isAutoTrading = false;
let currentMartingaleStep = 1;
let baseStake = 0.35;

let totalWins = 0, totalLosses = 0, totalPL = 0;

const $ = (id) => document.getElementById(id);
const loginScreen = $("loginScreen");
const tradingScreen = $("tradingScreen");
const loginBtn = $("loginBtn");
const loginBtnLarge = $("loginBtnLarge");
const logoutBtn = $("logoutBtn");
const accountInfo = $("accountInfo");
const accId = $("accId");
const balanceEl = $("balance");
const marketSelect = $("marketSelect");
const lastPriceEl = $("lastPrice");
const digitCircles = $("digitCircles");
const stakeInput = $("stakeInput");
const tpInput = $("tpInput");
const slInput = $("slInput");
const martingaleMult = $("martingaleMult");
const resultsLog = $("resultsLog");
const resultsCount = $("resultsCount");
const tradeHint = $("tradeHint");
const tradeBtns = document.querySelectorAll(".btn-trade");
const accountSwitcher = $("accountSwitcher");
const pillDemo = $("pillDemo");
const pillReal = $("pillReal");
const statWinsEl = $("statWins");
const statLossesEl = $("statLosses");
const statPLEl = $("statPL");
const resetHistoryBtn = $("resetHistoryBtn");
const startAutoBtn = $("startAutoBtn");
const stopAutoBtn = $("stopAutoBtn");
const autoSignalSelect = $("autoSignalSelect");
const autoModeSelect = $("autoModeSelect");

const DECIMALS_MAP = { R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2, "1HZ10V": 2, "1HZ25V": 2, "1HZ50V": 2, "1HZ75V": 2, "1HZ100V": 2 };
let resultCount = 0;

// ---- ADD RISE/FALL OPTIONS DYNAMICALLY ----
const modeSelect = document.getElementById("autoModeSelect");
const riseFallMode = document.createElement("option");
riseFallMode.value = "risefall";
riseFallMode.text = "Rise / Fall";
modeSelect.appendChild(riseFallMode);

const signalSelect = document.getElementById("autoSignalSelect");
const riseSignal = document.createElement("option");
riseSignal.value = "rise";
riseSignal.text = "Auto RISE";
signalSelect.appendChild(riseSignal);
const fallSignal = document.createElement("option");
fallSignal.value = "fall";
fallSignal.text = "Auto FALL";
signalSelect.appendChild(fallSignal);

// ---- UI BUILDERS ----
function buildCircles() {
  digitCircles.innerHTML = "";
  for (let i = 0; i <= 9; i++) {
    const circle = document.createElement("div");
    circle.className = "digit-circle";
    circle.dataset.digit = i;
    circle.textContent = i;
    if (i === selectedBarrier) circle.classList.add("selected");
    circle.addEventListener("click", () => {
      if (currentState !== STATE.IDLE || isAutoTrading) return;
      document.querySelectorAll(".digit-circle").forEach((c) => c.classList.remove("selected"));
      circle.classList.add("selected");
      selectedBarrier = i;
      tradeHint.textContent = `Barrier: ${selectedBarrier}`;
    });
    digitCircles.appendChild(circle);
  }
}

function updateDashboardStats() {
  statWinsEl.textContent = totalWins;
  statLossesEl.textContent = totalLosses;
  statPLEl.textContent = totalPL >= 0 ? `+$${totalPL.toFixed(2)}` : `-$${Math.abs(totalPL).toFixed(2)}`;
  statPLEl.style.color = totalPL >= 0 ? "var(--green)" : "var(--red)";
}

function addResult(type, profit, entryPrice, exitPrice) {
  resultCount++;
  resultsCount.textContent = resultCount;
  const empty = resultsLog.querySelector(".empty-log");
  if (empty) empty.remove();

  const el = document.createElement("div");
  el.className = `result-item ${type}`;
  const time = new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const plText = profit >= 0 ? `+$${profit.toFixed(2)}` : `-$${Math.abs(profit).toFixed(2)}`;
  const plClass = profit >= 0 ? "positive" : "negative";

  el.innerHTML = `
    <span class="result-time">${time}</span>
    <span class="result-detail">
      <span class="price-entry">In: ${entryPrice || "—"}</span>
      <span class="price-exit">Out: ${exitPrice || "—"}</span>
      <span class="result-message">${profit > 0 ? "WIN" : "LOSS"}</span>
    </span>
    <span class="result-pl ${plClass}">${plText}</span>
  `;
  resultsLog.prepend(el);

  if (profit > 0) totalWins++;
  else totalLosses++;
  totalPL += profit;
  updateDashboardStats();
}

// ---- OAUTH PKCE ----
function generatePKCE() {
  const array = crypto.getRandomValues(new Uint8Array(64));
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const codeVerifier = Array.from(array).map((v) => chars[v % chars.length]).join("");
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");
  sessionStorage.setItem("pkce_code_verifier", codeVerifier);
  sessionStorage.setItem("oauth_state", state);
  return { codeVerifier, state };
}

async function generateCodeChallenge(verifier) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function startLogin() {
  const { codeVerifier, state } = generatePKCE();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const params = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: "trade", state: state, code_challenge: codeChallenge, code_challenge_method: "S256" });
  window.location.href = `${AUTH_URL}?${params.toString()}`;
}

async function handleCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");
  const state = urlParams.get("state");
  if (!code || !state) return false;
  if (state !== sessionStorage.getItem("oauth_state")) return false;
  const codeVerifier = sessionStorage.getItem("pkce_code_verifier");
  if (!codeVerifier) return false;
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code: code, redirect_uri: REDIRECT_URI, code_verifier: codeVerifier }),
    });
    const data = await response.json();
    if (!response.ok) return false;
    accessToken = data.access_token;
    sessionStorage.setItem("deriv_access_token", accessToken);
    sessionStorage.removeItem("pkce_code_verifier");
    sessionStorage.removeItem("oauth_state");
    window.history.replaceState({}, document.title, window.location.pathname);
    return true;
  } catch (err) { return false; }
}

// ---- ACCOUNTS & WEBSOCKET ----
async function fetchAccounts() {
  try {
    const res = await fetch(`${API_BASE}/accounts`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (!res.ok) return false;
    const accounts = data.data || [];
    const demo = accounts.find((a) => (a.type || a.account_type) === "demo");
    const real = accounts.find((a) => (a.type || a.account_type) === "real");
    accountSwitcher.style.display = "flex";
    pillDemo.onclick = () => demo && selectAccount(demo);
    pillReal.onclick = () => real && selectAccount(real);
    if (demo) selectAccount(demo);
    else if (real) selectAccount(real);
    return true;
  } catch (err) { return false; }
}

async function selectAccount(acc) {
  if (currentState !== STATE.IDLE) return;
  activeAccount = { id: acc.account_id, type: acc.type || acc.account_type, currency: acc.currency || "USD" };
  pillDemo.classList.toggle("active", activeAccount.type === "demo");
  pillReal.classList.toggle("active", activeAccount.type === "real");
  accId.textContent = activeAccount.id;
  accountInfo.style.display = "flex";
  if (ws) {
    clearInterval(pingInterval);
    ws.close();
  }
  await connectWS();
}

async function connectWS() {
  try {
    const res = await fetch(`${API_BASE}/accounts/${activeAccount.id}/otp`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    });
    const data = await res.json();
    if (!res.ok) return;
    ws = new WebSocket(data.data.url);

    ws.onopen = () => {
      reconnectAttempts = 0;
      ws.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: reqId++ }));
      subscribeTicks();
      loginScreen.style.display = "none";
      tradingScreen.style.display = "block";
      buildCircles();
      updateDashboardStats();
      currentState = STATE.IDLE;

      clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 }));
      }, 25000);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.error) {
        console.warn("Deriv error:", msg.error.message);
        if (msg.echo_req && (msg.echo_req.buy || msg.echo_req.proposal)) {
          currentState = STATE.IDLE;
          enableTradeButtons(true);
          tradeHint.textContent = "Error: " + msg.error.message;
        }
        return;
      }
      if (msg.msg_type === "balance") balanceEl.textContent = `$${parseFloat(msg.balance.balance).toFixed(2)}`;
      if (msg.msg_type === "tick") handleTick(msg.tick);
      if (msg.msg_type === "proposal") handleProposal(msg.proposal);
      if (msg.msg_type === "buy") handleBuy(msg.buy);
      if (msg.msg_type === "proposal_open_contract" && msg.proposal_open_contract) handleContractUpdate(msg.proposal_open_contract);
    };

    ws.onclose = () => {
      clearInterval(pingInterval);
      if (accessToken && activeAccount && reconnectAttempts < 3) {
        reconnectAttempts++;
        tradeHint.textContent = `Reconnecting (${reconnectAttempts}/3)...`;
        setTimeout(connectWS, 2000);
      } else {
        tradeHint.textContent = "Disconnected. Please refresh.";
        currentState = STATE.IDLE;
        enableTradeButtons(true);
      }
    };
  } catch (err) { console.warn("Connection failed:", err); }
}

function subscribeTicks() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ forget_all: "ticks", req_id: reqId++ }));
  setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ticks: currentMarket, subscribe: 1, req_id: reqId++ }));
  }, 100);
}

// ---- TICK HANDLER ----
function handleTick(tick) {
  if (tick.symbol !== currentMarket) return;
  const decimals = DECIMALS_MAP[currentMarket] || 2;
  const priceStr = parseFloat(tick.quote).toFixed(decimals);
  lastDigit = parseInt(priceStr.slice(-1), 10);
  lastPriceEl.textContent = priceStr;

  document.querySelectorAll(".digit-circle").forEach((c) => c.classList.remove("active"));
  const activeCircle = document.querySelector(`.digit-circle[data-digit="${lastDigit}"]`);
  if (activeCircle) activeCircle.classList.add("active");

  // 🚨 RISE/FALL CONTINUOUS TRADING
  if (autoModeSelect.value === "risefall" && isAutoTrading && currentState === STATE.IDLE) {
    // Determine which signal to use (rise or fall)
    const signal = autoSignalSelect.value === "rise" ? "rise" : "fall";
    requestTrade(signal);
  }
}

// ---- TRADING FLOW ----
function getStake() {
  const mult = parseFloat(martingaleMult.value) || 1;
  return (baseStake * Math.pow(mult, currentMartingaleStep - 1)).toFixed(2);
}

function requestTrade(signalType) {
  if (currentState !== STATE.IDLE || !ws || ws.readyState !== WebSocket.OPEN) return;

  currentState = STATE.PRICING;
  enableTradeButtons(false);

  let contractType = null;
  let barrier = null;

  // 🚨 RISE/FALL MODE
  if (autoModeSelect.value === "risefall" && isAutoTrading) {
    if (signalType === "rise") contractType = "CALL";
    else if (signalType === "fall") contractType = "PUT";
    else { currentState = STATE.IDLE; return; }
    // No barrier needed for Rise/Fall
  }
  // Over/Under (Digit) mode
  else if (autoModeSelect.value === "fixed" || autoModeSelect.value === "dynamic") {
    if (signalType === "over") { contractType = "DIGITOVER"; barrier = selectedBarrier; }
    else if (signalType === "under") { contractType = "DIGITUNDER"; barrier = selectedBarrier; }
    else if (signalType === "even") { contractType = "DIGITEVEN"; }
    else if (signalType === "odd") { contractType = "DIGITODD"; }
  }
  else {
    // Fallback for manual modes
    if (signalType === "over") { contractType = "DIGITOVER"; barrier = selectedBarrier; }
    else if (signalType === "under") { contractType = "DIGITUNDER"; barrier = selectedBarrier; }
    else if (signalType === "even") { contractType = "DIGITEVEN"; }
    else if (signalType === "odd") { contractType = "DIGITODD"; }
    else if (signalType === "rise") { contractType = "CALL"; }
    else if (signalType === "fall") { contractType = "PUT"; }
  }

  const stake = getStake();
  const req = {
    proposal: 1, amount: stake, basis: "stake", contract_type: contractType,
    currency: activeAccount.currency, duration: 1, duration_unit: "t",
    underlying_symbol: currentMarket, req_id: reqId++,
  };
  if (barrier !== null) req.barrier = String(barrier);

  ws.send(JSON.stringify(req));
  tradeHint.textContent = `Requesting ${contractType} @ $${stake}...`;
}

function handleProposal(proposal) {
  if (currentState !== STATE.PRICING) return;
  currentState = STATE.BUYING;
  ws.send(JSON.stringify({ buy: proposal.id, price: proposal.ask_price, req_id: reqId++ }));
}

function handleBuy(buy) {
  if (currentState !== STATE.BUYING) return;
  currentContractId = buy.contract_id;
  currentState = STATE.MONITORING;
  ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: currentContractId, subscribe: 1, req_id: reqId++ }));
}

function handleContractUpdate(contract) {
  if (currentState !== STATE.MONITORING) return;
  if (contract.contract_id !== currentContractId) return;
  if (!contract.is_sold) return;

  const profit = parseFloat(contract.profit) || 0;
  const decimals = DECIMALS_MAP[currentMarket] || 2;
  const entrySpot = contract.entry_spot ? parseFloat(contract.entry_spot).toFixed(decimals) : "—";
  const exitSpot = contract.exit_spot ? parseFloat(contract.exit_spot).toFixed(decimals) : "—";

  addResult(profit > 0 ? "win" : "loss", profit, entrySpot, exitSpot);
  ws.send(JSON.stringify({ forget: contract.id, req_id: reqId++ }));

  currentState = STATE.IDLE;
  currentContractId = null;

  // Martingale
  if (profit > 0) {
    currentMartingaleStep = 1;
  } else {
    currentMartingaleStep++;
  }

  // TP/SL Check
  const tp = parseFloat(tpInput.value);
  const sl = parseFloat(slInput.value);
  if (totalPL >= tp || totalPL <= -sl) {
    stopAutoTrade();
    tradeHint.textContent = totalPL >= tp ? "🎯 TP Hit!" : "🛑 SL Hit!";
    enableTradeButtons(true);
    return;
  }

  if (isAutoTrading) {
    // The next tick will trigger the next trade automatically
    tradeHint.textContent = `Last: ${profit > 0 ? "WIN" : "LOSS"} · Ready for next...`;
  } else {
    enableTradeButtons(true);
    tradeHint.textContent = `Last: ${profit > 0 ? "WIN" : "LOSS"} · Ready.`;
  }
}

// ---- CONTROLS ----
tradeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (isAutoTrading) return;
    requestTrade(btn.dataset.type);
  });
});

function enableTradeButtons(enabled) {
  tradeBtns.forEach((btn) => (btn.disabled = !enabled));
}

startAutoBtn.addEventListener("click", () => {
  if (currentState !== STATE.IDLE) return;
  isAutoTrading = true;
  startAutoBtn.disabled = true;
  stopAutoBtn.disabled = false;
  enableTradeButtons(false);
  currentMartingaleStep = 1;
  baseStake = parseFloat(stakeInput.value);

  const mode = autoModeSelect.value;
  if (mode === "risefall") {
    tradeHint.textContent = `🤖 Rise/Fall Active (${autoSignalSelect.value.toUpperCase()})...`;
    // Fire immediately
    requestTrade(autoSignalSelect.value);
  } else if (mode === "wave") {
    tradeHint.textContent = `🤖 Wave Dominance Active...`;
    // Wave is triggered by tick handler
  } else {
    tradeHint.textContent = `🤖 Auto Active (${mode})...`;
    requestTrade(autoSignalSelect.value);
  }
});

function stopAutoTrade() {
  isAutoTrading = false;
  startAutoBtn.disabled = false;
  stopAutoBtn.disabled = true;
  enableTradeButtons(true);
  tradeHint.textContent = "Auto Stopped.";
}
stopAutoBtn.addEventListener("click", stopAutoTrade);

resetHistoryBtn.addEventListener("click", () => {
  resultsLog.innerHTML = '<p class="empty-log">No trades yet. Place your first trade above.</p>';
  resultCount = 0; totalWins = 0; totalLosses = 0; totalPL = 0;
  resultsCount.textContent = "0";
  updateDashboardStats();
});

marketSelect.addEventListener("change", () => {
  if (currentState !== STATE.IDLE) return;
  currentMarket = marketSelect.value;
  subscribeTicks();
});

logoutBtn.addEventListener("click", () => {
  sessionStorage.removeItem("deriv_access_token");
  if (pingInterval) clearInterval(pingInterval);
  if (ws) ws.close();
  accessToken = null; activeAccount = null; isAutoTrading = false;
  loginScreen.style.display = "flex"; tradingScreen.style.display = "none";
  accountInfo.style.display = "none"; accountSwitcher.style.display = "none";
  loginBtn.style.display = "block";
});

// ---- BOOT ----
async function init() {
  loginBtn.addEventListener("click", startLogin);
  loginBtnLarge.addEventListener("click", startLogin);
  const success = await handleCallback();
  if (success) {
    const ok = await fetchAccounts();
    if (ok) loginBtn.style.display = "none";
  } else {
    const stored = sessionStorage.getItem("deriv_access_token");
    if (stored) {
      accessToken = stored;
      const ok = await fetchAccounts();
      if (ok) loginBtn.style.display = "none";
    }
  }
}
init();