// ============================================
//  MANUAL TRADER — v2.0 (Smooth Switching + Demo/Real Toggle)
// ============================================

// ⚠️ REPLACE THIS WITH YOUR ACTUAL DERIV APP ID ⚠️
const CLIENT_ID = "34XvCEo3LsxqfQz1GEpYN"; 

const REDIRECT_URI = window.location.origin + window.location.pathname;
const AUTH_URL = "https://auth.deriv.com/oauth2/auth";
const TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const API_BASE = "https://api.derivws.com/trading/v1/options";

let accessToken = null;
let accounts = [];
let activeAccount = null;
let ws = null;
let reqId = 1;

let currentMarket = "R_100";
let currentDecimals = 2;
let lastPrice = null;
let lastDigit = null;
let selectedBarrier = 5;
let tradeLock = false;
let pendingTrade = null;

// DOM
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
const resultsLog = $("resultsLog");
const resultsCount = $("resultsCount");
const tradeHint = $("tradeHint");
const tradeBtns = document.querySelectorAll(".btn-trade");
const accountSwitcher = $("accountSwitcher");
const pillDemo = $("pillDemo");
const pillReal = $("pillReal");

const DECIMALS_MAP = {
  R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2,
  "1HZ10V": 2, "1HZ25V": 2, "1HZ50V": 2, "1HZ75V": 2, "1HZ100V": 2,
};

let resultCount = 0;

// ---- BUILD DIGIT CIRCLES ----
function buildCircles() {
  digitCircles.innerHTML = "";
  for (let i = 0; i <= 9; i++) {
    const circle = document.createElement("div");
    circle.className = "digit-circle";
    circle.dataset.digit = i;
    circle.textContent = i;
    if (i === selectedBarrier) circle.classList.add("selected");
    circle.addEventListener("click", () => {
      document.querySelectorAll(".digit-circle").forEach((c) => c.classList.remove("selected"));
      circle.classList.add("selected");
      selectedBarrier = i;
      updateHint();
    });
    digitCircles.appendChild(circle);
  }
}

function updateHint() {
  tradeHint.textContent = `Barrier selected: ${selectedBarrier}. Choose a trade type above.`;
}

// ---- LOGGING ----
function addResult(type, message, profit) {
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
    <span class="result-detail">${message}</span>
    <span class="result-pl ${plClass}">${plText}</span>
  `;
  resultsLog.prepend(el);
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
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "trade",
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
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
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: code,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
      }),
    });
    const data = await response.json();
    if (!response.ok) return false;
    accessToken = data.access_token;
    sessionStorage.setItem("deriv_access_token", accessToken);
    sessionStorage.removeItem("pkce_code_verifier");
    sessionStorage.removeItem("oauth_state");
    window.history.replaceState({}, document.title, window.location.pathname);
    return true;
  } catch (err) {
    return false;
  }
}

// ---- FETCH ACCOUNTS ----
async function fetchAccounts() {
  try {
    const res = await fetch(`${API_BASE}/accounts`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (!res.ok) return false;
    accounts = data.data || [];
    
    const demo = accounts.find((a) => (a.type || a.account_type) === "demo");
    const real = accounts.find((a) => (a.type || a.account_type) === "real");

    // Set up toggle
    accountSwitcher.style.display = "flex";
    pillDemo.onclick = () => demo && selectAccount(demo);
    pillReal.onclick = () => real && selectAccount(real);

    // Default to Demo
    if (demo) selectAccount(demo);
    else if (real) selectAccount(real);
    return true;
  } catch (err) {
    return false;
  }
}

// ---- SELECT ACCOUNT ----
async function selectAccount(acc) {
  if (tradeLock) return;
  
  activeAccount = {
    id: acc.account_id,
    type: acc.type || acc.account_type,
    currency: acc.currency || "USD",
  };

  // Update toggle UI
  pillDemo.classList.toggle("active", activeAccount.type === "demo");
  pillReal.classList.toggle("active", activeAccount.type === "real");
  
  accId.textContent = activeAccount.id;
  accountInfo.style.display = "flex";
  
  if (ws) ws.close();
  await connectWS();
}

// ---- WEBSOCKET (OTP) ----
async function connectWS() {
  try {
    const res = await fetch(`${API_BASE}/accounts/${activeAccount.id}/otp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    });
    const data = await res.json();
    if (!res.ok) return;

    ws = new WebSocket(data.data.url);

    ws.onopen = () => {
      ws.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: reqId++ }));
      subscribeTicks();
      loginScreen.style.display = "none";
      tradingScreen.style.display = "block";
      buildCircles();
      updateHint();
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.error) {
        console.warn("Deriv error:", msg.error.message);
        if (msg.echo_req && (msg.echo_req.buy || msg.echo_req.proposal)) {
          tradeLock = false;
          enableTradeButtons(true);
          tradeHint.textContent = "API Error: " + msg.error.message;
        }
        return;
      }

      if (msg.msg_type === "balance" && msg.balance) {
        balanceEl.textContent = `$${parseFloat(msg.balance.balance).toFixed(2)}`;
      }

      if (msg.msg_type === "tick" && msg.tick) {
        handleTick(msg.tick);
      }

      if (msg.msg_type === "proposal" && msg.proposal) {
        handleProposal(msg.proposal);
      }

      if (msg.msg_type === "buy" && msg.buy) {
        handleBuy(msg.buy);
      }

      if (msg.msg_type === "proposal_open_contract" && msg.proposal_open_contract) {
        handleContractUpdate(msg.proposal_open_contract);
      }
    };

    ws.onclose = () => {
      console.log("WS closed");
    };

  } catch (err) {
    console.warn("Connection failed:", err);
  }
}

// 🚨 SMOOTH MARKET SWITCHING
function subscribeTicks() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // 1. Forget all previous subscriptions
  ws.send(JSON.stringify({ forget_all: "ticks", req_id: reqId++ }));
  // 2. Subscribe to the new one after a short delay to prevent overlap
  setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ticks: currentMarket, subscribe: 1, req_id: reqId++ }));
    }
  }, 100);
}

// ---- TICK HANDLER ----
function handleTick(tick) {
  if (tick.symbol !== currentMarket) return;

  const decimals = DECIMALS_MAP[currentMarket] || 2;
  const priceStr = parseFloat(tick.quote).toFixed(decimals);
  lastPrice = priceStr;
  lastDigit = parseInt(priceStr.slice(-1), 10);

  lastPriceEl.textContent = priceStr;

  document.querySelectorAll(".digit-circle").forEach((c) => c.classList.remove("active"));
  const activeCircle = document.querySelector(`.digit-circle[data-digit="${lastDigit}"]`);
  if (activeCircle) activeCircle.classList.add("active");
}

// ---- TRADE BUTTONS ----
tradeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (tradeLock || !ws || ws.readyState !== WebSocket.OPEN) return;
    const type = btn.dataset.type;
    const stake = parseFloat(stakeInput.value);
    if (!(stake >= 0.35)) {
      alert("Minimum stake is $0.35");
      return;
    }

    let contractType;
    let barrier = null;

    if (type === "over") {
      contractType = "DIGITOVER";
      barrier = selectedBarrier;
      if (barrier === 9) { alert("Over 9 can never win."); return; }
    } else if (type === "under") {
      contractType = "DIGITUNDER";
      barrier = selectedBarrier;
      if (barrier === 0) { alert("Under 0 can never win."); return; }
    } else if (type === "even") {
      contractType = "DIGITEVEN";
    } else if (type === "odd") {
      contractType = "DIGITODD";
    }

    tradeLock = true;
    enableTradeButtons(false);
    pendingTrade = { type, stake, contractType, barrier };

    const req = {
      proposal: 1,
      amount: stake.toFixed(2),
      basis: "stake",
      contract_type: contractType,
      currency: activeAccount.currency,
      duration: 1,
      duration_unit: "t", // 🚨 1 tick contract
      underlying_symbol: currentMarket,
      req_id: reqId++,
    };
    if (barrier !== null) req.barrier = String(barrier);

    ws.send(JSON.stringify(req));
    tradeHint.textContent = "Requesting proposal…";
  });
});

function enableTradeButtons(enabled) {
  tradeBtns.forEach((btn) => (btn.disabled = !enabled));
}

// ---- PROPOSAL → BUY ----
function handleProposal(proposal) {
  if (!pendingTrade) return;
  ws.send(JSON.stringify({ buy: proposal.id, price: proposal.ask_price, req_id: reqId++ }));
}

function handleBuy(buy) {
  if (!pendingTrade) return;
  const trade = pendingTrade;
  pendingTrade = null;

  addResult("info", `Bought ${trade.contractType} at $${trade.stake.toFixed(2)}`, 0);
  tradeHint.textContent = "Waiting for result…";

  ws.send(JSON.stringify({
    proposal_open_contract: 1,
    contract_id: buy.contract_id,
    subscribe: 1,
    req_id: reqId++,
  }));
}

// ---- CONTRACT RESULT ----
function handleContractUpdate(contract) {
  if (!contract.is_sold) return;

  const profit = parseFloat(contract.profit) || 0;
  const entryDigit = contract.entry_tick ? parseInt(String(contract.entry_tick).slice(-1), 10) : "?";
  const exitDigit = contract.exit_tick ? parseInt(String(contract.exit_tick).slice(-1), 10) : "?";

  const type = profit > 0 ? "win" : "loss";
  const message = `Entry: ${entryDigit} · Exit: ${exitDigit} · ${profit > 0 ? "WIN" : "LOSS"}`;

  addResult(type, message, profit);

  ws.send(JSON.stringify({ forget: contract.id, req_id: reqId++ }));

  tradeLock = false;
  enableTradeButtons(true);
  tradeHint.textContent = `Last trade: ${profit > 0 ? "✅ Won" : "❌ Lost"} · Select a barrier and trade again.`;
}

// ---- LOGOUT ----
logoutBtn.addEventListener("click", () => {
  sessionStorage.removeItem("deriv_access_token");
  if (ws) ws.close();
  accessToken = null;
  activeAccount = null;
  loginScreen.style.display = "flex";
  tradingScreen.style.display = "none";
  accountInfo.style.display = "none";
  accountSwitcher.style.display = "none";
  loginBtn.style.display = "block";
  resultsLog.innerHTML = '<p class="empty-log">No trades yet. Place your first trade above.</p>';
  resultCount = 0;
  resultsCount.textContent = "0";
});

// ---- MARKET SWITCH ----
marketSelect.addEventListener("change", () => {
  currentMarket = marketSelect.value;
  currentDecimals = DECIMALS_MAP[currentMarket] || 2;
  subscribeTicks();
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