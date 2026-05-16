/* ============================================================
 * AILife — function.js
 * Loads game.json and runs the entire simulation.
 * ============================================================ */

let GAME = null;          // populated from game.json
let State = null;

/* ============ HELPERS ============ */
const pick   = arr => arr[Math.floor(Math.random() * arr.length)];
const clamp  = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const money  = n => "$" + Math.round(n).toLocaleString();

function moodLabel(v)   { if (v >= 80) return "Happy"; if (v >= 50) return "OK"; if (v >= 25) return "Sad"; return "Miserable"; }
function smartsLabel(v) { if (v >= 80) return "Very Smart"; if (v >= 50) return "Smart"; if (v >= 25) return "Average"; return "Dim"; }
function looksLabel(v)  { if (v >= 80) return "Handsome"; if (v >= 50) return "Good Looking"; if (v >= 25) return "Plain"; return "Hideous"; }

// Parse "random:LO-HI" — supports negative ranges like "-500--150"
function rollMoney(spec) {
  if (typeof spec === "number") return spec;
  if (typeof spec !== "string") return 0;
  const m = spec.match(/^random:(-?\d+)-(-?\d+)$/) || spec.match(/^random:(-?\d+)--(\d+)$/);
  if (!m) return 0;
  const lo = parseInt(m[1], 10);
  const hi = m[0].includes("--") ? -parseInt(m[2], 10) : parseInt(m[2], 10);
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

// Apply +N, -N, null, or literal value to a dotted state path
function applyStateMutation(path, val) {
  const parts = path.split(".");
  let obj = State;
  for (let i = 0; i < parts.length - 1; i++) {
    if (obj[parts[i]] == null) obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (val === null) { obj[last] = null; return; }
  if (typeof val === "string" && /^[+-]\d+/.test(val)) {
    const delta = parseInt(val, 10);
    obj[last] = (obj[last] || 0) + delta;
    return;
  }
  obj[last] = val;
}

// Replace {partner}, {age}, {job}, {money} placeholders in a string
function interpolate(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/\{partner\}/g, State.partner?.name || "my partner")
    .replace(/\{age\}/g,     String(State.age))
    .replace(/\{job\}/g,     State.job?.title || "no job")
    .replace(/\{money\}/g,   money(State.money + State.bank));
}

/* ============ SOUND SYSTEM ============ */
const SOUND_IDS = ["menu","back","choiceselect","aibutton","age","achievement","aftermath","dialog"];
const SOUNDS = {};
let _audioUnlocked = false;
let _audioVolume = 0.7;

// Cooldowns: per-sound minimum gap (ms) since last play of *that* sound, and a
// very small global cooldown that only prevents same-frame stacking. The bigger
// gaps are per-sound — clicking three options fast still plays three clicks,
// but spam-clicking the age button doesn't stack on itself.
const SOUND_COOLDOWNS = {
  dialog:       180,  // dialog open
  aftermath:    180,  // aftermath dialog
  achievement:  300,  // badge fanfare (loudest, longest)
  menu:         150,  // menu open
  back:         150,  // back button
  choiceselect: 100,  // choice click
  age:          200,  // age-up
  aibutton:     150,
};
const _lastPlayedAt = {};       // soundId -> ms timestamp
let _lastAnyPlayedAt = 0;       // global last-play timestamp
const GLOBAL_COOLDOWN_MS = 25;  // only blocks same-frame double-fires

function initSounds() {
  for (const id of SOUND_IDS) {
    const el = document.getElementById("snd-" + id);
    if (el) {
      el.volume = _audioVolume;
      SOUNDS[id] = el;
    }
  }
}

function playSound(name) {
  if (!_audioUnlocked) return;
  const el = SOUNDS[name];
  if (!el) return;
  const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  // Per-sound cooldown only — prevents the same sound from re-firing too fast
  // (e.g. spamming the age button). Different sounds can play in succession
  // (e.g. age → dialog, choiceselect → aftermath) each with their own cooldown.
  const perCd = SOUND_COOLDOWNS[name] || 100;
  if (now - (_lastPlayedAt[name] || 0) < perCd) return;
  _lastPlayedAt[name] = now;
  try {
    el.currentTime = 0;
    const p = el.play();
    if (p && p.catch) p.catch(() => {}); // silently ignore play errors
  } catch (e) { /* ignore */ }
}

// Unlock audio playback on first user gesture (browser autoplay policy)
function unlockAudio() {
  _audioUnlocked = true;
  // Touch each audio element so they're allowed to play later
  for (const id of SOUND_IDS) {
    const el = SOUNDS[id];
    if (!el) continue;
    try { el.play().then(() => el.pause()).catch(()=>{}); } catch(e) {}
    if (el) { el.currentTime = 0; }
  }
}

/* ============ STATE ============ */
function blankState() {
  const { firstNamesM, firstNamesF, lastNames, parentNames, siblingNames, countries, months } = GAME.constants;
  const gender   = Math.random() < 0.5 ? "M" : "F";
  const first    = pick(gender === "M" ? firstNamesM : firstNamesF);
  const last     = pick(lastNames);
  const month    = Math.floor(Math.random() * 12);
  const day      = Math.floor(Math.random() * 28) + 1;
  const year     = 2024 - Math.floor(Math.random() * 30) - 10;
  const country  = pick(countries);
  const fatherName = pick(parentNames);
  const motherName = pick(parentNames);
  const sibCount = Math.floor(Math.random() * 3);
  const siblings = [];
  for (let i = 0; i < sibCount; i++) {
    siblings.push({
      name: pick(siblingNames),
      gender: Math.random() < 0.5 ? "M" : "F",
      age: Math.floor(Math.random() * 6) - 3,
      level: 70 + Math.floor(Math.random() * 20),
    });
  }
  const fam = siblings.length === 0 ? "with my parents" :
              siblings.length === 1 ? `with my parents and my ${siblings[0].gender === "M" ? "brother" : "sister"}` :
                                       `with my parents and my ${siblings.every(s => s.gender === "M") ? "brothers" : siblings.every(s => s.gender === "F") ? "sisters" : "siblings"}`;

  return {
    name: `${first} ${last}`,
    firstName: first, gender, year, month, day,
    country, age: 0, alive: true,
    parents: {
      mother: { name: motherName, role: "mother", gender: "F", level: 85 },
      father: { name: fatherName, role: "father", gender: "M", level: 85 },
    },
    siblings,
    children: [],
    friends: [],
    pets: [],
    partner: null,
    job: null,
    careerHistory: [],
    education: "None",
    inSchool: false, schoolGrade: 0,
    inCollege: false, collegeYear: 0,
    inGradSchool: false, gradYear: 0,
    money: 0, bank: 0,
    investments: { stocks: 0, crypto: 0, realEstate: 0 },
    stats: { mood: 70, health: 80, smarts: Math.floor(Math.random() * 30) + 45, looks: Math.floor(Math.random() * 30) + 45 },
    criminalRecord: 0, addictions: [], badges: [],
    aiBadges: {}, // custom AI-granted badges: id -> {name, icon, desc}
    inJail: null,       // when imprisoned: { sentence, served, crime, behavior }
    illnesses: [],      // active illness ids
    hasLawyer: false,   // paid retainer (reduces sentences)
    memory: {},         // flags from past choices, set via outcome.remember
    ongoing: [],        // [{stats:{...}, yearsLeft, label}] applied every year, decremented
    recentEvents: [],   // last N branching event ids (anti-repetition)
    log: [{ age: 0, year, text: `I was born on ${months[month]} ${day}, ${year} in ${country}, ${fam}.`, kind: "normal" }],
    apiKey: localStorage.getItem("bitlife_api_key") || "",
    aiModel: localStorage.getItem("bitlife_ai_model") || "",
    aiProvider: localStorage.getItem("bitlife_ai_provider") || "anthropic",
    aiMode: localStorage.getItem("bitlife_ai_mode") === "1",
    lifeManagement: localStorage.getItem("bitlife_life_management") !== "0", // default ON
    realisticMode: localStorage.getItem("bitlife_realistic_mode") === "1",
    realisticUnit: localStorage.getItem("bitlife_realistic_unit") || "day",
    _subYearMinutes: 0,  // accumulator of sub-year time (in minutes)
    // Government documents: { issued: <age issued>, expiresAt: <age it expires>, expired: bool }
    governmentId: null,
    passport: null,
  };
}

function logEvent(text, kind = "normal") {
  State.log.push({ age: State.age, year: State.year + State.age, text: interpolate(text), kind });
}

function applyStats(e = {}) {
  for (const k of ["mood", "health", "smarts", "looks"]) {
    if (e[k] != null) {
      const before = State.stats[k];
      State.stats[k] = clamp(State.stats[k] + e[k]);
      // Track peak ONLY when the stat actually rises from gameplay (positive delta),
      // AND only from age 5+ (so toddler ambient changes never count). This prevents
      // spawn stats or baby-event nudges from instantly unlocking peak badges.
      if (e[k] > 0 && State.stats[k] > before && State.age >= 5) {
        if (!State._statPeaks) State._statPeaks = { mood:0, health:0, smarts:0, looks:0 };
        if (State.stats[k] > (State._statPeaks[k] || 0)) {
          State._statPeaks[k] = State.stats[k];
        }
      }
    }
  }
  if (e.money) {
    const m = typeof e.money === "string" ? rollMoney(e.money) : e.money;
    // Babies and toddlers (age < 5) can't actually hold money — silently ignore
    // money changes for them. Toddlers don't have wallets.
    if (State.age < 5) return;
    // Pre-adult: kids/teens (5-19) can have pocket money but their total wallet+bank
    // is capped to a small amount. Real earning power begins at 20. Negative deltas
    // always apply (so they can still spend small amounts).
    if (State.age < 20) {
      const TEEN_CAP = 500;  // total pocket money cap for under-20
      if (m >= 0) {
        const wallet = State.money + State.bank;
        const headroom = Math.max(0, TEEN_CAP - wallet);
        const allowed = Math.min(m, headroom);
        State.money += allowed;
        // Excess is silently dropped — parents put it aside or it slips through fingers
      } else {
        State.money += m;
        if (State.money < 0) {
          State.bank += State.money;
          State.money = 0;
          if (State.bank < 0) State.bank = 0;  // can't go into debt as a minor
        }
      }
      return;
    }
    if (m >= 0) State.money += m; else { State.money += m; if (State.money < 0) { State.bank += State.money; State.money = 0; } }
    // Track total ever earned for "first dollar" purposes
    if (m > 0) State._totalEarned = (State._totalEarned || 0) + m;
  }
}

function spend(amount) {
  let need = amount;
  if (State.money >= need) { State.money -= need; return true; }
  need -= State.money;
  if (State.bank >= need) { State.money = 0; State.bank -= need; return true; }
  return false;
}

function netWorth() {
  return State.bank + State.money + State.investments.stocks + State.investments.crypto + State.investments.realEstate;
}

/* ============ AUTOSAVE ============ */
const SAVE_KEY = "bitlife_save_v1";
// Schema version — bump if the State shape changes incompatibly.
const SAVE_SCHEMA = 1;

function saveGame() {
  try {
    // Only persist non-derived fields. DOM refs, function handles, etc. aren't here.
    const snapshot = {
      _schema: SAVE_SCHEMA,
      _ts: Date.now(),
      state: State,
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot));
  } catch (e) {
    console.warn("Save failed:", e);
  }
}

function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw);
    if (!snap || snap._schema !== SAVE_SCHEMA || !snap.state) return false;
    // Refresh persistent settings from localStorage so toggles never get stuck
    snap.state.apiKey         = localStorage.getItem("bitlife_api_key") || "";
    snap.state.aiModel        = localStorage.getItem("bitlife_ai_model") || "";
    snap.state.aiProvider     = localStorage.getItem("bitlife_ai_provider") || "anthropic";
    snap.state.aiMode         = localStorage.getItem("bitlife_ai_mode") === "1";
    snap.state.lifeManagement = localStorage.getItem("bitlife_life_management") !== "0";
    snap.state.realisticMode  = localStorage.getItem("bitlife_realistic_mode") === "1";
    snap.state.realisticUnit  = localStorage.getItem("bitlife_realistic_unit") || "day";
    State = snap.state;
    return true;
  } catch (e) {
    console.warn("Load failed:", e);
    return false;
  }
}

function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
}

/* ===== Manual save slots (3 slots) ===== */
const SLOT_PREFIX = "bitlife_slot_";
const NUM_SLOTS = 3;

function saveToSlot(slotNum) {
  if (slotNum < 1 || slotNum > NUM_SLOTS) return false;
  try {
    const snapshot = { _schema: SAVE_SCHEMA, _ts: Date.now(), state: State };
    localStorage.setItem(SLOT_PREFIX + slotNum, JSON.stringify(snapshot));
    return true;
  } catch (e) { console.warn("Slot save failed:", e); return false; }
}

function loadFromSlot(slotNum) {
  if (slotNum < 1 || slotNum > NUM_SLOTS) return false;
  try {
    const raw = localStorage.getItem(SLOT_PREFIX + slotNum);
    if (!raw) return false;
    const snap = JSON.parse(raw);
    if (!snap || snap._schema !== SAVE_SCHEMA || !snap.state) return false;
    // Refresh persistent settings (same logic as loadGame)
    snap.state.apiKey         = localStorage.getItem("bitlife_api_key") || "";
    snap.state.aiModel        = localStorage.getItem("bitlife_ai_model") || "";
    snap.state.aiProvider     = localStorage.getItem("bitlife_ai_provider") || "anthropic";
    snap.state.aiMode         = localStorage.getItem("bitlife_ai_mode") === "1";
    snap.state.lifeManagement = localStorage.getItem("bitlife_life_management") !== "0";
    snap.state.realisticMode  = localStorage.getItem("bitlife_realistic_mode") === "1";
    snap.state.realisticUnit  = localStorage.getItem("bitlife_realistic_unit") || "day";
    State = snap.state;
    saveGame();   // copy into auto-save slot
    return true;
  } catch (e) { console.warn("Slot load failed:", e); return false; }
}

function deleteSlot(slotNum) {
  if (slotNum < 1 || slotNum > NUM_SLOTS) return;
  try { localStorage.removeItem(SLOT_PREFIX + slotNum); } catch (e) {}
}

function slotInfo(slotNum) {
  try {
    const raw = localStorage.getItem(SLOT_PREFIX + slotNum);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || !snap.state) return null;
    const s = snap.state;
    return {
      name: s.firstName || s.name || "Unnamed",
      age: s.age,
      alive: s.alive,
      country: s.country || "?",
      savedAt: snap._ts,
    };
  } catch (e) { return null; }
}

/* ============ RENDER ============ */
const DOM = {
  entries: document.getElementById("entries"),
  statMood:   document.getElementById("stat-mood"),
  statHealth: document.getElementById("stat-health"),
  statSmarts: document.getElementById("stat-smarts"),
  statLooks:  document.getElementById("stat-looks"),
  dayBtn:     document.getElementById("dayBtn"),
  // Persona bar
  personaName:   document.getElementById("personaName"),
  personaStatus: document.getElementById("personaStatus"),
  personaMoney:  document.getElementById("personaMoney"),
  personaRight:  document.getElementById("personaRight"),
  qolValue:      document.getElementById("qolValue"),
  qolMood:       document.getElementById("qolMood"),
  qolHealth:     document.getElementById("qolHealth"),
  qolSmarts:     document.getElementById("qolSmarts"),
  qolLooks:      document.getElementById("qolLooks"),
};

function render() {
  // Life Record — show one block per age
  const byAge = {};
  for (const e of State.log) (byAge[e.age] = byAge[e.age] || []).push(e);
  const ages = Object.keys(byAge).map(Number).sort((a, b) => a - b);
  let html = "";
  for (const age of ages) {
    html += `<div class="entry"><div class="age-label">${age === 0 ? "Day 1" : `Age ${age}`}</div>`;
    for (const e of byAge[age]) {
      const cls = e.kind && e.kind !== "normal" ? ` ${e.kind}` : "";
      html += `<span class="age-text${cls}">${escapeHtml(e.text)}</span>`;
    }
    html += `</div>`;
  }
  DOM.entries.innerHTML = html;
  DOM.entries.parentElement.scrollTop = DOM.entries.parentElement.scrollHeight;

  setStat(DOM.statMood,   State.stats.mood,   `${moodLabel(State.stats.mood)} - ${State.stats.mood}%`);
  setStat(DOM.statHealth, State.stats.health, `${State.stats.health}%`);
  setStat(DOM.statSmarts, State.stats.smarts, `${smartsLabel(State.stats.smarts)} - ${State.stats.smarts}%`);
  setStat(DOM.statLooks,  State.stats.looks,  `${looksLabel(State.stats.looks)} - ${State.stats.looks}%`);

  DOM.dayBtn.disabled = !State.alive;
  // Update day-button label to reflect current advance unit (realistic mode)
  const dayLbl = DOM.dayBtn.querySelector(".lbl");
  if (dayLbl) {
    if (State.realisticMode) {
      const u = REALISTIC_UNITS[State.realisticUnit] || REALISTIC_UNITS.day;
      dayLbl.textContent = u.buttonLbl;
    } else {
      dayLbl.textContent = "Age";
    }
  }

  updatePersonaBar();
  updateActionBar();
}

// Compute a Quality of Life score (0-100) from the player's stats and life situation.
// A sincere, weighted measure: mood matters most, then health; smarts/looks contribute
// less; situation modifiers (job, partner, jail, addictions, illnesses) adjust it.
function qualityOfLife() {
  const s = State.stats;
  // Weighted base average: mood 35%, health 30%, smarts 20%, looks 15%
  let qol = (s.mood * 0.35) + (s.health * 0.30) + (s.smarts * 0.20) + (s.looks * 0.15);
  // Situation modifiers
  if (State.inJail)                       qol -= 25;
  if (State.partner)                      qol += 4;
  if (State.children.length)              qol += Math.min(State.children.length * 1.5, 5);
  if (State.friends.length >= 3)          qol += 3;
  if (State.job)                          qol += 3;
  if (State.addictions.length)            qol -= State.addictions.length * 5;
  if (State.illnesses.length)             qol -= State.illnesses.length * 3;
  if (netWorth() >= 1000000)              qol += 4;
  if (netWorth() <= -10000)               qol -= 6;
  if (!State.alive)                       qol = 0;
  return Math.max(0, Math.min(100, Math.round(qol)));
}

function qolLabel(q) {
  if (q >= 85) return "Flourishing";
  if (q >= 70) return "Thriving";
  if (q >= 55) return "Comfortable";
  if (q >= 40) return "Getting By";
  if (q >= 25) return "Struggling";
  if (q >= 10) return "In Crisis";
  return "Rock Bottom";
}

function updatePersonaBar() {
  if (!DOM.personaName) return;
  // Name + age
  const name = State.firstName || State.name || "—";
  DOM.personaName.textContent = `${name}, age ${State.age}`;

  // Career / life-stage status line
  let status;
  if (!State.alive) status = "Deceased";
  else if (State.inJail) status = `Incarcerated (year ${State.inJail.served + 1} of ${State.inJail.sentence})`;
  else if (State.age < 5) status = "Baby";
  else if (State.inSchool && State.age < 12) status = "Elementary student";
  else if (State.inSchool && State.age < 14) status = "Middle school student";
  else if (State.inSchool && State.age < 19) status = "High school student";
  else if (State.inCollege) status = "College student";
  else if (State.job) status = `${State.job.title} — ${money(State.job.salary)}/yr`;
  else if (State.age >= 65) status = "Retired";
  else if (State.age >= 18) status = "Unemployed";
  else status = "Student";
  DOM.personaStatus.textContent = status;

  // Money on the right (use net worth for the persona total).
  // Babies (age < 5) don't have money — show a small "♡" anchor for QoL instead.
  const showMoney = State.age >= 5;
  if (showMoney) {
    const nw = netWorth();
    DOM.personaMoney.textContent = money(nw);
    DOM.personaMoney.classList.toggle("negative", nw < 0);
    DOM.personaMoney.classList.remove("baby-anchor");
  } else {
    DOM.personaMoney.textContent = "♡";
    DOM.personaMoney.classList.remove("negative");
    DOM.personaMoney.classList.add("baby-anchor");
  }
  DOM.personaMoney.style.display = "";

  // QoL tooltip — always available (parents care about mood/health from day 1)
  const q = qualityOfLife();
  const lbl = qolLabel(q);
  DOM.qolValue.textContent = `${lbl} (${q})`;
  DOM.qolMood.textContent   = `${State.stats.mood}`;
  DOM.qolHealth.textContent = `${State.stats.health}`;
  DOM.qolSmarts.textContent = `${State.stats.smarts}`;
  DOM.qolLooks.textContent  = `${State.stats.looks}`;
}

// Swap the action bar between modes. The Job slot becomes:
//   - "Jail"       if in jail
//   - "University" if enrolled in college
//   - "School"     if in primary/secondary school
//   - "Job"        otherwise
function updateActionBar() {
  const jobBtn = document.querySelector('.action[data-open="job"], .action[data-open="jail"], .action[data-open="school"]');
  if (!jobBtn) return;
  const lbl = jobBtn.querySelector(".lbl");
  const ico = jobBtn.querySelector(".ico");

  if (State.inJail) {
    jobBtn.dataset.open = "jail";
    if (lbl) lbl.textContent = "Jail";
    if (ico) ico.innerHTML = '<i data-lucide="fence"></i>';
    document.body.classList.add("in-jail");
  } else if (State.inCollege) {
    jobBtn.dataset.open = "school";
    if (lbl) lbl.textContent = "University";
    if (ico) ico.innerHTML = '<i data-lucide="graduation-cap"></i>';
    document.body.classList.remove("in-jail");
  } else if (State.inSchool) {
    jobBtn.dataset.open = "school";
    if (lbl) lbl.textContent = "School";
    if (ico) ico.innerHTML = '<i data-lucide="backpack"></i>';
    document.body.classList.remove("in-jail");
  } else {
    jobBtn.dataset.open = "job";
    if (lbl) lbl.textContent = "Job";
    if (ico) ico.innerHTML = '<i data-lucide="briefcase"></i>';
    document.body.classList.remove("in-jail");
  }
  if (window.lucide) lucide.createIcons();
}

function setStat(el, val, label) {
  val = clamp(Math.round(val));
  el.style.width = val + "%";
  el.textContent = val > 0 ? label : "";
  el.classList.remove("mid", "low");
  if (val < 30) el.classList.add("low");
  else if (val < 60) el.classList.add("mid");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ============ SUBVIEW ============ */
const SUBVIEW = {
  el: document.getElementById("subview"),
  title: document.getElementById("subviewTitle"),
  body: document.getElementById("subviewBody"),
};
// Back stack: when a subview is opened on top of another, the back button
// returns to the previous one instead of closing.
let _subviewBackStack = [];
function showSubview(title, builder, opts) {
  playSound("menu");
  if (!opts || !opts.preserveStack) _subviewBackStack = [];
  SUBVIEW.title.textContent = title;
  SUBVIEW.body.innerHTML = "";
  builder(SUBVIEW.body);
  SUBVIEW.el.classList.add("show");
  SUBVIEW.body.scrollTop = 0;
  if (window.lucide) lucide.createIcons();
}
function pushSubview(title, builder, parentFn) {
  _subviewBackStack.push(parentFn);
  showSubview(title, builder, { preserveStack: true });
}
function closeSubview() {
  playSound("back");
  if (_subviewBackStack.length > 0) {
    const parent = _subviewBackStack.pop();
    parent();
    return;
  }
  SUBVIEW.el.classList.remove("show");
}

/* ============ DIALOG ============ */
const DLG = {
  overlay: document.getElementById("dialogOverlay"),
  dialog:  document.getElementById("dialog"),
  header:  document.getElementById("dialogHeader"),
  body:    document.getElementById("dialogBody"),
  hint:    document.getElementById("dialogHint"),
};
let aftermathHandler = null;

function closeDialog() {
  DLG.overlay.classList.remove("show", "aftermath");
  DLG.hint.style.display = "none";
  if (aftermathHandler) {
    DLG.overlay.removeEventListener("click", aftermathHandler);
    aftermathHandler = null;
  }
  // After every dialog dismissal, see if a badge was earned.
  setTimeout(chainBadges, 30);
}

// AFTERMATH — text only, click anywhere to dismiss.
// opts = function | { onClose, enjoyment, badge }
function showAftermath(title, text, opts) {
  if (typeof opts === "function") opts = { onClose: opts };
  opts = opts || {};

  // Achievement badges have their own sound, regular aftermath uses aftermath.wav.
  // Slight delay so it doesn't stack on top of the choice-select click that
  // typically immediately precedes it.
  const sound = (opts && opts.badge) ? "achievement" : "aftermath";
  setTimeout(() => playSound(sound), 140);

  DLG.header.textContent = interpolate(title);
  DLG.body.innerHTML = "";

  if (opts.badge) {
    const wrap = document.createElement("div");
    wrap.className = "badge-display";
    wrap.innerHTML = `
      <div class="badge-icon-big"><i data-lucide="${opts.badge.icon}"></i></div>
      <div class="badge-name-big">${opts.badge.name}</div>
      <div class="badge-desc-big">${opts.badge.desc}</div>`;
    DLG.body.appendChild(wrap);
  }

  if (text) {
    const p = document.createElement("div");
    p.className = "narration";
    p.textContent = interpolate(text);
    DLG.body.appendChild(p);
  }

  // Inset info box — e.g. "Reason: Bad grades", "Sentence: 5 years"
  if (opts.info && Array.isArray(opts.info) && opts.info.length) {
    const box = document.createElement("div");
    box.className = "info-box";
    for (const item of opts.info) {
      if (!item) continue;
      const row = document.createElement("div");
      row.className = "info-line";
      row.innerHTML = `<span class="info-label">${interpolate(String(item.label || ""))}</span><span class="info-value">${interpolate(String(item.value || ""))}</span>`;
      box.appendChild(row);
    }
    DLG.body.appendChild(box);
  }

  if (typeof opts.enjoyment === "number") {
    const v = clamp(Math.round(opts.enjoyment));
    const cls = v < 30 ? "low" : v < 60 ? "mid" : "";
    const block = document.createElement("div");
    block.className = "enjoyment-block";
    block.innerHTML = `
      <div class="enjoyment-label">Enjoyment</div>
      <div class="enjoyment-bar"><div class="enjoyment-fill ${cls}">${v}%</div></div>`;
    DLG.body.appendChild(block);
    requestAnimationFrame(() => { block.querySelector(".enjoyment-fill").style.width = v + "%"; });
  }

  DLG.hint.style.display = "block";
  DLG.overlay.classList.add("show", "aftermath");
  if (window.lucide) lucide.createIcons();

  aftermathHandler = () => {
    closeDialog();
    if (opts.onClose) opts.onClose();
    render();
  };
  setTimeout(() => DLG.overlay.addEventListener("click", aftermathHandler), 50);
}

// OPTIONS — green stacked buttons + Custom Choice (AI)
function showOptions(title, question, choices, aiContext, info) {
  playSound("dialog");
  DLG.header.textContent = interpolate(title);
  DLG.body.innerHTML = "";
  DLG.hint.style.display = "none";

  const q = document.createElement("div");
  q.className = "narration";
  q.textContent = interpolate(question);
  DLG.body.appendChild(q);

  if (info && Array.isArray(info) && info.length) {
    const box = document.createElement("div");
    box.className = "info-box";
    for (const item of info) {
      if (!item) continue;
      const row = document.createElement("div");
      row.className = "info-line";
      row.innerHTML = `<span class="info-label">${interpolate(String(item.label || ""))}</span><span class="info-value">${interpolate(String(item.value || ""))}</span>`;
      box.appendChild(row);
    }
    DLG.body.appendChild(box);
  }

  for (const c of choices) {
    const b = document.createElement("button");
    b.className = "dlg-btn";
    b.textContent = interpolate(c.label);
    b.onclick = () => {
      playSound("choiceselect");
      closeDialog();
      try { c.run(); } catch (err) { console.error(err); }
      render();
    };
    DLG.body.appendChild(b);
  }

  // Always show Custom Choice (AI) — context falls back to the dialog title+body
  appendAICustomChoice(aiContext, title, question);
  DLG.overlay.classList.add("show");
  if (window.lucide) lucide.createIcons();
}

// PILLS — light-blue text-aligned choices + Custom Choice (AI)
function showPills(title, question, choices, aiContext, info) {
  playSound("dialog");
  DLG.header.textContent = interpolate(title);
  DLG.body.innerHTML = "";
  DLG.hint.style.display = "none";

  const q = document.createElement("div");
  q.className = "dlg-question";
  q.textContent = interpolate(question);
  DLG.body.appendChild(q);

  if (info && Array.isArray(info) && info.length) {
    const box = document.createElement("div");
    box.className = "info-box";
    for (const item of info) {
      if (!item) continue;
      const row = document.createElement("div");
      row.className = "info-line";
      row.innerHTML = `<span class="info-label">${interpolate(String(item.label || ""))}</span><span class="info-value">${interpolate(String(item.value || ""))}</span>`;
      box.appendChild(row);
    }
    DLG.body.appendChild(box);
  }

  for (const c of choices) {
    const b = document.createElement("button");
    b.className = "dlg-pill";
    b.textContent = interpolate(c.label);
    b.onclick = () => {
      playSound("choiceselect");
      closeDialog();
      try { c.run(); } catch (err) { console.error(err); }
      render();
    };
    DLG.body.appendChild(b);
  }

  appendAICustomChoice(aiContext, title, question);
  DLG.overlay.classList.add("show");
  if (window.lucide) lucide.createIcons();
}

function appendAICustomChoice(aiContext, fallbackTitle, fallbackQuestion) {
  // Pick the prompt/context: explicit aiContext wins, otherwise use the dialog itself
  const ctx = aiContext || {
    prompt: fallbackQuestion || fallbackTitle || "What would you like to do?",
    contextLabel: (fallbackTitle || "decision").toLowerCase().replace(/\s+/g, "_"),
  };
  const btn = document.createElement("button");
  btn.className = "dlg-ai-btn" + (State.apiKey ? "" : " disabled");
  btn.innerHTML = `<i data-lucide="sparkles"></i><span>Custom Choice (AI)</span>`;
  btn.onclick = () => {
    playSound("aibutton");
    if (!State.apiKey) {
      showAftermath("AI Locked", "Add an API key in the Menu to use Custom Choice (AI).");
      return;
    }
    askAICustomAction(ctx.prompt, ctx.contextLabel);
  };
  DLG.body.appendChild(btn);
}

/* ============ DROPDOWNS ============
 * A form-style dialog with one or more <select> fields.
 *
 * Spec:
 *   {
 *     title, body,
 *     selects: [
 *       { name, label, options:[...], from:"countries", limit:5 }
 *     ],
 *     submitLabel,
 *     outcome,    // executed when submitted, with {name} placeholders filled in
 *     aiContext
 *   }
 *
 * If `from` is set, options pull from GAME.constants[from].
 * If `limit` is set, a random subset of that size is shown each time.
 * Selected values become {name} placeholders inside outcome strings.
 */
function showDropdowns(spec) {
  DLG.header.textContent = interpolate(spec.title || "Choose");
  DLG.body.innerHTML = "";
  DLG.hint.style.display = "none";

  if (spec.body) {
    const q = document.createElement("div");
    q.className = "dlg-question";
    q.textContent = interpolate(spec.body);
    DLG.body.appendChild(q);
  }

  const selectEls = {};
  for (const sel of spec.selects || []) {
    const wrap = document.createElement("div");
    wrap.className = "dlg-dropdown-row";

    const label = document.createElement("div");
    label.className = "dlg-dropdown-label";
    label.textContent = sel.label || sel.name;
    wrap.appendChild(label);

    let opts = sel.options;
    if (sel.from && GAME.constants[sel.from]) opts = GAME.constants[sel.from];
    if (!Array.isArray(opts)) opts = [];

    // Random subset if limit is set
    const shuffled = opts.slice().sort(() => Math.random() - 0.5);
    const limited  = sel.limit ? shuffled.slice(0, sel.limit) : shuffled;

    const select = document.createElement("select");
    select.className = "dlg-dropdown";
    for (const o of limited) {
      const optEl = document.createElement("option");
      optEl.value = o;
      optEl.textContent = o;
      select.appendChild(optEl);
    }
    wrap.appendChild(select);
    DLG.body.appendChild(wrap);
    selectEls[sel.name] = select;
  }

  const btn = document.createElement("button");
  btn.className = "dlg-btn";
  btn.textContent = spec.submitLabel || "Confirm";
  btn.onclick = () => {
    const vars = {};
    for (const [name, el] of Object.entries(selectEls)) vars[name] = el.value;
    closeDialog();
    executeOutcomeWithVars(spec.outcome, vars);
    render();
  };
  DLG.body.appendChild(btn);

  appendAICustomChoice(spec.aiContext, spec.title, spec.body);
  DLG.overlay.classList.add("show");
  if (window.lucide) lucide.createIcons();
}

// Substitute {name} placeholders throughout an outcome tree, then execute it.
// This lets dropdown selections flow into nested log/aftermath text and even
// into deeper sub-dialogs.
function executeOutcomeWithVars(outcome, vars) {
  if (!outcome) return;
  const sub = (s) => {
    if (typeof s !== "string") return s;
    let r = s;
    for (const [k, v] of Object.entries(vars)) {
      r = r.replace(new RegExp("\\{" + k + "\\}", "g"), v);
    }
    return r;
  };
  function walk(obj) {
    if (typeof obj === "string") return sub(obj);
    if (Array.isArray(obj)) return obj.map(walk);
    if (obj && typeof obj === "object") {
      const r = {};
      for (const [k, v] of Object.entries(obj)) r[k] = walk(v);
      return r;
    }
    return obj;
  }
  executeOutcome(walk(outcome));
}

/* ============ BADGES ============ */
function badgeEarned(id) {
  const s = State;
  const m = s.memory || {};
  const logHas = (re) => s.log.some(e => (typeof re === "string" ? e.text.includes(re) : re.test(e.text)));

  // Stat-peak helper: stats can only earn their max-stat badge if they were ACTUALLY
  // *raised* by a gameplay event, not just inherited from spawn. We track this via
  // _statPeaks which records when each stat first crossed key thresholds during play.
  const peakEarned = (stat, threshold) =>
    (s._statPeaks && s._statPeaks[stat] && s._statPeaks[stat] >= threshold);

  switch (id) {
    // --- Original badges ---
    case "college":     return s.education && s.education.includes("College graduate");
    case "postgrad":    return s.education === "Postgraduate";
    case "married":     return s.age >= 18 && s.partner && s.partner.married && (s._yearsMarried || 0) >= 1;
    case "parent":      return s.age >= 18 && s.children.length > 0;
    case "homeowner":   return s.age >= 20 && s.investments.realEstate >= 100000;
    case "millionaire": return s.age >= 22 && netWorth() >= 1000000;
    case "genius":      return s.age >= 21 && peakEarned("smarts", 95);
    case "fit":         return s.age >= 21 && peakEarned("health", 95);
    case "stunning":    return s.age >= 21 && peakEarned("looks", 95);
    case "petowner":    return s.age >= 6 && s.pets.length > 0 && (s._petYears || 0) >= 1;
    case "social":      return s.age >= 16 && s.friends.length >= 12;
    case "outlaw":      return s.criminalRecord > 0;
    case "boss":        return s.age >= 28 && s.job && s.job.level >= 5;
    case "jackpot":     return logHas("WON THE LOTTERY");
    case "centenarian": return s.age >= 100;
    case "tiktoker":    return s.age >= 13 && logHas(/tiktok/i) && (s._socialPosts || 0) >= 50;
    case "traveler":    return s.age >= 16 && (s.countriesVisited || 0) >= 3;
    case "artist":      return s.age >= 18 && (m.published_book || m.published_painting || m.gallery_show);
    case "foodie":      return s.age >= 25 && logHas(/gourmet/i) && (s._foodieSpend || 0) >= 2000;
    case "gamer":       return s.age >= 13 && logHas(/video games?/i) && (s._gamerYears || 0) >= 5;

    // --- Stat peak / "earned-by-play" badges ---
    case "prodigy":         return s.age >= 7 && s.age < 10 && peakEarned("smarts", 92) && (m.early_smart_milestone || m.gifted_program);
    case "valedictorian":   return s.age >= 18 && m.high_sat && m.dream_college;
    case "explorer":        return s.age >= 21 && (s.countriesVisited || 0) >= 8;
    case "globetrotter":    return s.age >= 25 && (m.moved_abroad || (s.countriesVisited || 0) >= 15);
    case "published":       return s.age >= 18 && (m.published_book || m.published_article);
    case "viral":           return s.age >= 13 && m.went_viral;
    case "war_hero":        return s.age >= 21 && (m.war_hero || m.decorated_veteran);
    case "olympic":         return s.age >= 18 && m.olympic_athlete;
    case "survivor":        return s.age >= 21 && (m.cancer_survivor || m.near_death);
    case "sober":           return s.age >= 21 && (s._everAddicted && s.addictions.length === 0 && (s._sobrietyYears || 0) >= 5);
    case "adopted":         return s.age >= 25 && s.children.some(c => c.adopted);
    case "orphan":          return s.parents && !s.parents.mother && !s.parents.father && s.age < 18;
    case "divorced":        return s.age >= 22 && m.was_divorced;
    case "widowed":         return s.age >= 35 && (m.was_widowed || (s.partner && s.partner.deceased));
    case "polyglot":        return s.age >= 25 && (s.languages || []).length >= 5;
    case "philanthropist":  return s.age >= 30 && (s.charitableGiving || 0) >= 1000000;
    case "inventor":        return s.age >= 25 && m.has_patent;
    case "convicted":       return s.criminalRecord >= 1;
    case "escaped":         return m.jail_escape;
    case "rich":            return s.age >= 30 && netWorth() >= 10000000;
    case "billionaire":     return s.age >= 35 && netWorth() >= 1000000000;
    case "famous":          return s.age >= 18 && (m.famous || (s.fame || 0) >= 95);
    case "hated":           return s.age >= 21 && (m.hated || ((s.fame || 0) >= 90 && s.stats.mood < 15));
    case "grandparent":     return s.age >= 45 && s.children.some(c => (c.children || []).length > 0);
    case "hero":            return s.age >= 15 && m.saved_a_life;
    case "firefighter":     return s.age >= 25 && s.careerHistory && s.careerHistory.some(j => /fire/i.test(j.track || j.title || "")) && (s._yearsInFireService || 0) >= 10;
    case "chef_award":      return s.age >= 25 && m.chef_award;
    case "hacker":          return s.age >= 18 && m.major_hack;
    case "black_belt":      return s.age >= 16 && m.black_belt;

    // --- Brand new specific badges ---
    case "first_friend":    return s.age >= 5 && s.friends.length >= 1 && m.first_real_friend;
    case "first_kiss_b":    return m.first_kiss || m.first_kiss_kid;
    case "first_love":      return m.first_real_love;
    case "heartbroken":     return m.public_rejection || m.brutal_breakup;
    case "high_school_grad":return m.grad_celebration || m.cried_at_graduation;
    case "dropout":         return m.academic_dropout_teen || m.dropped_out;
    case "einstein":        return s.age >= 18 && peakEarned("smarts", 100);
    case "adonis":          return s.age >= 18 && peakEarned("looks", 100);
    case "ironclad":        return s.age >= 18 && peakEarned("health", 100);
    case "euphoria":        return s.age >= 18 && peakEarned("mood", 100) && (s._euphoriaYears || 0) >= 2;
    case "depths":          return s.age >= 13 && s.stats.mood <= 0 && (s._lowMoodYears || 0) >= 1;
    case "first_dollar":    return s.age >= 12 && (s._firstPaycheck === true || (s._totalEarned || 0) >= 100);
    case "thousandaire":    return s.age >= 14 && netWorth() >= 1000;
    case "in_debt":         return s.age >= 18 && netWorth() <= -10000;
    case "comeback":        return s.age >= 25 && m.was_broke && netWorth() >= 5000000;
    case "big_family":      return s.age >= 25 && s.children.length >= 3;
    case "only_child":      return s.age >= 35 && s.children.length === 0 && !s.partner;
    case "sandwich":        return s.children.length > 0 && (s.parents && (s.parents.mother || s.parents.father)) && s.children.some(c => c.age != null && c.age < 18) && s.age >= 35;
    case "promoted_fast":   return s.age < 30 && s.age >= 22 && s.job && s.job.level >= 3;
    case "job_hopper":      return s.age >= 30 && (s.careerHistory || []).length >= 7;
    case "lifer":           return s.age >= 50 && s.job && (s._yearsInJob || 0) >= 30;
    case "retired_rich":    return s.age >= 65 && netWorth() >= 5000000;
    case "daredevil":       return s.age >= 18 && (s._riskyCount || 0) >= 12;
    case "jailbird":        return m.jail_time || (s.inJail && s.inJail.served >= 1);
    case "repeat_offender": return s.criminalRecord >= 7;
    case "pet_parent":      return s.age >= 25 && (s._petsOwned || s.pets.length) >= 7;
    case "menagerie":       return s.age >= 25 && s.pets.length >= 9;
    case "chronic":         return s.age >= 40 && s.illnesses.length >= 6;
    case "survivor_v2":     return m.cancer_survivor;
    case "clean_living":    return s.age >= 85 && s.illnesses.length === 0 && s.addictions.length === 0 && !s._everAddicted;
    case "omg":             return s.log.length >= 500;
    case "speedrun":        return !s.alive && s.age < 25;
    case "long_life":       return s.age >= 95;
    case "first_addiction": return s.age >= 16 && (s._everAddicted || s.addictions.length > 0);
    case "multi_addicted":  return s.age >= 18 && s.addictions.length >= 4;
    case "badge_collector": return s.age >= 30 && s.badges.length >= 40;
  }
  return false;
}
function chainBadges() {
  for (const b of GAME.badges) {
    if (State.badges.includes(b.id)) continue;
    if (badgeEarned(b.id)) {
      State.badges.push(b.id);
      logEvent(`🏆 Badge unlocked: ${b.name}.`, "good");
      showAftermath("Badge Unlocked!", "", { badge: b });
      return;
    }
  }
}

// Resolve a badge id to its metadata (preset OR AI-granted)
function badgeMeta(id) {
  return GAME.badges.find(b => b.id === id) || State.aiBadges[id] || null;
}

/* ============ OUTCOME ENGINE ============
 * Outcome schema (from game.json):
 *   { log, logKind, stats, money, state, aftermath:{title,text}, pills:{...}, branch:[...], special }
 * If a "branch" array is present, roll it. Entries with `chance` roll first;
 * the last entry without `chance` is the fallback.
 * After applying, if there's no aftermath, no dialog is shown — bitlife-style silent.
 */
/* Returns true if the outcome has enough impact to warrant a visible
 * aftermath dialog when none was explicitly provided. Trivial outcomes
 * (silent logs, tiny stat ticks) stay silent.
 */
function shouldAutoAftermath(o) {
  if (!o || !o.log) return false;
  if (o.logKind === "good" || o.logKind === "bad") return true;
  if (o.special) return true;
  if (o.illness) return true;
  if (o.state) return true;
  if (typeof o.money === "number" && Math.abs(o.money) >= 100) return true;
  if (typeof o.money === "string" && /random:/.test(o.money)) return true;
  if (o.stats) {
    for (const v of Object.values(o.stats)) {
      if (typeof v === "number" && Math.abs(v) >= 5) return true;
    }
  }
  return false;
}

// Pick a contextual title from the outcome's log kind.
function autoAftermathTitle(o) {
  if (o.logKind === "good") return "Good Outcome";
  if (o.logKind === "bad")  return "Bad Outcome";
  if (o.illness)            return "Diagnosed";
  if (o.special === "addChild") return "Baby";
  if (o.special === "newPartner") return "New Partner";
  if (o.special === "raiseSalary") return "Raise";
  if (typeof o.money === "number" && o.money >= 1000) return "Cashed In";
  if (typeof o.money === "number" && o.money <= -1000) return "Big Hit";
  if (typeof o.money === "number" && o.money > 0) return "Money In";
  if (typeof o.money === "number" && o.money < 0) return "Money Out";
  return "Result";
}

// Build an info-box from the outcome's concrete facts: money delta, jail
// sentence, illness diagnosed, big stat shifts. Only adds the lines that
// actually apply, so the box stays terse.
function autoAftermathInfo(o) {
  const info = [];
  if (typeof o.money === "number" && o.money !== 0) {
    const sign = o.money > 0 ? "+" : "-";
    info.push({ label: "Money", value: sign + "$" + Math.abs(o.money).toLocaleString() });
  }
  if (typeof o.money === "string" && /random:/.test(o.money)) {
    info.push({ label: "Money", value: "varies" });
  }
  if (o.jail) {
    info.push({ label: "Sentence", value: o.jail + " year" + (o.jail > 1 ? "s" : "") });
    if (o.jailCrime) info.push({ label: "Crime", value: o.jailCrime });
  }
  if (o.illness) {
    const id = (typeof o.illness === "string") ? o.illness : "";
    const meta = id ? illnessMeta(id) : null;
    info.push({ label: "Diagnosis", value: meta ? meta.name : (id || "Unknown") });
  }
  if (o.special === "addChild")     info.push({ label: "Family", value: "New child" });
  if (o.special === "newPartner")   info.push({ label: "Relationship", value: "New partner" });
  if (o.special === "raiseSalary")  info.push({ label: "Career", value: "Salary +50%" });
  if (o.special === "acceptPromo")  info.push({ label: "Career", value: "Promoted" });
  if (o.special === "acceptPromoBig") info.push({ label: "Career", value: "Big promotion" });
  if (o.special === "addFriend")    info.push({ label: "Social", value: "New friend" });

  if (o.stats) {
    if (typeof o.stats.health === "number" && Math.abs(o.stats.health) >= 10) {
      info.push({ label: "Health", value: (o.stats.health > 0 ? "+" : "") + o.stats.health });
    }
    if (typeof o.stats.mood === "number" && Math.abs(o.stats.mood) >= 10) {
      info.push({ label: "Mood", value: (o.stats.mood > 0 ? "+" : "") + o.stats.mood });
    }
  }
  return info;
}

function executeOutcome(outcome) {
  if (!outcome) return;

  // Realistic-mode unit picker: just set the unit and bail (no side effects)
  if (outcome._setUnit && REALISTIC_UNITS[outcome._setUnit]) {
    State.realisticUnit = outcome._setUnit;
    localStorage.setItem("bitlife_realistic_unit", outcome._setUnit);
    closeDialog();
    render();
    return;
  }

  // College major picker — set major and bail
  if (outcome._setMajor) {
    State.collegeMajor = outcome._setMajor;
    State.stats.mood = clamp(State.stats.mood + 2);
    logEvent(`I declared ${outcome._setMajor} as my major.`, "good");
    closeDialog();
    render();
    return;
  }

  // Branch resolution: pick the first matching chance, otherwise the fallback
  if (Array.isArray(outcome.branch)) {
    let chosen = null;
    for (const b of outcome.branch) {
      if (typeof b.chance === "number") {
        if (Math.random() < b.chance) { chosen = b; break; }
      }
    }
    if (!chosen) chosen = outcome.branch.find(b => typeof b.chance !== "number") || outcome.branch[outcome.branch.length - 1];
    return executeOutcome(chosen);
  }

  // Sub-dialog: options (green stacked buttons)
  if (outcome.options && Array.isArray(outcome.options.choices)) {
    const o = outcome.options;
    showOptions(o.title, o.body || o.question || "",
      o.choices.map(c => ({ label: c.label, run: () => executeOutcome(c.outcome) })),
      o.aiContext, o.info);
    return;
  }

  // Sub-dialog: pills (light-blue choices)
  if (outcome.pills && Array.isArray(outcome.pills.choices)) {
    const p = outcome.pills;
    showPills(p.title, p.question || p.body || "",
      p.choices.map(c => ({ label: c.label, run: () => executeOutcome(c.outcome) })),
      p.aiContext, p.info);
    return;
  }

  // Sub-dialog: dropdowns (Hit + Location, Migration destination, etc.)
  if (outcome.dropdowns) {
    showDropdowns(outcome.dropdowns);
    return;
  }

  // Pre-snapshot the aftermath BEFORE state mutations so {partner}/{job}/etc.
  // resolve using the values that existed at choice-time, not after they're cleared.
  let aftermathSnap = null;
  if (outcome.aftermath) {
    aftermathSnap = {
      title: interpolate(outcome.aftermath.title || "Aftermath"),
      text:  interpolate(outcome.aftermath.text  || ""),
      info:  (outcome.aftermath.info || []).concat(autoAftermathInfo(outcome)),
    };
  } else if (shouldAutoAftermath(outcome)) {
    // No explicit aftermath, but the outcome is meaningful — auto-generate one
    // from the log text so the player gets visible feedback.
    aftermathSnap = {
      title: autoAftermathTitle(outcome),
      text:  interpolate(outcome.log || "Done."),
      info:  autoAftermathInfo(outcome),
    };
  }

  // Log entry
  if (outcome.log) logEvent(outcome.log, outcome.logKind || "normal");

  // Stat / money / state changes
  if (outcome.stats) applyStats(outcome.stats);
  if (outcome.money != null) applyStats({ money: outcome.money });
  if (outcome.state) {
    for (const [path, val] of Object.entries(outcome.state)) {
      applyStateMutation(path, val);
    }
  }

  // Special hooks
  if (outcome.special) handleOutcomeSpecial(outcome.special);

  // Memory: persist flags for future events to reference
  if (outcome.remember) {
    const flags = Array.isArray(outcome.remember) ? outcome.remember : [outcome.remember];
    for (const f of flags) State.memory[f] = true;
  }
  if (outcome.forget) {
    const flags = Array.isArray(outcome.forget) ? outcome.forget : [outcome.forget];
    for (const f of flags) delete State.memory[f];
  }

  // Ongoing yearly effects: { stats:{mood:-2}, years:5, label:"Grieving" }
  if (outcome.ongoingEffect) {
    State.ongoing = State.ongoing || [];
    const eff = outcome.ongoingEffect;
    State.ongoing.push({
      stats: eff.stats || {},
      yearsLeft: eff.years || 3,
      label: eff.label || "Lingering effect",
    });
  }

  // Jail / legal effects
  if (outcome.jail) {
    goToJail(outcome.jail, outcome.jailCrime || outcome.crime);
    return; // jail aftermath replaces any normal aftermath
  }
  if (outcome.jailExtend && State.inJail) {
    State.inJail.sentence += outcome.jailExtend;
  }
  if (outcome.jailRelease && State.inJail) {
    releaseFromJail();
    return;
  }

  // Sickness
  if (outcome.illness) {
    addIllness(outcome.illness);
  }
  if (outcome.cureIllness) {
    State.illnesses = State.illnesses.filter(i => i !== outcome.cureIllness);
  }

  // Aftermath dialog — only if specified (use pre-interpolated snapshot)
  if (aftermathSnap) {
    showAftermath(aftermathSnap.title, aftermathSnap.text, { info: aftermathSnap.info });
  }
}

function handleOutcomeSpecial(spec) {
  if (spec === "acceptPromo")    { if (State.job) { State.job.salary = Math.round(State.job.salary * 1.25); } return; }
  if (spec === "acceptPromoBig") { if (State.job) { State.job.salary = Math.round(State.job.salary * 1.45); } return; }
  if (spec === "raiseSalary")    { if (State.job) { State.job.salary = Math.round(State.job.salary * 1.5);  } return; }
  // Government documents
  if (spec === "issueId")        { issueDocument("id"); return; }
  if (spec === "issuePassport")  { issueDocument("passport"); return; }
  if (spec === "renewId")        { renewDocument("governmentId"); return; }
  if (spec === "renewPassport")  { renewDocument("passport"); return; }
  if (spec === "newPartner")     { createPartner(); return; }
  if (spec === "addChild" || spec === "newChild") { addChild(); return; }
  if (spec.startsWith("addPet:")) {
    const kind = spec.split(":")[1];
    State.pets.push({ name: pick(GAME.constants.petNames), kind, level: 85 });
    return;
  }
  // --- New specials for expanded events ---
  if (spec === "friend" || spec === "addFriend") {
    if (!State.friends) State.friends = [];
    const g = Math.random() < 0.5 ? "M" : "F";
    const name = pick(g === "M" ? GAME.constants.firstNamesM : GAME.constants.firstNamesF);
    State.friends.push({ name, gender: g, level: 70 });
    return;
  }
  if (spec === "engaged") {
    if (State.partner) State.partner.married = false; // engaged but not married yet
    State.memory = State.memory || {};
    State.memory.engaged = true;
    return;
  }
  if (spec === "newSibling") {
    if (!State.siblings) State.siblings = [];
    const g = Math.random() < 0.5 ? "M" : "F";
    const name = pick(g === "M" ? GAME.constants.firstNamesM : GAME.constants.firstNamesF);
    State.siblings.push({ name, gender: g, age: 0, level: 80 });
    return;
  }
  if (spec === "bondGrandparent") {
    // Boost parent (and indirectly grandparent) bond slightly
    if (State.parents) for (const p of State.parents) { if (p.level !== undefined) p.level = Math.min(100, p.level + 5); }
    return;
  }
  // Badge grants
  if (spec.startsWith("badge_")) {
    const id = spec.slice(6);
    if (!State.badges.includes(id)) {
      State.badges.push(id);
      const b = badgeMeta(id);
      if (b) {
        logEvent(`🏆 Badge unlocked: ${b.name}.`, "good");
        showAftermath("Badge Unlocked!", "", { badge: b });
      }
    }
    return;
  }
  // Addiction injections from events — add to State.addictions array if not present
  if (spec === "addiction_alcohol") {
    if (!Array.isArray(State.addictions)) State.addictions = [];
    if (!State.addictions.includes("alcohol")) {
      State.addictions.push("alcohol");
      State._everAddicted = true;
      logEvent("That experience left me hooked on alcohol.", "bad");
    }
    return;
  }
  if (spec === "addiction_drugs") {
    if (!Array.isArray(State.addictions)) State.addictions = [];
    if (!State.addictions.includes("drugs")) {
      State.addictions.push("drugs");
      State._everAddicted = true;
      logEvent("That experience left me hooked on drugs.", "bad");
    }
    return;
  }
  if (spec === "addiction_smoking") {
    if (!Array.isArray(State.addictions)) State.addictions = [];
    if (!State.addictions.includes("smoking")) {
      State.addictions.push("smoking");
      State._everAddicted = true;
      logEvent("That experience left me hooked on smoking.", "bad");
    }
    return;
  }
  if (spec === "vapeStart") {
    if (!Array.isArray(State.addictions)) State.addictions = [];
    if (!State.addictions.includes("vape")) {
      State.addictions.push("vape");
      logEvent("I started vaping — and now I can't stop.", "bad");
    }
    return;
  }
  if (spec === "caffeinePills") {
    applyStats({ mood: 1, health: -2 });
    if (!Array.isArray(State.addictions)) State.addictions = [];
    if (Math.random() < 0.4 && !State.addictions.includes("caffeine")) {
      State.addictions.push("caffeine");
      logEvent("I'm dependent on caffeine pills now.", "bad");
    }
    return;
  }
  // Illness specials
  if (spec === "illness_alzheimers") {
    addIllness("alzheimers");
    return;
  }
  // Small risky-activity outcomes (just stats)
  if (spec === "cheatTest") {
    if (Math.random() < 0.5) {
      applyStats({ smarts: 2, mood: 1 });
      logEvent("I cheated on a test and got away with it.", "bad");
    } else {
      applyStats({ smarts: -3, mood: -4 });
      logEvent("I cheated on a test and got caught.", "bad");
      State.memory = State.memory || {}; State.memory.cheated_caught = true;
    }
    return;
  }
  if (spec === "skipSchool") {
    applyStats({ mood: 2, smarts: -1 });
    logEvent("I skipped school today.", "bad");
    return;
  }
  if (spec === "underageDrink") {
    applyStats({ mood: 2, health: -2 });
    logEvent("I drank underage. Felt grown up.", "bad");
    if (Math.random() < 0.3) {
      if (!Array.isArray(State.addictions)) State.addictions = [];
      if (!State.addictions.includes("alcohol")) State.addictions.push("alcohol");
    }
    return;
  }
  if (spec === "hitchhike") {
    if (Math.random() < 0.7) {
      applyStats({ mood: 3 });
      logEvent("I hitchhiked. The stranger was nice.", "good");
    } else {
      applyStats({ mood: -5, health: -3 });
      logEvent("Hitchhiking went badly.", "bad");
    }
    return;
  }
  if (spec === "illegalBungee") {
    if (Math.random() < 0.6) {
      applyStats({ mood: 6, health: -1 });
      logEvent("Illegal bungee. Insane rush.", "good");
    } else {
      applyStats({ mood: -3, health: -6 });
      logEvent("The cord didn't hold right. I got hurt.", "bad");
    }
    return;
  }
  if (spec === "needTherapy") {
    State.memory = State.memory || {};
    State.memory.in_therapy = true;
    applyStats({ mood: 2, smarts: 1 });
    return;
  }
  // --- Aliases & extra handlers for expanded events ---
  if (spec === "new_partner") { createPartner(); return; }
  if (spec === "new_sibling") {
    if (!State.siblings) State.siblings = [];
    const g = Math.random() < 0.5 ? "M" : "F";
    const name = pick(g === "M" ? GAME.constants.firstNamesM : GAME.constants.firstNamesF);
    State.siblings.push({ name, gender: g, age: 0, level: 80 });
    return;
  }
  if (spec === "adopted_child") {
    const g = Math.random() < 0.5 ? "M" : "F";
    const name = pick(g === "M" ? GAME.constants.firstNamesM : GAME.constants.firstNamesF);
    const age = 1 + Math.floor(Math.random() * 8);
    State.children.push({ name, gender: g, age, level: 85, adopted: true });
    logEvent(`I adopted ${name}, age ${age}.`, "good");
    return;
  }
  if (spec === "baby_incoming") {
    State.memory = State.memory || {};
    State.memory.expecting_baby = true;
    logEvent("A baby is on the way.", "good");
    return;
  }
  if (spec === "cheated_partner") {
    State.memory = State.memory || {};
    State.memory.had_affair = true;
    if (State.partner) State.partner.level = Math.max(0, (State.partner.level || 50) - 25);
    applyStats({ mood: -3 });
    return;
  }
  if (spec === "raise_small")  { if (State.job) State.job.salary = Math.round(State.job.salary * 1.10); return; }
  if (spec === "raise_medium") { if (State.job) State.job.salary = Math.round(State.job.salary * 1.20); return; }
  if (spec === "raise_big")    { if (State.job) State.job.salary = Math.round(State.job.salary * 1.40); return; }
  if (spec === "demoted") {
    if (State.job) {
      State.job.salary = Math.round(State.job.salary * 0.70);
      applyStats({ mood: -5 });
      logEvent("I got demoted at work.", "bad");
    }
    return;
  }
  if (spec === "job_offer") {
    if (State.job) {
      State.job.salary = Math.round(State.job.salary * 1.30);
      logEvent("I accepted a new job offer.", "good");
    }
    return;
  }
  if (spec === "die_now") {
    State.health = 0;
    logEvent("My time has come.", "bad");
    return;
  }
  // Unknown specials are silently ignored to avoid breaking events
}

function createPartner() {
  const g = Math.random() < 0.5 ? "M" : "F";
  const name = pick(g === "M" ? GAME.constants.firstNamesM : GAME.constants.firstNamesF);
  State.partner = { name, gender: g, level: 75, married: false };
}

function addChild() {
  const g = Math.random() < 0.5 ? "M" : "F";
  const name = pick(g === "M" ? GAME.constants.firstNamesM : GAME.constants.firstNamesF);
  State.children.push({ name, gender: g, age: 0, level: 90 });
}

/* ============ ACTIVITY ENGINE ============ */
function calcEnjoyment(act) {
  const e = act.e || {};
  let v = 30;
  v += (e.mood   || 0) * 5;
  v += (e.health || 0) * 2;
  v += (e.smarts || 0) * 1.5;
  v += (e.looks  || 0) * 2;
  if (e.money > 0) v += Math.min(15, e.money / 50);
  v += (Math.random() * 16) - 8;
  return clamp(Math.round(v));
}

function narrateActivity(act) {
  const e = act.e || {};
  const bits = [`I decided to ${act.name.toLowerCase()}. ${act.desc.toLowerCase()}.`];
  const goodKeys = Object.keys(e).filter(k => e[k] > 0 && k !== "money");
  const badKeys  = Object.keys(e).filter(k => e[k] < 0 && k !== "money");
  if (goodKeys.length > 0) bits.push(`I felt my ${goodKeys.join(", ")} improve.`);
  if (badKeys.length  > 0) bits.push(`My ${badKeys.join(", ")} took a small hit.`);
  if (e.money > 0)  bits.push(`Earned ${money(e.money)} on the way.`);
  if (act.cost > 0) bits.push(`It cost me ${money(act.cost)}.`);
  return bits.join(" ");
}

function doActivity(act) {
  if (State.age < act.minAge) return;
  if (act.cost && act.cost > 0) {
    if (!spend(act.cost)) {
      showAftermath("Can't Afford", `I tried to ${act.name.toLowerCase()} but couldn't afford it.`);
      return;
    }
  }
  // Track risky activity attempts for the Daredevil badge
  if (act.cat === "Risky") State._riskyCount = (State._riskyCount || 0) + 1;
  if (act.special) {
    handleActivitySpecial(act);
  } else if (act.e) {
    applyStats(act.e);
    logEvent(`I decided to ${act.name.toLowerCase()}.`);
    showAftermath(act.name, narrateActivity(act), { enjoyment: calcEnjoyment(act) });
  }
}

/* ============ SPECIAL ACTIVITIES ============ */
function handleActivitySpecial(act) {
  const s = act.special;
  if (s === "college")     return enrollCollege();
  if (s === "gradschool")  return enrollGradSchool();
  if (s === "friend")      return makeFriend();
  if (s === "dating")      return useDatingApps();
  if (s === "askout")      return askOut();
  if (s === "propose")     return propose();
  if (s === "wedding")     return planWedding();
  if (s === "affair")      return haveAffair();
  if (s === "divorce")     return fileDivorce();
  if (s === "baby")        return tryForBaby();
  if (s === "surpriseGift")return surpriseGift();
  if (s === "podcast")     return startPodcast();
  if (s === "standup")     return tryStandup();
  if (s === "tiktok")      return scrollTikTok();
  if (s === "barcrawl")    return barCrawl();
  if (s === "drugs")       return tryDrugs();
  if (s === "streetrace")  return streetRace();
  if (s === "pickpocket")  return pickpocket();
  if (s === "shoplift")    return shoplift();
  if (s === "gamble")      return gamble();
  if (s === "barfight")    return barFight();
  if (s === "graffiti")    return graffiti();
  if (s === "streak")      return streak();
  if (s === "hitchhike")   return hitchhike();
  if (s === "insider")     return insiderTrade();
  // Route addiction-style activities through the unified addiction handler
  const addKey = addictionKeyForSpecial(s);
  if (addKey) return handleAddictionActivity(act, addKey);
  if (s === "commitCrime")      return commitCrime();
  if (s === "hack")             return hackWebsite();
  if (s === "pyramidScheme")    return runPyramidScheme();
  if (s.startsWith("pet:")) return adoptPet(s.split(":")[1]);
  if (s.startsWith("buy:")) return handleBuy(s.split(":")[1]);
  // Non-addiction risky one-offs — pass through to outcome handler
  if (s === "cheatTest" || s === "skipSchool" || s === "underageDrink" ||
      s === "illegalBungee") {
    handleOutcomeSpecial(s);
    showAftermath(act.name, "I did it. Consequences will follow.", {});
    return;
  }
}

/* ============ ADDICTION SYSTEM ============ */
// Each addiction: { id, label, doVerb, indulgeText, quitTitle, quitFailText, quitSuccessText, indulgeMood, quitMoodHit }
const ADDICTION_DEFS = {
  "alcohol":      { id:"alcohol",      label:"alcohol",        doVerb:"Have a drink",
                    indulgeText:"I drank again. Hits the same as always.",
                    quitFailText:"I told myself I'd quit drinking. By dinner I had a glass in hand.",
                    quitSuccessText:"I finally walked away from the bottle. For now.",
                    indulgeMood:+4, healthHit:-2, quitMoodHit:-6 },
  "smoking":      { id:"smoking",      label:"smoking",        doVerb:"Smoke another one",
                    indulgeText:"Another pack down.",
                    quitFailText:"I crushed the pack. Bought a new one before noon.",
                    quitSuccessText:"I threw out my lighter. I'm done.",
                    indulgeMood:+3, healthHit:-2, quitMoodHit:-5 },
  "drugs":        { id:"drugs",        label:"drugs",          doVerb:"Use again",
                    indulgeText:"I used again. Same script.",
                    quitFailText:"I lasted two days clean. Then I caved.",
                    quitSuccessText:"I got clean. I never thought I could.",
                    indulgeMood:+5, healthHit:-4, quitMoodHit:-8 },
  "self-pleasure":{ id:"self-pleasure",label:"self-pleasure",  doVerb:"Indulge",
                    indulgeText:"I took some time for myself.",
                    quitFailText:"I told myself I'd hold out. I didn't.",
                    quitSuccessText:"I broke the loop.",
                    indulgeMood:+6, healthHit:0, quitMoodHit:-3 },
  "vape":         { id:"vape",         label:"vaping",         doVerb:"Hit the vape",
                    indulgeText:"I hit the vape. Sweet fog, racing heart.",
                    quitFailText:"My pod was empty. I bought five more by lunch.",
                    quitSuccessText:"I tossed the vape in the trash.",
                    indulgeMood:+2, healthHit:-2, quitMoodHit:-4 },
  "caffeine":     { id:"caffeine",     label:"caffeine pills", doVerb:"Take a pill",
                    indulgeText:"Took another caffeine pill. Heart pounding.",
                    quitFailText:"My head was splitting. I caved before noon.",
                    quitSuccessText:"I survived the headaches and quit.",
                    indulgeMood:+1, healthHit:-2, quitMoodHit:-4 },
};

// Resolve a special id to an addiction key. Returns null if it's not an addiction starter.
function addictionKeyForSpecial(special) {
  if (special === "addictionAlcohol") return "alcohol";
  if (special === "addictionSmoking") return "smoking";
  if (special === "selfPleasure")     return "self-pleasure";
  if (special === "vapeStart")        return "vape";
  if (special === "caffeinePills")    return "caffeine";
  return null;
}

// Main entry — called when player clicks an Addictions activity.
function handleAddictionActivity(act, key) {
  const def = ADDICTION_DEFS[key];
  if (!def) return;

  // First time: instantly addicted, show aftermath.
  if (!State.addictions.includes(key)) {
    State.addictions.push(key);
    State._everAddicted = true;
    State.stats.mood = clamp(State.stats.mood + def.indulgeMood + 6);
    if (def.healthHit) State.stats.health = clamp(State.stats.health + def.healthHit);
    logEvent(`I started using ${def.label}. I'm hooked now.`, "bad");
    showAftermath("You're Addicted",
      `I tried ${def.label} for the first time. It felt good — too good. ` +
      `I now have an addiction to ${def.label}. From now on, every time I try to do this, I'll have to choose: feed it, or fight it.`,
      { info: [{ label: "New Addiction", value: def.label }] });
    return;
  }

  // Already addicted: present Do It / Quit It dialog.
  showOptions(`Addicted to ${def.label}`,
    `I'm addicted to ${def.label}. What do I do?`,
    [
      { label: def.doVerb, run: () => {
          State.stats.mood = clamp(State.stats.mood + def.indulgeMood);
          if (def.healthHit) State.stats.health = clamp(State.stats.health + def.healthHit);
          logEvent(def.indulgeText);
          showAftermath(def.doVerb, def.indulgeText, { enjoyment: 60 + Math.floor(Math.random() * 25) });
      }},
      { label: "Quit it", run: () => {
          // Quitting succeeds only 10% of the time.
          if (Math.random() < 0.10) {
            const idx = State.addictions.indexOf(key);
            if (idx >= 0) State.addictions.splice(idx, 1);
            State.memory = State.memory || {};
            State.memory.recovered_from_addiction = true;
            State.stats.mood = clamp(State.stats.mood - 2);
            logEvent(`I quit ${def.label}. For real this time.`, "good");
            showAftermath("Free of It", def.quitSuccessText,
              { info: [{ label: "Addiction Ended", value: def.label }] });
          } else {
            State.stats.mood = clamp(State.stats.mood + def.quitMoodHit);
            logEvent(`I tried to quit ${def.label}. I failed.`, "bad");
            showAftermath("Couldn't Do It", def.quitFailText,
              { info: [{ label: "Still Addicted To", value: def.label }] });
          }
      }},
    ]);
}

// Back-compat wrappers (callable from elsewhere in the codebase)
function startAlcohol() { handleAddictionActivity(null, "alcohol"); }
function startSmoking() { handleAddictionActivity(null, "smoking"); }
function selfPleasure() { handleAddictionActivity(null, "self-pleasure"); }

/* ============ COMMIT A CRIME ============ */
function commitCrime() {
  showOptions("Commit a Crime", "What kind of crime?", [
    { label: "Rob a bank",        run: robBank },
    { label: "Burglarize a house",run: burglarize },
    { label: "Mug someone",       run: muggingCrime },
    { label: "Assault someone",   run: assault },
    { label: "Sell drugs",        run: sellDrugs },
    { label: "Vandalism",         run: vandalism },
    { label: "Carjack someone",   run: carjack },
    { label: "Arson",             run: arson },
  ]);
}

function robBank() {
  const r = Math.random();
  if (r < 0.05) {
    const take = Math.floor(Math.random() * 200000) + 100000;
    State.bank += take;
    logEvent(`I robbed a bank and got away with ${money(take)}!`, "good");
    showAftermath("Heist of the Year", `Walked out with ${money(take)}. Untouchable.`);
  } else if (r < 0.3) {
    const take = Math.floor(Math.random() * 30000) + 5000;
    State.money += take;
    State.criminalRecord++;
    logEvent(`I robbed a bank for ${money(take)}, then got cornered.`, "bad");
    goToJail(10, "Bank robbery");
  } else {
    State.criminalRecord++;
    goToJail(15, "Bank robbery (failed)");
  }
}

function burglarize() {
  if (Math.random() < 0.45) {
    State.criminalRecord++;
    goToJail(2, "Burglary");
  } else {
    const take = Math.floor(Math.random() * 5000) + 500;
    State.money += take;
    logEvent(`I burgled a house for ${money(take)}.`, "bad");
    showAftermath("Clean Take", `Slipped in and out with ${money(take)} in valuables.`);
  }
}

function muggingCrime() {
  if (Math.random() < 0.4) {
    State.criminalRecord++;
    goToJail(1, "Mugging");
  } else {
    const take = Math.floor(Math.random() * 800) + 100;
    State.money += take;
    logEvent(`I mugged someone for ${money(take)}.`, "bad");
    showAftermath("Easy Mark", `Took ${money(take)} off them.`);
  }
}

function assault() {
  showDropdowns({
    title: "Attack",
    body: "Who am I attacking, and how?",
    selects: [
      { name: "hit", label: "Hit", options: ["Punch","Kick","Headbutt","Tackle","Elbow","Slap","Choke","Bite"], limit: 4 },
      { name: "location", label: "Location", options: ["Head","Face","Chest","Stomach","Back","Legs","Arm","Neck"], limit: 4 },
    ],
    submitLabel: "Attack",
    outcome: {
      branch: [
        { chance: 0.5, log: "My {hit} to the {location} dropped them. Then the cops dropped me.", logKind: "bad",
          stats: { health: -4 }, jail: 3, jailCrime: "Assault" },
        { log: "I tried a {hit} to the {location}. They beat me down.", logKind: "bad",
          stats: { health: -20 } },
      ],
    },
  });
}

function sellDrugs() {
  const r = Math.random();
  if (r < 0.3) {
    State.criminalRecord++;
    goToJail(4, "Drug trafficking");
  } else if (r < 0.6) {
    const take = Math.floor(Math.random() * 3000) + 500;
    State.money += take;
    logEvent(`Sold drugs and made ${money(take)}.`, "bad");
    showAftermath("Cash Flow", `Cleared ${money(take)} this run.`);
  } else {
    const take = Math.floor(Math.random() * 12000) + 3000;
    State.money += take;
    logEvent(`A big drug deal netted me ${money(take)}.`, "bad");
    showAftermath("Big Score", `${money(take)} richer.`);
  }
}

function vandalism() {
  if (Math.random() < 0.35) {
    State.criminalRecord++;
    State.money = Math.max(0, State.money - 800);
    logEvent("Caught vandalizing. Fine and a record.", "bad");
    showAftermath("Tagged Out", "$800 fine, plus a record.");
  } else {
    State.stats.mood = clamp(State.stats.mood + 5);
    logEvent("Vandalized something. Got away with it.");
    showAftermath("Anarchy", "My mark is on the wall.");
  }
}

function carjack() {
  if (Math.random() < 0.5) {
    State.criminalRecord++;
    goToJail(5, "Grand theft auto");
  } else {
    const take = Math.floor(Math.random() * 8000) + 2000;
    State.money += take;
    logEvent(`Carjacked someone and sold the car for ${money(take)}.`, "bad");
    showAftermath("Hot Wheels", `Cleared ${money(take)} fencing the car.`);
  }
}

function arson() {
  if (Math.random() < 0.55) {
    State.criminalRecord++;
    goToJail(8, "Arson");
  } else {
    State.stats.mood = clamp(State.stats.mood + 7);
    logEvent("I set something on fire and watched it burn.", "bad");
    showAftermath("Pyromania", "Hypnotic.");
  }
}

function enrollCollege() {
  if (State.education.includes("College") || State.inCollege) { showAftermath("Already Enrolled", "I'm already on a college track."); return; }
  if (State.stats.smarts < 50) { showAftermath("Rejected", "My grades weren't strong enough. I didn't get in."); return; }
  if (!spend(20000)) { showAftermath("Can't Afford", "College tuition is no joke. I couldn't swing it."); return; }
  State.inCollege = true;
  State.collegeYear = 1;
  logEvent("I enrolled in college.", "good");
  showAftermath("College Bound", "I enrolled in college. Four long years ahead.");
}

function enrollGradSchool() {
  if (!State.education.includes("College graduate")) { showAftermath("Not Eligible", "I need a college degree first."); return; }
  if (State.inGradSchool) { showAftermath("Already Enrolled", "I'm already in grad school."); return; }
  if (State.stats.smarts < 70) { showAftermath("Rejected", "My credentials weren't strong enough."); return; }
  if (!spend(40000)) { showAftermath("Can't Afford", "Grad school is expensive. I couldn't swing it."); return; }
  State.inGradSchool = true;
  State.gradYear = 1;
  logEvent("I enrolled in grad school.", "good");
  showAftermath("Grad School", "I'm going for a master's degree.");
}

function makeFriend() {
  const g = Math.random() < 0.5 ? "M" : "F";
  const name = pick(g === "M" ? GAME.constants.firstNamesM : GAME.constants.firstNamesF);
  State.friends.push({ name, gender: g, level: 70 });
  logEvent(`I made a new friend: ${name}.`, "good");
  showAftermath("New Friend", `I hit it off with ${name}.`);
}

function useDatingApps() {
  if (State.age < 18) { showAftermath("Too Young", "I'm too young for dating apps."); return; }
  if (Math.random() < 0.4) {
    createPartner();
    logEvent(`I matched with ${State.partner.name} on a dating app.`, "good");
    showAftermath("Match!", `I matched with ${State.partner.name}. We hit it off.`);
  } else {
    showAftermath("Swipe", "I swiped for an hour. Nothing came of it.");
  }
}

function askOut() {
  if (State.partner) { showAftermath("Already Taken", `I'm already with ${State.partner.name}.`); return; }
  showPills("Ask Someone Out", "Who's the lucky type?", [
    { label: "Someone from school/work", run: () => askoutAttempt(0.55) },
    { label: "A friend",                 run: () => askoutAttempt(0.65) },
    { label: "A stranger",               run: () => askoutAttempt(0.30) },
  ], { label: "Choose with AI", prompt: "I'm asking someone out. Where should I find them?", contextLabel: "askout" });
}
function askoutAttempt(prob) {
  // Looks/smarts bump the odds
  const bonus = (State.stats.looks - 50) / 200 + (State.stats.smarts - 50) / 300;
  if (Math.random() < clamp(prob + bonus, 0.05, 0.95) / 1) {
    createPartner();
    logEvent(`I asked ${State.partner.name} out and they said yes.`, "good");
    showAftermath("They Said Yes!", `${State.partner.name} agreed to a date.`);
  } else {
    State.stats.mood = clamp(State.stats.mood - 5);
    logEvent("I asked someone out. Got rejected.", "bad");
    showAftermath("Rejected", "They said no. Brutal.");
  }
}

function propose() {
  if (!State.partner) { showAftermath("No Partner", "I have no one to propose to."); return; }
  if (State.partner.married) { showAftermath("Already Married", `I'm already married to ${State.partner.name}.`); return; }
  if (Math.random() < 0.7 + State.partner.level / 300) {
    State.partner.engaged = true;
    logEvent(`I proposed to ${State.partner.name} and they said yes!`, "good");
    showAftermath("Engaged!", `${State.partner.name} said yes!`);
  } else {
    State.partner.level = clamp(State.partner.level - 25);
    State.stats.mood = clamp(State.stats.mood - 12);
    logEvent(`I proposed to ${State.partner.name}. They said no.`, "bad");
    showAftermath("Rejected", "They said they weren't ready. Painful.");
  }
}

function planWedding() {
  if (!State.partner) { showAftermath("No Partner", "I have no one to marry."); return; }
  if (State.partner.married) { showAftermath("Already Married", `I'm already married.`); return; }
  State.partner.married = true;
  logEvent(`I married ${State.partner.name}.`, "good");
  showAftermath("Married!", `I tied the knot with ${State.partner.name}.`);
}

function haveAffair() {
  if (!State.partner || !State.partner.married) { showAftermath("Not Married", "I'm not married. This isn't an affair."); return; }
  State.memory = State.memory || {};
  State.memory.cheatedOnPartner = true;
  if (Math.random() < 0.45) {
    State.partner.level = clamp(State.partner.level - 50);
    State.stats.mood = clamp(State.stats.mood - 10);
    logEvent(`My affair was discovered. ${State.partner.name} is devastated.`, "bad");
    showAftermath("Caught", `${State.partner.name} found out. The marriage is hanging by a thread.`);
  } else {
    State.stats.mood = clamp(State.stats.mood + 3);
    logEvent(`I had an affair. So far, no one knows.`, "bad");
    showAftermath("Secret Kept", "For now, nobody knows.");
  }
}

function fileDivorce() {
  if (!State.partner || !State.partner.married) { showAftermath("Not Married", "I'm not married."); return; }
  const name = State.partner.name;
  State.bank = Math.max(0, Math.floor(State.bank / 2));
  State.partner = null;
  logEvent(`I divorced ${name}. Lost half my savings.`, "bad");
  showAftermath("Divorced", `Half my savings gone. ${name} is gone too.`);
}

function tryForBaby() {
  if (!State.partner) { showAftermath("No Partner", "I'd need a partner first."); return; }
  if (Math.random() < 0.5) {
    addChild();
    const c = State.children[State.children.length - 1];
    logEvent(`I had a baby named ${c.name}.`, "good");
    showAftermath("It's a Baby!", `${c.name} was born.`);
  } else {
    showAftermath("Not Yet", "Not this time.");
  }
}

function surpriseGift() {
  if (!State.partner) { showAftermath("No Partner", "I have no partner to gift."); return; }
  State.partner.level = clamp(State.partner.level + 8);
  State.stats.mood = clamp(State.stats.mood + 2);
  logEvent(`I surprised ${State.partner.name} with a gift.`, "good");
  showAftermath("Sweet Gesture", `${State.partner.name} loved it.`);
}

function startPodcast() {
  if (Math.random() < 0.15) {
    const earnings = Math.floor(Math.random() * 5000) + 500;
    State.money += earnings;
    logEvent(`My podcast picked up listeners. Made ${money(earnings)}.`, "good");
    showAftermath("Subscriber Spike", `My podcast made ${money(earnings)} this season.`);
  } else {
    showAftermath("Three Listeners", "My podcast has my mom, my dog, and one bot.");
  }
}

function tryStandup() {
  if (Math.random() < 0.3) {
    State.stats.mood = clamp(State.stats.mood + 6);
    logEvent("My stand-up set killed.", "good");
    showAftermath("Stand-up Hit", "Got laughs all night. I'm a comedian now.");
  } else {
    State.stats.mood = clamp(State.stats.mood - 6);
    logEvent("My stand-up set bombed.", "bad");
    showAftermath("Crickets", "Tough crowd. Tougher mirror later.");
  }
}

function scrollTikTok() {
  State.stats.mood = clamp(State.stats.mood + 4);
  State.stats.smarts = clamp(State.stats.smarts - 1);
  logEvent("I scrolled TikTok for two hours.", "normal");
  showAftermath("Doomscroll", "Two hours, gone. Brain mildly fried.", { enjoyment: 70 });
}

function barCrawl() {
  if (Math.random() < 0.2) {
    State.criminalRecord++;
    if (Math.random() < 0.6) {
      goToJail(1, "Drunk and disorderly");
    } else {
      State.stats.mood = clamp(State.stats.mood - 5);
      State.money = Math.max(0, State.money - 400);
      logEvent("Got into trouble on a bar crawl. $400 fine.", "bad");
      showAftermath("Hungover", "Lost the night, lost $400.");
    }
  } else {
    State.stats.mood = clamp(State.stats.mood + 5);
    State.stats.health = clamp(State.stats.health - 3);
    logEvent("Wild bar crawl. Don't remember most of it.");
    showAftermath("Bar Crawl", "What a night. I think.", { enjoyment: 80 });
  }
}

function tryDrugs() {
  const r = Math.random();
  if (r < 0.15) {
    State.criminalRecord++;
    goToJail(2, "Drug possession");
  } else if (r < 0.45) {
    State.addictions.push("drugs");
    State.stats.health = clamp(State.stats.health - 10);
    logEvent("I tried drugs and got hooked.", "bad");
    showAftermath("Addicted", "I tried drugs once. Now they're trying me.");
  } else {
    State.stats.mood = clamp(State.stats.mood + 4);
    logEvent("I experimented with drugs. Just once.");
    showAftermath("One Time", "Fun once, never again. Probably.");
  }
}

function streetRace() {
  if (Math.random() < 0.4) {
    State.stats.health = clamp(State.stats.health - 25);
    State.criminalRecord++;
    if (Math.random() < 0.5) {
      goToJail(2, "Reckless driving / Street racing");
    } else {
      logEvent("Crashed in a street race. ER bills and a fine.", "bad");
      State.money = Math.max(0, State.money - 2000);
      showAftermath("Crash", "ER and a $2000 fine. Could've been worse.");
    }
  } else {
    State.stats.mood = clamp(State.stats.mood + 6);
    const win = Math.floor(Math.random() * 2000) + 500;
    State.money += win;
    logEvent(`I won a street race. Cash prize: ${money(win)}.`, "good");
    showAftermath("Winner", `Took home ${money(win)}.`);
  }
}

function pickpocket() {
  if (Math.random() < 0.5) {
    State.criminalRecord++;
    State.stats.mood = clamp(State.stats.mood - 5);
    if (Math.random() < 0.55) {
      goToJail(1, "Pickpocketing");
    } else {
      logEvent("I got caught pickpocketing. Cop let me off with a warning.", "bad");
      showAftermath("Caught", "Cuffs out, then back off. Lucky warning.");
    }
  } else {
    const take = Math.floor(Math.random() * 200) + 50;
    State.money += take;
    logEvent(`I pickpocketed ${money(take)} from a stranger.`, "bad");
    showAftermath("Lifted", `Slipped ${money(take)} into my pocket.`);
  }
}

function shoplift() {
  if (Math.random() < 0.45) {
    State.criminalRecord++;
    State.stats.mood = clamp(State.stats.mood - 4);
    if (Math.random() < 0.4) {
      goToJail(1, "Shoplifting");
    } else {
      logEvent("Caught shoplifting. Banned from the store and a fine.", "bad");
      State.money = Math.max(0, State.money - 300);
      showAftermath("Busted", "Security tackled me at the door. $300 fine.");
    }
  } else {
    logEvent("I shoplifted. Got away clean.", "bad");
    showAftermath("Five-Finger Discount", "Walked right out with it.");
  }
}

function gamble() {
  const r = Math.random();
  if (r < 0.05) {
    const win = 100000;
    State.bank += win;
    logEvent(`I WON THE LOTTERY at the casino! ${money(win)}!`, "good");
    showAftermath("JACKPOT", `I hit it big — ${money(win)}.`);
  } else if (r < 0.35) {
    const win = Math.floor(Math.random() * 1500) + 200;
    State.money += win;
    logEvent(`Won ${money(win)} gambling.`, "good");
    showAftermath("Lucky Night", `Cashed out ${money(win)} ahead.`);
  } else {
    logEvent("Lost it all at the casino.", "bad");
    showAftermath("Bust", "The house always wins.");
  }
}

function barFight() {
  if (Math.random() < 0.5) {
    State.stats.health = clamp(State.stats.health - 15);
    State.criminalRecord++;
    if (Math.random() < 0.4) {
      goToJail(1, "Bar fight assault");
    } else {
      logEvent("Lost a bar fight. Banned and charged.", "bad");
      State.money = Math.max(0, State.money - 500);
      showAftermath("Lost the Fight", "Got my clock cleaned. $500 fine and a record.");
    }
  } else {
    State.stats.mood = clamp(State.stats.mood + 4);
    State.criminalRecord++;
    if (Math.random() < 0.25) {
      goToJail(1, "Bar fight assault");
    } else {
      logEvent("Won a bar fight. Bouncer threw us both out.");
      showAftermath("Knockout", "Three punches, one win, one bruise.");
    }
  }
}

function graffiti() {
  if (Math.random() < 0.35) {
    State.criminalRecord++;
    if (Math.random() < 0.35) {
      goToJail(1, "Vandalism");
    } else {
      State.money = Math.max(0, State.money - 600);
      logEvent("Caught spray-painting a wall. Fined.", "bad");
      showAftermath("Tagged", "$600 fine and community service.");
    }
  } else {
    State.stats.mood = clamp(State.stats.mood + 5);
    logEvent("Painted a wall after dark. Art lives.");
    showAftermath("Underground Artist", "My tag is on a wall downtown.");
  }
}

function streak() {
  if (Math.random() < 0.5) {
    State.criminalRecord++;
    State.stats.mood = clamp(State.stats.mood - 6);
    if (Math.random() < 0.45) {
      goToJail(1, "Public indecency");
    } else {
      State.money = Math.max(0, State.money - 800);
      logEvent("Got arrested streaking. Fine and citation.", "bad");
      showAftermath("Arrested", "Held overnight. $800 fine.");
    }
  } else {
    State.stats.mood = clamp(State.stats.mood + 8);
    logEvent("Streaked across a public park. Got away with it.");
    showAftermath("Wind in My Hair", "I have never felt more alive.");
  }
}

function hitchhike() {
  if (Math.random() < 0.2) {
    State.stats.health = clamp(State.stats.health - 20);
    State.money = Math.max(0, State.money - 200);
    logEvent("My hitchhike went badly.", "bad");
    showAftermath("Bad Ride", "Got robbed and dumped on the side of the road.");
  } else {
    State.stats.mood = clamp(State.stats.mood + 4);
    logEvent("Hitchhiked across town with a kind stranger.");
    showAftermath("Free Ride", "They even bought me lunch.");
  }
}

function insiderTrade() {
  if (Math.random() < 0.5) {
    const take = Math.floor(Math.random() * 80000) + 20000;
    State.bank += take;
    logEvent(`Made ${money(take)} on insider info.`, "bad");
    showAftermath("Big Bet", `Cleared ${money(take)}. Don't talk about it.`);
  } else {
    State.criminalRecord++;
    State.bank = Math.max(0, State.bank - 50000);
    if (Math.random() < 0.7) {
      goToJail(3, "Insider trading / Securities fraud");
    } else {
      logEvent("SEC caught the insider trade. Massive fine, no jail.", "bad");
      showAftermath("Fined", "SEC took $50k. Lawyer kept me out of jail.");
    }
  }
}

function adoptPet(kind) {
  const name = pick(GAME.constants.petNames);
  State._petsOwned = (State._petsOwned || 0) + 1;
  State.pets.push({ name, kind, level: 85 });
  State.stats.mood = clamp(State.stats.mood + 6);
  logEvent(`I adopted a ${kind} named ${name}.`, "good");
  showAftermath("New Pet", `Meet ${name}, my ${kind}.`);
}

function handleBuy(kind) {
  if (kind === "house") {
    State.investments.realEstate += 150000;
    logEvent("I bought a house.", "good");
    showAftermath("Home", "I bought my first house. Keys in hand.");
  } else if (kind === "food") {
    State.stats.mood = clamp(State.stats.mood + 4);
    logEvent("Ordered gourmet food.");
    showAftermath("Delivered", "Best meal in weeks.", { enjoyment: 75 });
  } else if (kind === "phone") {
    State.stats.mood = clamp(State.stats.mood + 3);
    logEvent("Bought a new phone.");
    showAftermath("Unboxed", "Shiny rectangle acquired.", { enjoyment: 65 });
  } else if (kind === "car") {
    logEvent("Bought a new car.", "good");
    showAftermath("Wheels", "New car smell hits different.");
  } else if (kind === "yacht") {
    State.investments.realEstate += 300000;
    logEvent("Bought a yacht.", "good");
    showAftermath("Yacht", "I now own a boat too big for any lake.");
  } else if (kind === "mansion") {
    State.investments.realEstate += 2500000;
    logEvent("Bought a mansion.", "good");
    showAftermath("Mansion", "Twelve bedrooms. I'll sleep in three.");
  } else if (kind === "jet") {
    State.investments.realEstate += 15000000;
    logEvent("Bought a private jet.", "good");
    showAftermath("Sky Lounge", "Airports are a thing of the past.");
  }
}

function hackWebsite() {
  const r = Math.random();
  if (r < 0.4) {
    State.criminalRecord++;
    goToJail(2, "Computer fraud");
  } else if (r < 0.7) {
    const take = Math.floor(Math.random() * 8000) + 1000;
    State.money += take;
    logEvent(`I hacked a website and stole ${money(take)}.`, "bad");
    showAftermath("Untraceable", `Funneled ${money(take)} into my account.`);
  } else {
    State.stats.smarts = clamp(State.stats.smarts + 4);
    logEvent("I hacked a website just for the fun of it.", "bad");
    showAftermath("Skill Up", "Got in and out. No trace.");
  }
}

function runPyramidScheme() {
  if (Math.random() < 0.55) {
    State.criminalRecord++;
    goToJail(3, "Fraud / Pyramid scheme");
  } else {
    const take = Math.floor(Math.random() * 30000) + 5000;
    State.money += take;
    logEvent(`My pyramid scheme made ${money(take)} before collapsing.`, "bad");
    showAftermath("Scheme", `Cleared ${money(take)} before the bottom fell out.`);
  }
}

/* ============ JAIL ============ */
function goToJail(years, crime) {
  // Lawyer can reduce sentence by 30-60%
  if (State.hasLawyer) {
    const reduction = 0.3 + Math.random() * 0.3;
    years = Math.max(1, Math.round(years * (1 - reduction)));
    State.hasLawyer = false; // single use
  }
  State.inJail = { sentence: years, served: 0, crime: crime || "Various charges", behavior: 0 };
  State.criminalRecord++;
  State.job = null;
  State.memory = State.memory || {};
  State.memory.wasJailed = true;
  logEvent(`I was sentenced to ${years} year(s) for ${State.inJail.crime}.`, "bad");
  showAftermath("Sentenced", `${years} year(s) for ${State.inJail.crime}. My job is gone.`);
}

function releaseFromJail() {
  if (!State.inJail) return;
  const yrs = State.inJail.sentence;
  const crime = State.inJail.crime;
  State.inJail = null;
  State.stats.mood = clamp(State.stats.mood + 10);
  logEvent(`I was released from prison after ${yrs} years for ${crime}.`, "good");
  showAftermath("Released", "Walked out the gates. The world looks different.");
}

function applyForParole() {
  const j = State.inJail;
  if (!j) return;
  if (j.served < j.sentence / 2) {
    showAftermath("Not Eligible", "I haven't served enough time for parole.");
    return;
  }
  const chance = 0.15 + (j.behavior || 0) * 0.07;
  if (Math.random() < clamp(chance, 0, 0.9)) {
    logEvent("Parole granted.", "good");
    releaseFromJail();
  } else {
    State.stats.mood = clamp(State.stats.mood - 5);
    logEvent("Parole denied.", "bad");
    showAftermath("Denied", "The board said no. Back to my cell.");
  }
}

function attemptEscape() {
  if (!State.inJail) return;
  if (Math.random() < 0.05) {
    const newCountry = pick(GAME.constants.countries.filter(c => c !== State.country));
    State.inJail = null;
    State.criminalRecord += 2;
    State.country = newCountry;
    State.stats.mood = clamp(State.stats.mood + 10);
    logEvent(`I escaped from prison and fled to ${newCountry}.`, "good");
    showAftermath("Free!", `I made it out. Now hiding out in ${newCountry}.`);
  } else {
    State.inJail.sentence += 5;
    State.stats.health = clamp(State.stats.health - 12);
    State.stats.mood = clamp(State.stats.mood - 8);
    logEvent("I tried to escape and got caught. +5 years.", "bad");
    showAftermath("Caught", "Tackled at the wall. Five more years added.");
  }
}

function doJailActivity(act) {
  if (act.special) return handleJailSpecial(act);
  if (act.e) {
    applyStats(act.e);
    logEvent(`In jail: ${act.name.toLowerCase()}.`);
    showAftermath(act.name, narrateActivity(act), { enjoyment: calcEnjoyment(act) });
  }
}

function handleJailSpecial(act) {
  const j = State.inJail;
  if (!j) return;
  switch (act.special) {
    case "jailBehave":
      j.behavior = (j.behavior || 0) + 1;
      State.stats.mood = clamp(State.stats.mood - 1);
      logEvent("I behaved well today. The guards noticed.");
      showAftermath("Good Behavior", "Head down. Hands clean. Guards noticed.");
      break;
    case "jailFight": {
      if (Math.random() < 0.5) {
        State.stats.health = clamp(State.stats.health - 12);
        j.sentence += 1;
        logEvent("Lost a yard fight. +1 year on my sentence.", "bad");
        showAftermath("Lost the Fight", "Got my clock cleaned. Sentence extended.");
      } else {
        State.stats.mood = clamp(State.stats.mood + 5);
        logEvent("Won a yard fight. Respect earned.");
        showAftermath("Yard Win", "Earned some respect. Guards didn't catch it.");
      }
      break;
    }
    case "jailShiv":
      if (Math.random() < 0.4) {
        j.sentence += 2;
        logEvent("Caught with contraband. +2 years.", "bad");
        showAftermath("Contraband", "Guards searched my cell. +2 years.");
      } else {
        State.stats.mood = clamp(State.stats.mood + 3);
        logEvent("I made a shiv. Just in case.");
        showAftermath("Made a Shiv", "Hidden in my mattress. Just in case.");
      }
      break;
    case "jailGang":
      if (Math.random() < 0.6) {
        State.stats.mood = clamp(State.stats.mood + 4);
        logEvent("I joined a prison gang. Protected, for a price.");
        showAftermath("Joined Up", "Got protection. Got obligations.");
      } else {
        State.stats.health = clamp(State.stats.health - 10);
        logEvent("My gang initiation went poorly.", "bad");
        showAftermath("Beaten In", "Initiation hurt. A lot.");
      }
      break;
    case "jailEscape":
      attemptEscape();
      break;
    case "jailParole":
      applyForParole();
      break;
  }
}

/* ============ SICKNESSES ============ */
function addIllness(id) {
  if (!State.illnesses.includes(id)) {
    State.illnesses.push(id);
  }
}

function illnessMeta(id) {
  return (GAME.illnesses || []).find(i => i.id === id);
}

function rollIllness() {
  const pool = (GAME.illnesses || []).filter(i =>
    State.age >= (i.minAge || 0) &&
    !State.illnesses.includes(i.id) &&
    Math.random() < (i.annualChance || 0.01)
  );
  if (pool.length === 0) return false;
  const ill = pick(pool);

  // Show diagnosis dialog with options
  showOptions(`Diagnosis: ${ill.name}`, `My doctor told me I have ${ill.name}. ${ill.desc || ""}`, [
    { label: `Pay for treatment (${money(ill.treatmentCost || 500)})`, run: () => {
      if (spend(ill.treatmentCost || 500)) {
        logEvent(`I paid for treatment and beat ${ill.name}.`, "good");
        showAftermath("Treated", `My ${ill.name} was treated.`);
      } else {
        State.illnesses.push(ill.id);
        applyStats(ill.stats || {});
        logEvent(`I couldn't afford treatment for ${ill.name}.`, "bad");
        showAftermath("Untreated", `I can't afford it. The ${ill.name} stays with me.`);
      }
    }},
    { label: "Try home remedies", run: () => {
      if (Math.random() < 0.25) {
        logEvent(`Home remedies cured my ${ill.name}.`, "good");
        showAftermath("Cured", "Surprisingly, that worked.");
      } else {
        State.illnesses.push(ill.id);
        applyStats(ill.stats || {});
        logEvent(`Home remedies failed against my ${ill.name}.`, "bad");
      }
    }},
    { label: "Get a second opinion", run: () => {
      if (!spend(150)) {
        showAftermath("Broke", "Couldn't afford a second opinion.");
        return;
      }
      if (Math.random() < 0.2) {
        logEvent(`Second opinion said my ${ill.name} diagnosis was wrong!`, "good");
        showAftermath("Misdiagnosis", "Doctor #2 said I'm fine.");
      } else {
        State.illnesses.push(ill.id);
        applyStats(ill.stats || {});
        logEvent(`Second doctor confirmed my ${ill.name}.`, "bad");
        showAftermath("Confirmed", `It's real. ${ill.name}.`);
      }
    }},
    { label: "Ignore it", run: () => {
      State.illnesses.push(ill.id);
      applyStats(ill.stats || {});
      logEvent(`I ignored my ${ill.name} diagnosis.`, "bad");
    }},
  ]);
  return true;
}

function processChronicIllnesses() {
  for (const id of State.illnesses) {
    const ill = illnessMeta(id);
    if (!ill) continue;
    if (ill.ongoing) applyStats(ill.ongoing);
    if (ill.deathChance && Math.random() < ill.deathChance) {
      State.deathCause = `complications from ${ill.name}`;
    }
  }
}

/* ============ ADDICTIONS ============
 * Each addiction is a string id in State.addictions[]. Every year:
 *   - constant health drain
 *   - mood swing: BIG boost when mood is already high (the hit), but
 *     equivalent or worse drain when mood is already low (the spiral)
 *
 * Long-term: every couple of years on alcohol/drugs/smoking has a chance
 * to spawn an associated illness (heart disease, depression, anxiety, etc).
 */
const ADDICTION_PROFILES = {
  "alcohol":      { name:"alcohol",       healthHit:-2, moodUp:+3, moodDown:-4, illnessChance:0.04, possibleIllness:["heartdisease","depression"] },
  "smoking":      { name:"smoking",       healthHit:-3, moodUp:+2, moodDown:-3, illnessChance:0.05, possibleIllness:["heartdisease","asthma"] },
  "drugs":        { name:"drugs",         healthHit:-5, moodUp:+5, moodDown:-6, illnessChance:0.06, possibleIllness:["depression","anxiety"] },
  "self-pleasure":{ name:"self-pleasure", healthHit:0,  moodUp:+1, moodDown:-2, illnessChance:0,    possibleIllness:[] },
  "vape":         { name:"vaping",        healthHit:-2, moodUp:+1, moodDown:-3, illnessChance:0.04, possibleIllness:["asthma","heartdisease"] },
  "caffeine":     { name:"caffeine pills",healthHit:-1, moodUp:+1, moodDown:-2, illnessChance:0.02, possibleIllness:["anxiety"] },
};

function processAddictions() {
  for (const a of State.addictions) {
    const p = ADDICTION_PROFILES[a];
    if (!p) continue;
    if (p.healthHit) State.stats.health = clamp(State.stats.health + p.healthHit);
    // Mood swing depends on current state. The threshold separates the high from the spiral.
    if (State.stats.mood > 40) {
      State.stats.mood = clamp(State.stats.mood + p.moodUp);
    } else {
      State.stats.mood = clamp(State.stats.mood + p.moodDown);
    }
    // Long-term consequence: roll for an associated illness
    if (p.illnessChance && Math.random() < p.illnessChance) {
      const candidates = p.possibleIllness.filter(id => !State.illnesses.includes(id));
      if (candidates.length) {
        const id = pick(candidates);
        const ill = illnessMeta(id);
        if (ill) {
          State.illnesses.push(id);
          logEvent(`Years of ${p.name} caught up with me — diagnosed with ${ill.name}.`, "bad");
        }
      }
    }
  }
}

/* Depression / anxiety auto-spawn from prolonged low mood.
 * Tracked via State.lowMoodStreak: years in a row with mood under 30.
 */
function processOngoing() {
  if (!State.ongoing || !State.ongoing.length) return;
  const keep = [];
  for (const eff of State.ongoing) {
    if (eff.stats) applyStats(eff.stats);
    eff.yearsLeft--;
    if (eff.yearsLeft > 0) keep.push(eff);
  }
  State.ongoing = keep;
}

function processMentalHealth() {
  if (State.stats.mood < 30) {
    State.lowMoodStreak = (State.lowMoodStreak || 0) + 1;
    if (State.lowMoodStreak >= 3 && !State.illnesses.includes("depression") && Math.random() < 0.35) {
      State.illnesses.push("depression");
      logEvent("Years of feeling low caught up with me — diagnosed with depression.", "bad");
    } else if (State.lowMoodStreak >= 2 && !State.illnesses.includes("anxiety") && Math.random() < 0.25) {
      State.illnesses.push("anxiety");
      logEvent("My constant worry has a name now — anxiety disorder.", "bad");
    }
  } else {
    State.lowMoodStreak = 0;
  }
  // Track sustained extreme mood for badges (must endure, not just touch)
  if (State.stats.mood <= 5)        State._lowMoodYears  = (State._lowMoodYears  || 0) + 1;
  else                              State._lowMoodYears  = 0;
  if (State.stats.mood >= 100)      State._euphoriaYears = (State._euphoriaYears || 0) + 1;
  else                              State._euphoriaYears = 0;
}


/* ============ GOVERNMENT DOCUMENTS ============ */
// Government ID: first issuable 11-13, valid 10 years, renewable
// Passport:      first issuable 11-13, valid 10 years, renewable
function issueDocument(kind) {
  const valid = 10;  // years valid
  const expiresAt = State.age + valid;
  if (kind === "id") {
    State.governmentId = { issued: State.age, expiresAt, expired: false };
  } else if (kind === "passport") {
    State.passport = { issued: State.age, expiresAt, expired: false };
  }
}

function checkDocumentExpiry() {
  // Called every year. Mark expired docs and log a one-time notice.
  for (const kind of ["governmentId", "passport"]) {
    const doc = State[kind];
    if (!doc) continue;
    if (!doc.expired && State.age >= doc.expiresAt) {
      doc.expired = true;
      const label = kind === "governmentId" ? "Government ID" : "passport";
      logEvent(`My ${label} expired. I'll need to renew it.`, "bad");
    }
  }
}

function renewDocument(kind) {
  const valid = 10;
  const doc = State[kind];
  if (!doc) return;
  doc.issued = State.age;
  doc.expiresAt = State.age + valid;
  doc.expired = false;
}


// Sub-year units: each click advances this many minutes
const REALISTIC_UNITS = {
  minute: { mins: 30,    label: "30 min",  buttonLbl: "+30m" },   // 30 min/click
  hour:   { mins: 60*4,  label: "4 hours", buttonLbl: "+4h"  },   // 4 hr/click
  day:    { mins: 60*24, label: "1 day",   buttonLbl: "+1d"  },   // 1 day/click
};
const MINUTES_PER_YEAR = 525600;

// Short ambient micro-events for sub-year ticks. Most ticks produce no log
// entry; when one does, it's a one-line flavor note that fits the player's age.
const MICRO_EVENTS = {
  child: [  // 5-12
    "I made up a story in my head while staring out the window.",
    "I dropped my snack on the floor and ate it anyway.",
    "I drew on the back of my notebook in math class.",
    "I traded stickers with a kid at school.",
    "My shoelace came undone twice today.",
    "I imagined being a superhero on the walk home.",
    "I lost a tooth.",
    "I argued with my sibling about whose turn it was.",
    "I asked a really weird question at the dinner table.",
    "I built a fort out of couch cushions.",
  ],
  teen: [  // 13-19
    "I scrolled my phone for too long again.",
    "I overheard a stupid rumor about myself.",
    "I bombed a pop quiz I should have studied for.",
    "I had a really specific crush for about forty minutes.",
    "I roasted my friend in the group chat.",
    "I listened to the same song six times in a row.",
    "I had a deep conversation about absolutely nothing.",
    "I argued with my parents about something dumb.",
    "I stayed up way too late.",
    "I felt invincible for no reason.",
  ],
  adult: [  // 20-60
    "I drank too much coffee.",
    "I scrolled through old photos and got nostalgic.",
    "I had a small disagreement with a coworker.",
    "I forgot why I walked into the kitchen.",
    "I caught up on emails that had been piling up.",
    "I made a quiet decision to stop doing something I hated.",
    "I had a conversation with a stranger that stuck with me.",
    "I treated myself to something small.",
    "I lay in bed thinking about the future.",
    "I sent a text I'd been putting off.",
  ],
  elder: [  // 61+
    "I took a long walk and noticed the trees.",
    "I called an old friend just to hear their voice.",
    "I remembered something I hadn't thought of in years.",
    "I read the morning paper start to finish.",
    "I caught a moment of perfect peace.",
    "I told a story for the hundredth time.",
    "I fixed something small around the house.",
    "I sat on the porch and watched the neighborhood.",
    "I had a long conversation with my grandchild.",
    "I took a nap I didn't plan on.",
  ],
};

function microEventForAge(age) {
  let bucket = "adult";
  if (age < 13) bucket = "child";
  else if (age < 20) bucket = "teen";
  else if (age >= 61) bucket = "elder";
  // Babies (age < 5) don't get micro-events in realistic mode — they just sleep.
  if (age < 5) return null;
  return pick(MICRO_EVENTS[bucket]);
}

// Per-tick chance a micro-event log line is produced.
// Scaled to the unit so a "day" tick has more chance than a "30min" tick.
function microEventChance(unitMins) {
  if (unitMins <= 30)   return 0.04;   // ~4% per 30-min tick
  if (unitMins <= 240)  return 0.18;   // ~18% per 4-hour tick
  return 0.55;                         // ~55% per 1-day tick
}

function advanceTime() {
  if (!State.alive) return;
  // Non-realistic: original year-at-a-time behavior.
  if (!State.realisticMode) { advanceYear(); return; }

  const unit = REALISTIC_UNITS[State.realisticUnit] || REALISTIC_UNITS.day;
  State._subYearMinutes = (State._subYearMinutes || 0) + unit.mins;

  // Roll micro-event for this tick
  if (Math.random() < microEventChance(unit.mins)) {
    const txt = microEventForAge(State.age);
    if (txt) logEvent(txt);
  }

  // If a year's worth has accumulated, trigger the full yearly tick (and recurse
  // for any further whole years — e.g. day unit will only ever cross once per
  // click, but this is robust if someone picks a huge unit later).
  let trigger = false;
  while (State._subYearMinutes >= MINUTES_PER_YEAR) {
    State._subYearMinutes -= MINUTES_PER_YEAR;
    trigger = true;
  }
  if (trigger) {
    advanceYear();   // full yearly processing (illness, job, ageing, events)
  } else {
    render();        // light render — log update, age stays the same
    setTimeout(chainBadges, 30);
  }
  saveGame();
}

function pickRealisticUnit() {
  // Modal-style picker reusing showOptions but with no stat effects.
  const choices = [
    { label: "Advance 30 minutes", outcome: { _setUnit: "minute" } },
    { label: "Advance 4 hours",    outcome: { _setUnit: "hour"   } },
    { label: "Advance 1 day",      outcome: { _setUnit: "day"    } },
  ];
  showOptions("Realistic Mode", "How much time do you want to pass each click?", choices, null,
    "Time will accumulate; once a year passes, a normal yearly event fires.");
}


function advanceYear() {
  if (!State.alive) return;
  State.age++;
  if (State.job) State._yearsInJob = (State._yearsInJob || 0) + 1;
  else State._yearsInJob = 0;

  // ----- JAIL FAST PATH -----
  if (State.inJail) {
    State.inJail.served++;
    if (State.age > 30) State.stats.health = clamp(State.stats.health - (Math.random() < 0.3 ? 1 : 0));
    if (State.age > 50) State.stats.looks  = clamp(State.stats.looks  - (Math.random() < 0.4 ? 1 : 0));
    processChronicIllnesses();
    processAddictions();
    processMentalHealth();
    processOngoing();
    if (State.deathCause) { die(State.deathCause); return; }
    const dc = computeDeathChance();
    if (Math.random() < dc) { die(); return; }
    if (State.inJail.served >= State.inJail.sentence) {
      releaseFromJail();
      render();
      return;
    }
    triggerJailEvent();
    render();
    setTimeout(chainBadges, 50);
    return;
  }

  // Schooling
  if (State.age === 5) { State.inSchool = true; logEvent("I started elementary school.", "good"); }
  if (State.age === 12 && State.inSchool) { logEvent("I moved up to middle school."); }
  if (State.age === 14 && State.inSchool) { logEvent("I started high school."); }
  if (State.age === 18 && State.inSchool) {
    State.inSchool = false;
    if (State.stats.smarts >= 35) { State.education = "High school graduate"; logEvent("I graduated high school.", "good"); }
    else { State.education = "High school dropout"; logEvent("I dropped out of high school.", "bad"); }
  }
  // Hard cut-off: no one stays in K-12 past 20.
  if (State.age >= 20 && State.inSchool) {
    State.inSchool = false;
    if (State.stats.smarts >= 35) { State.education = "High school graduate"; logEvent("I finally finished high school.", "good"); }
    else { State.education = "High school dropout"; logEvent("I aged out of high school without graduating.", "bad"); }
  }
  if (State.inCollege) {
    State.collegeYear++;
    if (State.collegeYear > 4) {
      State.inCollege = false;
      State.education = "College graduate";
      logEvent("I graduated college.", "good");
    }
  }
  if (State.inGradSchool) {
    State.gradYear++;
    if (State.gradYear > 2) {
      State.inGradSchool = false;
      State.education = "Postgraduate";
      logEvent("I finished grad school.", "good");
    }
  }

  // Income
  if (State.job) {
    const taxRate = State.job.salary > 100000 ? 0.30 : 0.22;
    const net = Math.round(State.job.salary * (1 - taxRate));
    State.bank += Math.round(net * 0.7);
    State.money += Math.round(net * 0.3);
  }

  // Partner drift
  if (State.partner) {
    State.partner.level = clamp(State.partner.level + (Math.random() < 0.5 ? -3 : 2));
  }

  // Age children
  for (const c of State.children) c.age++;

  // Investment fluctuation
  if (State.investments.stocks > 0) {
    State.investments.stocks = Math.round(State.investments.stocks * (1 + (Math.random() * 0.3 - 0.1)));
  }
  if (State.investments.crypto > 0) {
    State.investments.crypto = Math.round(State.investments.crypto * (1 + (Math.random() * 0.8 - 0.35)));
  }

  // Natural stat drift
  if (State.age > 30) State.stats.health = clamp(State.stats.health - (Math.random() < 0.3 ? 1 : 0));
  if (State.age > 50) State.stats.looks  = clamp(State.stats.looks  - (Math.random() < 0.4 ? 1 : 0));

  // Chronic illness effects
  processChronicIllnesses();
  processAddictions();
  processMentalHealth();
  processOngoing();
  checkDocumentExpiry();
  if (State.deathCause) { die(State.deathCause); return; }

  // Death roll
  const chance = computeDeathChance();
  if (Math.random() < chance) { die(); return; }

  // Illness roll preempts other events
  if (Math.random() < 0.03 && rollIllness()) {
    render();
    return;
  }

  // Event
  triggerYearEvent(State.age);
  render();
  setTimeout(chainBadges, 50);
  saveGame();
}

// Realistic mortality model based loosely on a Gompertz curve.
// Returns the per-year probability of death given the player's current age,
// health, and lifestyle factors. Calibrated so the median lifespan lands
// around 78-82 years for an average-stat player, with very few making it
// past 95 and almost none past 105.
function computeDeathChance() {
  // Baseline mortality table by age — picks up steeply past 60
  let baseline;
  if      (State.age < 1)   baseline = 0.006;   // infant mortality
  else if (State.age < 5)   baseline = 0.0008;
  else if (State.age < 15)  baseline = 0.0003;  // childhood is very safe
  else if (State.age < 25)  baseline = 0.0009;  // accidents pick up
  else if (State.age < 35)  baseline = 0.0012;
  else if (State.age < 45)  baseline = 0.0024;
  else if (State.age < 55)  baseline = 0.0050;
  else if (State.age < 65)  baseline = 0.0110;
  else if (State.age < 75)  baseline = 0.0260;
  else if (State.age < 85)  baseline = 0.0650;  // ~1 in 15 per year in late 70s/early 80s
  else if (State.age < 95)  baseline = 0.1700;
  else if (State.age < 105) baseline = 0.3500;
  else                      baseline = 0.6500;  // 105+ is exceedingly rare

  // Health modifiers — extreme low health adds a lot, very high health subtracts a little
  const h = State.stats.health;
  let healthMod = 0;
  if (h < 5)       healthMod = 0.40;   // imminent death
  else if (h < 15) healthMod = 0.10;
  else if (h < 30) healthMod = 0.03;
  else if (h < 50) healthMod = 0.008;
  else if (h >= 85) healthMod = -0.003; // robust health gives a small edge

  // Lifestyle modifiers — addictions and chronic illness compound risk past midlife
  let lifestyleMod = 0;
  if (State.addictions.length) {
    lifestyleMod += State.addictions.length * (State.age >= 40 ? 0.012 : 0.004);
  }
  if (State.illnesses.length) {
    // Each chronic illness ~10-15% added risk after 50
    lifestyleMod += State.illnesses.length * (State.age >= 50 ? 0.014 : 0.004);
  }

  // Mental health: prolonged extreme low mood raises risk slightly (despair effects)
  if (State.stats.mood <= 5 && State.age >= 18) lifestyleMod += 0.01;

  // Combine. Cap below 1.0 — we never want to *guarantee* death, just make it likely.
  const total = baseline + healthMod + lifestyleMod;
  return Math.max(0, Math.min(0.98, total));
}

function die(causeOverride) {
  State.alive = false;
  let cause;
  if (causeOverride === "surrender") cause = "their own hand — they gave up";
  else if (causeOverride) cause = causeOverride;
  else if (State.stats.health < 5) cause = "poor health";
  else if (State.addictions.length) cause = "complications from addiction";
  else if (State.age > 90) cause = "old age";
  else cause = "natural causes";
  logEvent(`I died at age ${State.age} from ${cause}.`, "death");
  showAftermath("The End", buildLifeSummary(cause));
  render();
}

function buildLifeSummary(cause) {
  const lines = [
    `Lived to age ${State.age}.`,
    `Cause: ${cause}.`,
    State.job ? `Final job: ${State.job.title}.` : "Never held a job.",
    State.partner ? `Survived by ${State.partner.name}.` : "Died single.",
    State.children.length ? `Left behind ${State.children.length} child(ren).` : "No children.",
    `Net estate: ${money(netWorth())}.`,
    `Badges earned: ${State.badges.length} of ${GAME.badges.length}.`,
  ];
  return lines.join(" ");
}

/* ============ EVENT TRIGGER ============ */
function triggerYearEvent(age) {
  // AI Mode: every year-event is AI-generated, no preset events
  if (State.aiMode && State.apiKey) {
    // ~50% chance of an AI event each year (keeps things from spamming the API)
    if (Math.random() < 0.5) triggerAIEvent(age);
    return;
  }

  // Branching events (with choices) — show a dialog
  if (Math.random() < 0.92 && tryBranchingEvent(age)) return;
  // Narrative events — log silently, no dialog (bitlife-style)
  const pool = GAME.narrativeEvents.filter(e => age >= e.minAge && age <= e.maxAge);
  if (pool.length === 0) return;
  if (Math.random() < 0.25) return;
  const ev = pick(pool);
  const variantText = pick(ev.variants);
  if (ev.stats) applyStats(ev.stats);
  if (ev.money != null) applyStats({ money: typeof ev.money === "string" ? rollMoney(ev.money) : ev.money });
  if (ev.special === "addFriend") {
    const g = Math.random() < 0.5 ? "M" : "F";
    const name = pick(g === "M" ? GAME.constants.firstNamesM : GAME.constants.firstNamesF);
    State.friends.push({ name, gender: g, level: 70 });
  }
  logEvent(variantText);
}

function evalRequirement(req) {
  if (!req) return true;
  // Memory-based requirements
  if (typeof req === "string" && req.startsWith("memory:"))   return !!State.memory[req.slice(7)];
  if (typeof req === "string" && req.startsWith("nomemory:")) return !State.memory[req.slice(9)];
  switch (req) {
    case "partnerLowLevel": return State.partner && State.partner.level < 60;
    case "hasJob":          return !!State.job;
    case "married":         return State.partner && State.partner.married;
    case "single":          return !State.partner;
    case "hasFriends":      return State.friends.length > 0;
    case "hasChildren":     return State.children.length > 0;
    case "isRich":          return netWorth() >= 500000;
    case "isPoor":          return netWorth() < 1000 && !State.job;
    case "id_expired":       return State.governmentId && State.governmentId.expired;
    case "passport_expired": return State.passport && State.passport.expired;
  }
  return true;
}

function tryBranchingEvent(age) {
  const ageOk = e => age >= e.minAge && age <= e.maxAge && evalRequirement(e.requires);
  // Anti-repetition: exclude recently fired events
  let pool = GAME.branchingEvents.filter(e => ageOk(e) && !State.recentEvents.includes(e.id));
  // If the cooldown excluded everything (small pool for this age/req), fall back to the full eligible pool
  if (pool.length === 0) pool = GAME.branchingEvents.filter(ageOk);
  if (pool.length === 0) return false;
  const ev = pick(pool);
  // Track for anti-repetition (keep last 14)
  State.recentEvents.push(ev.id);
  if (State.recentEvents.length > 14) State.recentEvents.shift();
  const variant = pick(ev.variants);
  showOptions(variant.title, variant.body,
    variant.options.map(o => ({ label: o.label, run: () => executeOutcome(o.outcome) })),
    variant.aiContext);
  return true;
}

// Jail-only event pool. Always branching with options.
function triggerJailEvent() {
  const pool = GAME.jailEvents || [];
  if (pool.length === 0) return;
  if (Math.random() < 0.25) return; // 25% silent year
  const ev = pick(pool);
  const variant = pick(ev.variants);
  showOptions(variant.title, variant.body,
    variant.options.map(o => ({ label: o.label, run: () => executeOutcome(o.outcome) })),
    variant.aiContext);
}

/* ============ SUBVIEWS ============ */
function viewActivities() {
  showSubview("ACTIVITIES", body => {
    // === Custom Activity (AI) — at the top so it's discoverable ===
    const aiRow = document.createElement("div");
    aiRow.className = "row-item ai-activity-row" + (State.apiKey ? "" : " locked");
    aiRow.innerHTML = `
      <div class="row-text">
        <div class="row-title"><i data-lucide="sparkles" style="width:16px;height:16px;vertical-align:-3px;margin-right:6px;color:#7e3ec7;"></i>Custom Activity (AI)</div>
        <div class="row-desc">${State.apiKey ? "Describe anything you want to do — the AI handles the rest." : "Add an API key in the Menu to unlock."}</div>
      </div>
      <i data-lucide="chevron-right" class="row-arrow"></i>`;
    if (State.apiKey) {
      aiRow.onclick = () => {
        closeSubview();
        askAICustomAction(
          "What do you want to do? Describe it in your own words.",
          `custom_activity_age_${State.age}`
        );
      };
    } else {
      aiRow.onclick = () => {
        showAftermath("AI Locked", "Add an API key in the Menu to unlock Custom Activity (AI).");
      };
    }
    body.appendChild(aiRow);

    const order = ["Mind & Body","Education","Social","Romance","Adventure","Hobbies","Risky","Addictions","Buy","Pets","Self-Care","Sports"];
    const counts = {};
    for (const a of GAME.activities) counts[a.cat] = (counts[a.cat] || 0) + 1;

    for (const cat of order) {
      if (!counts[cat]) continue;
      const row = document.createElement("div");
      row.className = "row-item";
      row.innerHTML = `
        <div class="row-text">
          <div class="row-title">${cat}</div>
          <div class="row-desc">${counts[cat]} activities</div>
        </div>
        <i data-lucide="chevron-right" class="row-arrow"></i>`;
      row.onclick = () => viewActivityCategory(cat);
      body.appendChild(row);
    }

    // SURRENDER at the bottom
    const surr = document.createElement("div");
    surr.className = "form-section";
    surr.style.borderTop = "2px solid #eee";
    surr.innerHTML = `<h4>Out of Options</h4>`;
    const btn = document.createElement("button");
    btn.className = "danger";
    btn.style.width = "100%";
    btn.textContent = "Surrender";
    btn.onclick = () => {
      closeSubview();
      showOptions("Surrender", `Don't give up on ${State.firstName}.`, [
        { label: "Keep Going", run: () => {
            State.stats.mood = clamp(State.stats.mood + 5);
            logEvent("I almost gave up, but I kept going.", "good");
        }},
        { label: `Surrender, end ${State.firstName}'s life`, run: () => { die("surrender"); } },
      ]);
    };
    surr.appendChild(btn);
    body.appendChild(surr);
  });
}

// Open one category as a nested subview. Back returns to the categories list.
function viewActivityCategory(cat) {
  pushSubview(cat.toUpperCase(), body => {
    const acts = GAME.activities.filter(a => a.cat === cat);
    for (const a of acts) body.appendChild(activityRow(a));
  }, viewActivities);
}
function activityRow(act) {
  const row = document.createElement("div");
  const locked = State.age < act.minAge || (act.cost && act.cost > State.money + State.bank);
  row.className = "row-item" + (locked ? " locked" : "");
  let costHtml = "";
  if (act.cost) costHtml = `<div class="row-cost${act.cost >= 1000 ? " expensive" : ""}">${money(act.cost)}</div>`;

  // Addiction-aware labelling: if this activity starts/feeds an addiction
  // the player already has, change the title and description.
  let title = act.name;
  let desc  = act.desc;
  const addKey = act.special ? addictionKeyForSpecial(act.special) : null;
  if (addKey && State.addictions && State.addictions.includes(addKey)) {
    const def = ADDICTION_DEFS[addKey];
    if (def) {
      title = `${def.doVerb} / Quit ${def.label}`;
      desc  = `You're addicted to ${def.label}.`;
    }
  }

  row.innerHTML = `<div class="row-text"><div class="row-title">${title}</div><div class="row-desc">${desc}</div></div>${costHtml}`;
  if (!locked) row.onclick = () => { closeSubview(); doActivity(act); };
  return row;
}

function viewJail() {
  if (!State.inJail) return;
  showSubview("JAIL", body => {
    const status = document.createElement("div");
    status.className = "form-section";
    const j = State.inJail;
    const remaining = Math.max(0, j.sentence - j.served);
    status.innerHTML = `<h4>My Sentence</h4>
      <div class="info-row"><div>Crime</div><div class="v">${j.crime}</div></div>
      <div class="info-row"><div>Sentence</div><div class="v">${j.sentence} year(s)</div></div>
      <div class="info-row"><div>Served</div><div class="v">${j.served} year(s)</div></div>
      <div class="info-row"><div>Remaining</div><div class="v">${remaining} year(s)</div></div>
      <div class="info-row"><div>Behavior</div><div class="v">${j.behavior || 0}</div></div>`;
    body.appendChild(status);

    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = "Jail Activities";
    body.appendChild(label);
    for (const a of (GAME.jailActivities || [])) {
      const row = document.createElement("div");
      row.className = "row-item";
      row.innerHTML = `<div class="row-text"><div class="row-title">${a.name}</div><div class="row-desc">${a.desc}</div></div>`;
      row.onclick = () => { closeSubview(); doJailActivity(a); };
      body.appendChild(row);
    }
  });
}

function viewJob() {
  showSubview("JOB", body => {
    if (State.job) {
      const cur = document.createElement("div");
      cur.className = "form-section";
      cur.innerHTML = `
        <h4>Current Job</h4>
        <div class="info-row"><div>Title</div><div class="v">${State.job.title}</div></div>
        <div class="info-row"><div>Salary</div><div class="v">${money(State.job.salary)}</div></div>
        <div class="btn-row">
          <button id="askPromo">Ask for Promotion</button>
          <button class="danger" id="quitJob">Quit</button>
        </div>`;
      body.appendChild(cur);
      cur.querySelector("#askPromo").onclick = () => askPromotion();
      cur.querySelector("#quitJob").onclick = () => {
        State.job = null;
        logEvent("I quit my job.", "normal");
        closeSubview(); render();
      };
    } else {
      const label = document.createElement("div");
      label.className = "section-label";
      label.textContent = "Available Jobs";
      body.appendChild(label);
      for (const track of GAME.careerTracks) {
        const entry = track.levels[0];
        const locked = State.age < entry.minAge || State.stats.smarts < entry.minSmarts ||
                       (entry.minLooks && State.stats.looks < entry.minLooks);
        const row = document.createElement("div");
        row.className = "row-item" + (locked ? " locked" : "");
        row.innerHTML = `<div class="row-text"><div class="row-title">${entry.title}</div>
          <div class="row-desc">${track.name} — needs Smarts ${entry.minSmarts}+, Age ${entry.minAge}+</div></div>
          <div class="row-cost">${money(entry.salary)}/yr</div>`;
        if (!locked) row.onclick = () => {
          State.job = { trackId: track.id, level: 0, title: entry.title, salary: entry.salary };
          logEvent(`I got a job as a ${entry.title}.`, "good");
          closeSubview(); render();
        };
        body.appendChild(row);
      }
    }
  });
}
function askPromotion() {
  if (!State.job) return;
  const track = GAME.careerTracks.find(t => t.id === State.job.trackId);
  const nextLevel = State.job.level + 1;
  if (nextLevel >= track.levels.length) { showAftermath("Top Tier", "I'm already at the top of this track."); return; }
  const next = track.levels[nextLevel];
  if (State.stats.smarts < next.minSmarts || State.age < next.minAge) {
    showAftermath("Denied", "Boss said I'm not ready yet.");
    State.stats.mood = clamp(State.stats.mood - 3);
    return;
  }
  if (Math.random() < 0.5) {
    State.job = { trackId: track.id, level: nextLevel, title: next.title, salary: next.salary };
    logEvent(`I got promoted to ${next.title}.`, "good");
    showAftermath("Promoted", `New title: ${next.title}. New salary: ${money(next.salary)}.`);
  } else {
    State.stats.mood = clamp(State.stats.mood - 5);
    showAftermath("Denied", "They said maybe next year.");
  }
}

/* ============ SCHOOL / UNIVERSITY ============ */
// Subview for students. Replaces the Job tab while State.inSchool or State.inCollege.
// Provides school-flavored actions: study, socialize, join clubs, skip class, etc.
function viewSchool() {
  const isCollege = State.inCollege;
  const title = isCollege ? "UNIVERSITY" : "SCHOOL";
  showSubview(title, body => {
    // ---- Current school status header ----
    const stage =
      isCollege ? `College student (year ${(State.collegeYear || 0) + 1})`
      : State.age < 12 ? "Elementary student"
      : State.age < 14 ? "Middle school student"
      : "High school student";

    const head = document.createElement("div");
    head.className = "form-section";
    head.innerHTML = `
      <h4>Current Status</h4>
      <div class="info-row"><div>Stage</div><div class="v">${stage}</div></div>
      <div class="info-row"><div>Smarts</div><div class="v">${State.stats.smarts}</div></div>
      ${isCollege ? `<div class="info-row"><div>Major</div><div class="v">${State.collegeMajor || "Undeclared"}</div></div>` : ""}`;
    body.appendChild(head);

    // ---- Action list ----
    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = "What do you want to do?";
    body.appendChild(label);

    const actions = buildSchoolActions(isCollege);
    for (const act of actions) {
      const row = document.createElement("div");
      row.className = "row-item" + (act.locked ? " locked" : "");
      row.innerHTML = `<div class="row-text">
        <div class="row-title">${act.label}</div>
        <div class="row-desc">${act.desc}</div>
      </div>${act.cost ? `<div class="row-cost">${act.cost}</div>` : ""}`;
      if (!act.locked) {
        row.onclick = () => {
          closeSubview();
          act.run();
        };
      }
      body.appendChild(row);
    }

    // ---- Quit / drop out ----
    if (isCollege) {
      const drop = document.createElement("div");
      drop.className = "form-section";
      drop.innerHTML = `<div class="btn-row">
        <button class="danger" id="dropoutCollege">Drop Out</button>
      </div>`;
      body.appendChild(drop);
      drop.querySelector("#dropoutCollege").onclick = () => {
        if (!confirm("Drop out of college? You can re-enroll later.")) return;
        State.inCollege = false;
        State.collegeYear = 0;
        logEvent("I dropped out of college.", "bad");
        if (!State.memory) State.memory = {};
        State.memory.dropped_out = true;
        State.stats.mood = clamp(State.stats.mood - 5);
        closeSubview();
        render();
      };
    }
  });
}

// Build the list of school actions available right now.
function buildSchoolActions(isCollege) {
  const acts = [];

  // Study hard — raises smarts, costs mood
  acts.push({
    label: isCollege ? "Study hard for finals" : "Study hard",
    desc: "Books over fun. Smarts up, mood down.",
    run: () => {
      const smartsGain = isCollege ? 4 : 3;
      State.stats.smarts = clamp(State.stats.smarts + smartsGain);
      State.stats.mood   = clamp(State.stats.mood - 2);
      logEvent(isCollege ? "I hit the books hard." : "I studied for hours.", "good");
      showAftermath("Studied", `Smarts +${smartsGain}, Mood −2.`);
    },
  });

  // Make friends with classmates
  acts.push({
    label: "Hang out with classmates",
    desc: "Make a new friend. Maybe.",
    run: () => {
      if (Math.random() < 0.7) {
        const name = pick(GAME.constants.firstNamesM.concat(GAME.constants.firstNamesF));
        const gender = Math.random() < 0.5 ? "M" : "F";
        State.friends.push({ name, gender, age: State.age, level: 70 });
        State.stats.mood = clamp(State.stats.mood + 5);
        logEvent(`I made friends with ${name}.`, "good");
        showAftermath("New Friend", `${name} and I clicked. Mood +5.`);
      } else {
        State.stats.mood = clamp(State.stats.mood + 1);
        logEvent("I tried to make friends. Nothing clicked.", "normal");
        showAftermath("Awkward", "Nice people, no spark. Mood +1.");
      }
    },
  });

  // Join a club / sport
  acts.push({
    label: isCollege ? "Join a campus club" : "Join an after-school club",
    desc: "Find your people. Boost mood and smarts.",
    run: () => {
      const clubs = isCollege
        ? ["Debate Society", "Robotics Club", "Theater Group", "Student Government", "Astronomy Club", "Volunteer Corps"]
        : ["Chess Club", "Drama Club", "Science Fair Team", "Soccer Team", "Math League", "Band"];
      const club = pick(clubs);
      State.stats.mood   = clamp(State.stats.mood + 4);
      State.stats.smarts = clamp(State.stats.smarts + 2);
      logEvent(`I joined the ${club}.`, "good");
      if (!State.memory) State.memory = {};
      State.memory.joined_club = true;
      showAftermath(club, `I signed up. Mood +4, Smarts +2.`);
    },
  });

  // Interact with a specific teacher
  acts.push({
    label: isCollege ? "Visit a professor's office hours" : "Talk to a teacher after class",
    desc: "Build a real relationship with an educator.",
    run: () => {
      const roll = Math.random();
      if (roll < 0.5) {
        State.stats.smarts = clamp(State.stats.smarts + 3);
        State.stats.mood   = clamp(State.stats.mood + 3);
        logEvent(isCollege ? "My professor became a real mentor." : "My teacher took a real interest in me.", "good");
        if (!State.memory) State.memory = {};
        State.memory.had_mentor = true;
        showAftermath("Mentor", "Smarts +3, Mood +3.");
      } else {
        State.stats.smarts = clamp(State.stats.smarts + 1);
        logEvent("I asked some good questions. Learned a bit.", "normal");
        showAftermath("Productive Chat", "Smarts +1.");
      }
    },
  });

  // Skip class — risky
  acts.push({
    label: isCollege ? "Skip lecture" : "Skip class",
    desc: "Risky. Mood up, smarts down. Might get caught.",
    run: () => {
      State.stats.mood   = clamp(State.stats.mood + 4);
      State.stats.smarts = clamp(State.stats.smarts - 2);
      if (Math.random() < 0.3) {
        logEvent("I got caught skipping. Detention.", "bad");
        State.stats.mood = clamp(State.stats.mood - 6);
        showAftermath("Caught!", "Mood +4 then −6, Smarts −2.");
      } else {
        logEvent("I skipped and got away with it.", "normal");
        showAftermath("Skipped", "Mood +4, Smarts −2.");
      }
    },
  });

  // College-only: choose/change major, ask for scholarship
  if (isCollege) {
    acts.push({
      label: State.collegeMajor ? "Change major" : "Declare a major",
      desc: State.collegeMajor ? `Currently studying ${State.collegeMajor}.` : "Pick what you want to study.",
      run: () => {
        const majors = ["Computer Science", "Business", "Psychology", "Engineering", "English Literature", "Biology", "Art History", "Mathematics", "Political Science", "Philosophy"];
        const choices = majors.map(m => ({ label: m, outcome: { _setMajor: m } }));
        showOptions("Choose a Major", "What will you study?", choices);
      },
    });
    acts.push({
      label: "Apply for a scholarship",
      desc: "Cash to ease the tuition burden.",
      locked: State.stats.smarts < 70,
      run: () => {
        if (Math.random() < State.stats.smarts / 100) {
          const amount = 5000 + Math.floor(Math.random() * 15000);
          State.money += amount;
          logEvent(`I won a scholarship worth ${money(amount)}.`, "good");
          if (!State.memory) State.memory = {};
          State.memory.scholarship = true;
          showAftermath("Awarded!", `${money(amount)} added to my account.`);
        } else {
          logEvent("My scholarship application was denied.", "bad");
          showAftermath("Denied", "Maybe next semester.");
        }
      },
    });
    acts.push({
      label: "Pull an all-nighter",
      desc: "Cram everything. Big smarts, big health hit.",
      run: () => {
        State.stats.smarts = clamp(State.stats.smarts + 5);
        State.stats.health = clamp(State.stats.health - 4);
        State.stats.mood   = clamp(State.stats.mood - 3);
        logEvent("I pulled an all-nighter studying.", "normal");
        showAftermath("All-Nighter", "Smarts +5, Health −4, Mood −3.");
      },
    });
  } else {
    // School-only: try out for a sport, run for class president
    acts.push({
      label: "Try out for a sport",
      desc: "Make the team and boost health and confidence.",
      locked: State.age < 8,
      run: () => {
        if (Math.random() < 0.55) {
          State.stats.health = clamp(State.stats.health + 4);
          State.stats.looks  = clamp(State.stats.looks + 2);
          State.stats.mood   = clamp(State.stats.mood + 4);
          logEvent("I made the team!", "good");
          if (!State.memory) State.memory = {};
          State.memory.team_athlete = true;
          showAftermath("Made the Team!", "Health +4, Looks +2, Mood +4.");
        } else {
          State.stats.mood = clamp(State.stats.mood - 3);
          logEvent("I didn't make the team. Maybe next year.", "bad");
          showAftermath("Cut", "Mood −3.");
        }
      },
    });
    acts.push({
      label: "Run for class president",
      desc: "High risk, high reward.",
      locked: State.age < 10,
      run: () => {
        const winChance = (State.stats.looks + State.stats.smarts) / 250;
        if (Math.random() < winChance) {
          State.stats.mood   = clamp(State.stats.mood + 8);
          State.stats.smarts = clamp(State.stats.smarts + 2);
          logEvent("I was elected class president!", "good");
          if (!State.memory) State.memory = {};
          State.memory.class_president = true;
          showAftermath("Elected!", "Mood +8, Smarts +2.");
        } else {
          State.stats.mood = clamp(State.stats.mood - 5);
          logEvent("I lost the election.", "bad");
          showAftermath("Defeated", "Mood −5.");
        }
      },
    });
  }

  // Bully someone / stand up to a bully
  acts.push({
    label: "Stand up to a bully",
    desc: "Risky but right.",
    run: () => {
      const roll = Math.random();
      if (roll < 0.5) {
        State.stats.mood = clamp(State.stats.mood + 6);
        logEvent("I stood up to a bully. People noticed.", "good");
        if (!State.memory) State.memory = {};
        State.memory.brave = true;
        showAftermath("Hero Moment", "Mood +6.");
      } else if (roll < 0.85) {
        State.stats.health = clamp(State.stats.health - 3);
        State.stats.mood   = clamp(State.stats.mood + 2);
        logEvent("I confronted a bully. Got pushed around but stood my ground.", "normal");
        showAftermath("Held My Ground", "Health −3, Mood +2.");
      } else {
        State.stats.health = clamp(State.stats.health - 6);
        State.stats.mood   = clamp(State.stats.mood - 4);
        logEvent("The bully won this round.", "bad");
        showAftermath("Beaten", "Health −6, Mood −4.");
      }
    },
  });

  // Cheat on a test
  acts.push({
    label: "Cheat on a test",
    desc: "Quick smarts boost. Risk of getting caught.",
    run: () => {
      if (Math.random() < 0.3) {
        State.stats.smarts = clamp(State.stats.smarts - 5);
        State.stats.mood   = clamp(State.stats.mood - 8);
        logEvent("I got caught cheating. Major consequences.", "bad");
        if (!State.memory) State.memory = {};
        State.memory.caught_cheating = true;
        showAftermath("Caught Cheating", "Smarts −5, Mood −8.");
      } else {
        State.stats.smarts = clamp(State.stats.smarts + 2);
        logEvent("I cheated and got away with it.", "normal");
        showAftermath("Got Away With It", "Smarts +2 (on paper).");
      }
    },
  });

  return acts;
}

function viewFinance() {
  showSubview("FINANCE", body => {
    const sec = document.createElement("div");
    sec.className = "form-section";
    sec.innerHTML = `
      <h4>Net Worth</h4>
      <div class="info-row"><div>Cash</div><div class="v">${money(State.money)}</div></div>
      <div class="info-row"><div>Bank</div><div class="v">${money(State.bank)}</div></div>
      <div class="info-row"><div>Stocks</div><div class="v">${money(State.investments.stocks)}</div></div>
      <div class="info-row"><div>Crypto</div><div class="v">${money(State.investments.crypto)}</div></div>
      <div class="info-row"><div>Real Estate</div><div class="v">${money(State.investments.realEstate)}</div></div>
      <div class="info-row"><div><strong>Total</strong></div><div class="v"><strong>${money(netWorth())}</strong></div></div>`;
    body.appendChild(sec);
    const acts = document.createElement("div");
    acts.className = "form-section";
    acts.innerHTML = `
      <h4>Actions</h4>
      <div class="btn-row">
        <button id="buyStocks">Buy Stocks ($1k)</button>
        <button id="sellStocks">Sell Stocks</button>
      </div>
      <div class="btn-row">
        <button id="buyCrypto">Buy Crypto ($500)</button>
        <button id="sellCrypto">Sell Crypto</button>
      </div>
      <div class="btn-row">
        <button id="depositCash">Deposit Cash</button>
        <button id="withdrawCash">Withdraw $500</button>
      </div>
      <div class="btn-row">
        <button id="playLottery">Play Lottery ($10)</button>
      </div>`;
    body.appendChild(acts);
    acts.querySelector("#buyStocks").onclick   = () => { if (spend(1000)) { State.investments.stocks += 1000; viewFinance(); } else showAftermath("Can't Afford", "Not enough cash."); };
    acts.querySelector("#sellStocks").onclick  = () => { State.money += State.investments.stocks; State.investments.stocks = 0; viewFinance(); };
    acts.querySelector("#buyCrypto").onclick   = () => { if (spend(500)) { State.investments.crypto += 500; viewFinance(); } else showAftermath("Can't Afford","Not enough cash."); };
    acts.querySelector("#sellCrypto").onclick  = () => { State.money += State.investments.crypto; State.investments.crypto = 0; viewFinance(); };
    acts.querySelector("#depositCash").onclick = () => { State.bank += State.money; State.money = 0; viewFinance(); };
    acts.querySelector("#withdrawCash").onclick= () => { if (State.bank >= 500) { State.bank -= 500; State.money += 500; viewFinance(); } else showAftermath("Empty","Bank account is too low."); };
    acts.querySelector("#playLottery").onclick = () => {
      if (!spend(10)) { showAftermath("No Cash","Need $10 to play."); return; }
      if (Math.random() < 0.001) {
        State.bank += 1000000;
        logEvent("I WON THE LOTTERY! One million dollars!", "good");
        showAftermath("JACKPOT!", "I won $1,000,000 in the lottery!");
      } else if (Math.random() < 0.05) {
        const win = Math.floor(Math.random() * 200) + 50;
        State.money += win;
        showAftermath("Small Win", `Won ${money(win)}.`);
      } else {
        showAftermath("No Luck", "Better luck next year.");
      }
      render();
    };
  });
}

function viewRelations() {
  showSubview("RELATIONS", body => {
    if (State.parents) {
      sectionLabel(body, "Parents");
      addPersonRow(body, State.parents.mother, "parent");
      addPersonRow(body, State.parents.father, "parent");
    }
    if (State.siblings.length) {
      sectionLabel(body, "Siblings");
      for (const s of State.siblings) addPersonRow(body, s, "sibling");
    }
    if (State.partner) {
      sectionLabel(body, "Partner");
      addPersonRow(body, State.partner, "partner");
    }
    if (State.children.length) {
      sectionLabel(body, "Children");
      for (const c of State.children) addPersonRow(body, c, "child");
    }
    if (State.friends.length) {
      sectionLabel(body, "Friends");
      for (const f of State.friends) addPersonRow(body, f, "friend");
    }
    if (State.pets.length) {
      sectionLabel(body, "Pets");
      for (const p of State.pets) addPersonRow(body, p, "pet");
    }
  });
}
function sectionLabel(body, text) {
  const el = document.createElement("div");
  el.className = "section-label";
  el.textContent = text;
  body.appendChild(el);
}

function addPersonRow(body, person, type) {
  const row = document.createElement("div");
  row.className = "row-item";
  const level = person.level != null ? person.level : 75;
  let detail = "";
  if      (type === "partner") detail = `${person.married ? "Married" : person.engaged ? "Engaged" : "Dating"} • ${level}% close`;
  else if (type === "child")   detail = `Age ${person.age} • ${level}% close`;
  else if (type === "friend")  detail = `Friend • ${level}% close`;
  else if (type === "pet")     detail = `${person.kind || "Pet"} • ${level}% close`;
  else if (type === "parent")  detail = `${person.role === "mother" ? "Mother" : "Father"} • ${level}% close`;
  else if (type === "sibling") detail = `${person.gender === "M" ? "Brother" : "Sister"} • ${level}% close`;
  row.innerHTML = `<div class="row-text"><div class="row-title">${person.name}</div><div class="row-desc">${detail}</div></div>`;
  row.onclick = () => showPersonActions(person, type);
  body.appendChild(row);
}

/* ============ PER-PERSON ACTIONS ============ */
function showPersonActions(person, type) {
  const actions = personActionsFor(person, type);
  pushSubview(person.name.toUpperCase(), body => {
    // Header with person info + closeness meter
    const status = document.createElement("div");
    status.className = "form-section";
    status.innerHTML = `<h4>About ${person.name}</h4>` + buildPersonInfo(person, type);
    body.appendChild(status);

    // Section label
    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = "Actions";
    body.appendChild(label);

    // Action rows (activity-style)
    for (const a of actions) body.appendChild(personActionRow(a));
  }, viewRelations);
}

function buildPersonInfo(person, type) {
  const rows = [];
  if      (type === "parent")  rows.push(`<div class="info-row"><div>Relationship</div><div class="v">${person.role === "mother" ? "Mother" : "Father"}</div></div>`);
  else if (type === "sibling") rows.push(`<div class="info-row"><div>Relationship</div><div class="v">${person.gender === "M" ? "Brother" : "Sister"}</div></div>`);
  else if (type === "partner") rows.push(`<div class="info-row"><div>Relationship</div><div class="v">${person.married ? "Married" : person.engaged ? "Engaged" : "Dating"}</div></div>`);
  else if (type === "child")   rows.push(`<div class="info-row"><div>Age</div><div class="v">${person.age}</div></div>`);
  else if (type === "friend")  rows.push(`<div class="info-row"><div>Relationship</div><div class="v">Friend</div></div>`);
  else if (type === "pet")     rows.push(`<div class="info-row"><div>Type</div><div class="v">${person.kind || "Pet"}</div></div>`);

  // Closeness meter — green/yellow/red bar
  const level = person.level != null ? clamp(person.level) : 75;
  const cls = level < 30 ? "low" : level < 60 ? "mid" : "";
  rows.push(`
    <div class="rel-meter-row">
      <div class="rel-meter-label">Closeness</div>
      <div class="rel-meter-bar"><div class="rel-meter-fill ${cls}" style="width:${level}%">${level}%</div></div>
    </div>`);
  return rows.join("");
}

function personActionRow(action) {
  const row = document.createElement("div");
  const locked = !!action.locked;
  row.className = "row-item" + (locked ? " locked" : "");
  let costHtml = "";
  if (action.cost) costHtml = `<div class="row-cost${action.cost >= 1000 ? " expensive" : ""}">${money(action.cost)}</div>`;
  row.innerHTML = `<div class="row-text">
    <div class="row-title">${action.label}</div>
    ${action.desc ? `<div class="row-desc">${action.desc}</div>` : ""}
  </div>${costHtml}`;
  if (!locked) {
    row.onclick = () => {
      closeSubview();
      try { action.run(); } catch (err) { console.error(err); }
      render();
    };
  }
  return row;
}

function personActionsFor(person, type) {
  switch (type) {
    case "parent":  return parentActions(person);
    case "sibling": return siblingActions(person);
    case "partner": return partnerActions(person);
    case "child":   return childActions(person);
    case "friend":  return friendActions(person);
    case "pet":     return petActions(person);
  }
  return [];
}

// Build an info-box and show an aftermath for a person action.
// `deltas` is {closeness, mood, health, money, ...} — only non-zero keys are shown.
function personResult(title, text, deltas, extra) {
  const info = [];
  if (deltas) {
    if (typeof deltas.closeness === "number" && deltas.closeness !== 0)
      info.push({ label: "Closeness", value: (deltas.closeness > 0 ? "+" : "") + deltas.closeness });
    if (typeof deltas.mood === "number" && deltas.mood !== 0)
      info.push({ label: "Mood", value: (deltas.mood > 0 ? "+" : "") + deltas.mood });
    if (typeof deltas.health === "number" && deltas.health !== 0)
      info.push({ label: "Health", value: (deltas.health > 0 ? "+" : "") + deltas.health });
    if (typeof deltas.money === "number" && deltas.money !== 0)
      info.push({ label: "Money", value: (deltas.money > 0 ? "+$" : "-$") + Math.abs(deltas.money).toLocaleString() });
  }
  if (extra) info.push(...extra);
  showAftermath(title, text, { info });
}

function parentActions(p) {
  const rel = p.role;
  return [
    { label: `Call my ${rel}`, desc: "A quick phone check-in", run: () => {
        p.level = clamp(p.level + 3);
        State.stats.mood = clamp(State.stats.mood + 2);
        logEvent(`I called my ${rel}.`);
        personResult("Called", `I called my ${rel} for a quick chat.`,
          { closeness: 3, mood: 2 });
    }},
    { label: `Visit my ${rel}`, desc: "Sunday dinner, maybe", run: () => {
        p.level = clamp(p.level + 6);
        State.stats.mood = clamp(State.stats.mood + 4);
        logEvent(`I visited my ${rel}.`);
        personResult("Visited", `Spent the afternoon at my ${rel}'s place.`,
          { closeness: 6, mood: 4 });
    }},
    { label: `Ask my ${rel} for money`, desc: "Closeness affects the odds", run: () => {
        // Multi-option sub-dialog: pick how much to ask for
        showOptions("Ask for Money", `How much should I ask ${p.name} for?`, [
          { label: "$100 small loan",        run: () => askParentForMoney(p, 100,   0.85) },
          { label: "$1,000 for an emergency",run: () => askParentForMoney(p, 1000,  0.55) },
          { label: "$10,000 — big help",     run: () => askParentForMoney(p, 10000, 0.30) },
          { label: "Never mind", run: () => {} },
        ]);
    }},
    { label: `Argue with my ${rel}`, desc: "Voices raised, both lose", run: () => {
        p.level = clamp(p.level - 12);
        State.stats.mood = clamp(State.stats.mood - 4);
        logEvent(`I argued with my ${rel}. Tense.`, "bad");
        personResult("Argument", `Voices raised. The fight's going to linger.`,
          { closeness: -12, mood: -4 },
          [{ label: "Reason", value: "Old grudges" }]);
    }},
    { label: `Insult my ${rel}`, desc: "Burns bridges fast", run: () => {
        p.level = clamp(p.level - 25);
        State.stats.mood = clamp(State.stats.mood - 7);
        logEvent(`I insulted my ${rel}. They cut contact.`, "bad");
        personResult("Insulted", `I went too far. My ${rel} won't talk to me.`,
          { closeness: -25, mood: -7 },
          [{ label: "Reason", value: "I said the worst thing" }]);
    }},
    { label: `Buy a gift for my ${rel}`, desc: "A thoughtful gesture", cost: 150, run: () => {
        if (!spend(150)) { showAftermath("Can't Afford", "Not enough cash for a gift."); return; }
        p.level = clamp(p.level + 10);
        State.stats.mood = clamp(State.stats.mood + 5);
        logEvent(`I gave my ${rel} a thoughtful gift.`, "good");
        personResult("Gift Given", `My ${rel} was genuinely touched.`,
          { closeness: 10, mood: 5, money: -150 });
    }},
    { label: `Cook for my ${rel}`, desc: "A whole-day affair", run: () => {
        p.level = clamp(p.level + 7);
        State.stats.mood = clamp(State.stats.mood + 4);
        logEvent(`I cooked dinner for my ${rel}.`, "good");
        personResult("Home Cooking", `Cooked an elaborate meal for my ${rel}.`,
          { closeness: 7, mood: 4 });
    }},
    { label: `Move in with my ${rel}`, desc: "Save on rent, cost on pride", run: () => {
        p.level = clamp(p.level + 5);
        State.stats.mood = clamp(State.stats.mood - 2);
        State.bank += 500;
        logEvent(`I moved back in with my ${rel}.`, "bad");
        personResult("Back Home", `My ${rel} took me in. Embarrassing but cheaper.`,
          { closeness: 5, mood: -2, money: 500 },
          [{ label: "Reason", value: "Rent was killing me" }]);
    }},
    { label: `Take my ${rel} to a fancy dinner`, desc: "All-out treat", cost: 200, run: () => {
        if (!spend(200)) { showAftermath("Can't Afford", "Dinner wasn't in the budget."); return; }
        p.level = clamp(p.level + 12);
        State.stats.mood = clamp(State.stats.mood + 6);
        logEvent(`I treated my ${rel} to a fancy dinner.`, "good");
        personResult("Fancy Dinner", `An evening at the best place in town.`,
          { closeness: 12, mood: 6, money: -200 });
    }},
    { label: `Reconcile with my ${rel}`, desc: "Patch things up", run: () => {
        p.level = clamp(p.level + 15);
        State.stats.mood = clamp(State.stats.mood + 5);
        logEvent(`I reconciled with my ${rel}.`, "good");
        personResult("Reconciled", `We talked it out. Things feel lighter.`,
          { closeness: 15, mood: 5 });
    }},
    { label: `Have a heart-to-heart`, desc: "Long honest conversation", run: () => {
        p.level = clamp(p.level + 8);
        State.stats.mood = clamp(State.stats.mood + 5);
        logEvent(`I had a heart-to-heart with my ${rel}.`, "good");
        personResult("Heart to Heart", `Hours of real conversation. Worth it.`,
          { closeness: 8, mood: 5 });
    }},
    { label: `Cut off my ${rel}`, desc: "End the relationship", run: () => {
        p.level = clamp(p.level - 50);
        State.stats.mood = clamp(State.stats.mood - 8);
        logEvent(`I cut off contact with my ${rel}.`, "bad");
        personResult("Cut Off", `That's it. I'm done.`,
          { closeness: -50, mood: -8 },
          [{ label: "Reason", value: "Years of pent-up resentment" }]);
    }},
  ];
}

// Sub-dialog handler for "Ask parent for money" branches.
function askParentForMoney(p, amount, baseChance) {
  // Closeness bumps the success rate. Larger asks have a bigger penalty for failure.
  const chance = Math.min(0.95, baseChance + p.level / 400);
  if (Math.random() < chance) {
    State.money += amount;
    p.level = clamp(p.level - 4);
    logEvent(`My ${p.role} gave me ${money(amount)}.`, "good");
    personResult("Loaned", `My ${p.role} slipped me ${money(amount)} without a fight.`,
      { closeness: -4, money: amount },
      [{ label: "Asked for", value: money(amount) }]);
  } else {
    p.level = clamp(p.level - 8);
    State.stats.mood = clamp(State.stats.mood - 3);
    logEvent(`My ${p.role} said no.`, "bad");
    personResult("Refused", `My ${p.role} said no. The ask landed badly.`,
      { closeness: -8, mood: -3 },
      [{ label: "Asked for", value: money(amount) }, { label: "Reason", value: "Too much / too often" }]);
  }
}

function siblingActions(p) {
  const rel = p.gender === "M" ? "brother" : "sister";
  return [
    { label: `Call ${p.name}`, desc: "Phone catchup", run: () => {
        p.level = clamp(p.level + 3);
        State.stats.mood = clamp(State.stats.mood + 2);
        logEvent(`I called my ${rel}, ${p.name}.`);
        personResult("Called", `Quick catch-up with ${p.name}.`,
          { closeness: 3, mood: 2 });
    }},
    { label: `Hang out with ${p.name}`, desc: "A whole afternoon", run: () => {
        p.level = clamp(p.level + 6);
        State.stats.mood = clamp(State.stats.mood + 4);
        logEvent(`I spent the day with my ${rel} ${p.name}.`);
        personResult("Hung Out", `An afternoon with ${p.name}. Good times.`,
          { closeness: 6, mood: 4 });
    }},
    { label: `Argue with ${p.name}`, desc: "Sibling fights still hurt", run: () => {
        p.level = clamp(p.level - 10);
        State.stats.mood = clamp(State.stats.mood - 3);
        logEvent(`I had a sibling fight with ${p.name}.`, "bad");
        personResult("Fought", `Old sibling resentments boiled over.`,
          { closeness: -10, mood: -3 },
          [{ label: "Reason", value: "Childhood baggage" }]);
    }},
    { label: `Prank ${p.name}`, desc: "60% it lands well", run: () => {
        if (Math.random() < 0.6) {
          p.level = clamp(p.level + 5);
          State.stats.mood = clamp(State.stats.mood + 4);
          logEvent(`My prank on ${p.name} landed perfectly.`);
          personResult("Prank Landed", `${p.name} laughed for an hour.`,
            { closeness: 5, mood: 4 });
        } else {
          p.level = clamp(p.level - 8);
          State.stats.mood = clamp(State.stats.mood - 3);
          logEvent(`My prank on ${p.name} backfired.`, "bad");
          personResult("Prank Failed", `${p.name} did NOT think it was funny.`,
            { closeness: -8, mood: -3 });
        }
    }},
    { label: `Help ${p.name} with something`, desc: "Always a favor banked", run: () => {
        p.level = clamp(p.level + 8);
        State.stats.mood = clamp(State.stats.mood + 3);
        logEvent(`I helped ${p.name} out.`, "good");
        personResult("Helped Out", `${p.name} owes me one now.`,
          { closeness: 8, mood: 3 });
    }},
    { label: `Compete with ${p.name}`, desc: "Who's better?", run: () => {
        if (Math.random() < 0.5) {
          p.level = clamp(p.level - 3);
          State.stats.mood = clamp(State.stats.mood + 5);
          logEvent(`I beat ${p.name} in our latest competition.`);
          personResult("Won", `Beat ${p.name}. They're going to hear about it.`,
            { closeness: -3, mood: 5 });
        } else {
          p.level = clamp(p.level - 5);
          State.stats.mood = clamp(State.stats.mood - 4);
          logEvent(`${p.name} beat me. Again.`, "bad");
          personResult("Lost", `${p.name} won. Again.`,
            { closeness: -5, mood: -4 });
        }
    }},
    { label: `Give ${p.name} a birthday gift`, desc: "Sibling solidarity", cost: 80, run: () => {
        if (!spend(80)) { showAftermath("Can't Afford", "No money for a gift."); return; }
        p.level = clamp(p.level + 10);
        State.stats.mood = clamp(State.stats.mood + 3);
        logEvent(`I got ${p.name} a birthday gift.`, "good");
        personResult("Birthday Gift", `${p.name} loved the gift.`,
          { closeness: 10, mood: 3, money: -80 });
    }},
    { label: `Confide a secret in ${p.name}`, desc: "Trust them with it", run: () => {
        p.level = clamp(p.level + 12);
        State.stats.mood = clamp(State.stats.mood + 4);
        logEvent(`I confided a secret in ${p.name}.`);
        personResult("Confided", `${p.name} swore to keep my secret.`,
          { closeness: 12, mood: 4 });
    }},
    { label: `Take ${p.name} on a trip`, desc: "Sibling bonding vacation", cost: 1500, run: () => {
        if (!spend(1500)) { showAftermath("Can't Afford", "Trips aren't cheap."); return; }
        p.level = clamp(p.level + 18);
        State.stats.mood = clamp(State.stats.mood + 8);
        logEvent(`${p.name} and I took a sibling trip.`, "good");
        personResult("Trip Together", `Five days, two cities, a thousand memories.`,
          { closeness: 18, mood: 8, money: -1500 });
    }},
    { label: `Cut off ${p.name}`, desc: "Done with the drama", run: () => {
        p.level = clamp(p.level - 50);
        State.stats.mood = clamp(State.stats.mood - 6);
        logEvent(`I cut off my ${rel} ${p.name}.`, "bad");
        personResult("Cut Off", `I cut ${p.name} off entirely.`,
          { closeness: -50, mood: -6 },
          [{ label: "Reason", value: "Too much drama" }]);
    }},
  ];
}

function partnerActions(p) {
  const married = !!p.married;
  const engaged = !!p.engaged;
  return [
    { label: `Date night with ${p.name}`, desc: "Dinner and a movie", cost: 100, run: () => {
        if (!spend(100)) { showAftermath("Can't Afford","Date nights cost money."); return; }
        p.level = clamp(p.level + 8); State.stats.mood = clamp(State.stats.mood + 4);
        logEvent(`Date night with ${p.name}.`, "good");
        personResult("Date Night", `Lovely evening with ${p.name}.`,
          { closeness: 8, mood: 4, money: -100 });
    }},
    { label: `Surprise gift for ${p.name}`, desc: "Just because", cost: 50, run: () => {
        if (!spend(50)) { showAftermath("Can't Afford","Not enough cash."); return; }
        p.level = clamp(p.level + 6); State.stats.mood = clamp(State.stats.mood + 3);
        logEvent(`I surprised ${p.name} with a gift.`, "good");
        personResult("Surprise Gift", `${p.name}'s face lit up.`,
          { closeness: 6, mood: 3, money: -50 });
    }},
    { label: `Cook for ${p.name}`, desc: "Romantic homemade meal", run: () => {
        p.level = clamp(p.level + 4); State.stats.mood = clamp(State.stats.mood + 3);
        logEvent(`I cooked dinner for ${p.name}.`, "good");
        personResult("Home Cooked", `Romantic dinner at home.`, { closeness: 4, mood: 3 });
    }},
    { label: `Compliment ${p.name}`, desc: "Small words, big lift", run: () => {
        p.level = clamp(p.level + 4); State.stats.mood = clamp(State.stats.mood + 2);
        logEvent(`I complimented ${p.name}.`);
        personResult("Complimented", `${p.name} blushed and thanked me.`,
          { closeness: 4, mood: 2 });
    }},
    { label: `Have a deep talk with ${p.name}`, desc: "Hours of real conversation", run: () => {
        p.level = clamp(p.level + 7); State.stats.mood = clamp(State.stats.mood + 4);
        logEvent(`${p.name} and I had a long, honest talk.`, "good");
        personResult("Deep Talk", `Real conversation. Real connection.`,
          { closeness: 7, mood: 4 });
    }},
    { label: `Plan a vacation with ${p.name}`, desc: "Time away together", cost: 2000, run: () => {
        if (!spend(2000)) { showAftermath("Can't Afford","Vacations aren't cheap."); return; }
        p.level = clamp(p.level + 15); State.stats.mood = clamp(State.stats.mood + 10);
        logEvent(`${p.name} and I took a vacation.`, "good");
        personResult("Vacation", `A week away from everything with ${p.name}.`,
          { closeness: 15, mood: 10, money: -2000 });
    }},
    { label: `Couples therapy`, desc: "Work it out professionally", cost: 250, run: () => {
        if (!spend(250)) { showAftermath("Can't Afford","Therapy isn't free."); return; }
        p.level = clamp(p.level + 12); State.stats.mood = clamp(State.stats.mood + 3);
        logEvent(`${p.name} and I went to couples therapy.`, "good");
        personResult("Couples Therapy", `Twelve sessions later, things are better.`,
          { closeness: 12, mood: 3, money: -250 });
    }},
    { label: `Propose to ${p.name}`, desc: engaged || married ? "Already past this point" : "Get on one knee", cost: 3000, locked: engaged || married, run: () => propose() },
    { label: `Marry ${p.name}`, desc: !engaged ? "Need to propose first" : married ? "Already married" : "Walk down the aisle", cost: 15000, locked: married || !engaged, run: () => planWedding() },
    { label: `Try for a baby with ${p.name}`, desc: !married ? "Need to be married" : "Make a little human", locked: !married, run: () => tryForBaby() },
    { label: `Argue with ${p.name}`, desc: "Cool tempers, hot words", run: () => {
        p.level = clamp(p.level - 10); State.stats.mood = clamp(State.stats.mood - 4);
        logEvent(`I argued with ${p.name}.`, "bad");
        personResult("Argued", `Big fight with ${p.name}. The silence after was worse.`,
          { closeness: -10, mood: -4 }, [{ label: "Reason", value: "Small thing, big feelings" }]);
    }},
    { label: `Cheat on ${p.name}`, desc: !married ? "Need to be married for it to count" : "Risk everything", locked: !married, run: () => haveAffair() },
    { label: married ? `Divorce ${p.name}` : `Break up with ${p.name}`, desc: married ? "Splits the bank in half" : "It's over", run: () => {
        const name = p.name;
        const moneyDelta = married ? -Math.floor(State.bank / 2) : 0;
        if (married) State.bank = Math.floor(State.bank / 2);
        State.partner = null;
        State.stats.mood = clamp(State.stats.mood - 12);
        logEvent(married ? `I divorced ${name}.` : `I broke up with ${name}.`, "bad");
        personResult(married ? "Divorced" : "Broken Up", `${name} is gone.`,
          { mood: -12, money: moneyDelta },
          married ? [{ label: "Split", value: "Half my savings" }] : null);
    }},
  ];
}

function childActions(p) {
  return [
    { label: `Play with ${p.name}`, desc: "Quality time", run: () => {
        p.level = clamp(p.level + 5); State.stats.mood = clamp(State.stats.mood + 5);
        logEvent(`I played with my child ${p.name}.`);
        personResult("Quality Time", `Played with ${p.name} for hours.`, { closeness: 5, mood: 5 });
    }},
    { label: `Read ${p.name} a bedtime story`, desc: "Build the imagination", run: () => {
        p.level = clamp(p.level + 7); State.stats.mood = clamp(State.stats.mood + 4);
        logEvent(`I read ${p.name} a bedtime story.`, "good");
        personResult("Story Time", `${p.name} drifted off mid-story.`, { closeness: 7, mood: 4 });
    }},
    { label: `Help ${p.name} with schoolwork`, desc: "Boost their smarts", locked: p.age < 6, run: () => {
        p.level = clamp(p.level + 6); State.stats.mood = clamp(State.stats.mood + 3);
        logEvent(`I helped ${p.name} with schoolwork.`, "good");
        personResult("Homework Help", `${p.name} actually got it.`, { closeness: 6, mood: 3 });
    }},
    { label: `Give ${p.name} pocket money`, desc: "Small allowance", cost: 50, locked: p.age < 6, run: () => {
        if (!spend(50)) { showAftermath("Can't Afford","No cash for allowance."); return; }
        p.level = clamp(p.level + 4); State.stats.mood = clamp(State.stats.mood + 3);
        logEvent(`I gave ${p.name} some pocket money.`);
        personResult("Allowance", `${p.name} pocketed the cash and ran.`, { closeness: 4, mood: 3, money: -50 });
    }},
    { label: `Scold ${p.name}`, desc: "Discipline, sometimes too harsh", run: () => {
        p.level = clamp(p.level - 8); State.stats.mood = clamp(State.stats.mood - 3);
        logEvent(`I scolded ${p.name}.`, "bad");
        personResult("Scolded", `${p.name} stomped off to their room.`,
          { closeness: -8, mood: -3 }, [{ label: "Reason", value: "They acted up" }]);
    }},
    { label: `Take ${p.name} out for the day`, desc: "Activities and snacks", cost: 80, run: () => {
        if (!spend(80)) { showAftermath("Can't Afford","Not enough cash."); return; }
        p.level = clamp(p.level + 10); State.stats.mood = clamp(State.stats.mood + 6);
        logEvent(`I took ${p.name} out for the day.`, "good");
        personResult("Family Day", `${p.name} had a blast.`, { closeness: 10, mood: 6, money: -80 });
    }},
    { label: `Teach ${p.name} a skill`, desc: "Cooking, fixing things, riding a bike", locked: p.age < 4, run: () => {
        p.level = clamp(p.level + 5); State.stats.mood = clamp(State.stats.mood + 4);
        logEvent(`I taught ${p.name} a new skill.`, "good");
        personResult("Skill Taught", `${p.name} picked it up faster than expected.`, { closeness: 5, mood: 4 });
    }},
    { label: `Pay for ${p.name}'s college`, desc: "Big investment", cost: 60000, locked: p.age < 17, run: () => {
        if (!spend(60000)) { showAftermath("Can't Afford","Tuition is brutal."); return; }
        p.level = clamp(p.level + 25); State.stats.mood = clamp(State.stats.mood + 8);
        logEvent(`I paid for ${p.name}'s college.`, "good");
        personResult("College Paid", `${p.name} is going to college debt-free.`,
          { closeness: 25, mood: 8, money: -60000 });
    }},
    { label: `Buy ${p.name} a car`, desc: "Their first car", cost: 12000, locked: p.age < 16, run: () => {
        if (!spend(12000)) { showAftermath("Can't Afford","Cars aren't cheap."); return; }
        p.level = clamp(p.level + 15); State.stats.mood = clamp(State.stats.mood + 7);
        logEvent(`I bought ${p.name} a car.`, "good");
        personResult("First Car", `${p.name} screamed and hugged me.`,
          { closeness: 15, mood: 7, money: -12000 });
    }},
    { label: `Ground ${p.name}`, desc: "Punishment time", locked: p.age < 5, run: () => {
        p.level = clamp(p.level - 5);
        logEvent(`I grounded ${p.name}.`);
        personResult("Grounded", `${p.name} is in their room. They're not happy.`,
          { closeness: -5 }, [{ label: "Reason", value: "Breaking the rules" }]);
    }},
    { label: `Disown ${p.name}`, desc: "Cut them off entirely", run: () => {
        const name = p.name;
        State.children = State.children.filter(c => c !== p);
        State.stats.mood = clamp(State.stats.mood - 15);
        logEvent(`I disowned my child ${name}.`, "bad");
        personResult("Severed", `I cut ${name} out of my life.`,
          { mood: -15 }, [{ label: "Reason", value: "Beyond repair" }]);
    }},
  ];
}

function friendActions(p) {
  return [
    { label: `Hang out with ${p.name}`, desc: "Lunch, coffee, whatever", run: () => {
        p.level = clamp(p.level + 5); State.stats.mood = clamp(State.stats.mood + 4);
        logEvent(`I hung out with my friend ${p.name}.`);
        personResult("Hung Out", `Easy afternoon with ${p.name}.`, { closeness: 5, mood: 4 });
    }},
    { label: `Call ${p.name}`, desc: "Quick check-in", run: () => {
        p.level = clamp(p.level + 2); State.stats.mood = clamp(State.stats.mood + 2);
        logEvent(`I called ${p.name}.`);
        personResult("Called", `Quick phone call with ${p.name}.`, { closeness: 2, mood: 2 });
    }},
    { label: `Ask ${p.name} for a favor`, desc: "Closeness affects success", run: () => {
        if (Math.random() < (p.level / 100)) {
          State.stats.mood = clamp(State.stats.mood + 4);
          logEvent(`${p.name} did me a favor.`, "good");
          personResult("Favor Granted", `${p.name} came through for me.`, { mood: 4 });
        } else {
          p.level = clamp(p.level - 10);
          logEvent(`${p.name} refused to help.`, "bad");
          personResult("Refused", `${p.name} said no. The friendship took a hit.`,
            { closeness: -10 }, [{ label: "Reason", value: "Too big an ask" }]);
        }
    }},
    { label: `Lend ${p.name} money`, desc: "50% they pay it back", cost: 200, run: () => {
        if (!spend(200)) { showAftermath("Can't Afford","Not enough cash."); return; }
        p.level = clamp(p.level + 8);
        if (Math.random() < 0.5) {
          State.money += 200;
          logEvent(`${p.name} paid me back the $200.`);
          personResult("Paid Back", `${p.name} returned the $200.`,
            { closeness: 8 }, [{ label: "Outcome", value: "Got it back" }]);
        } else {
          logEvent(`I lent ${p.name} $200. They never paid back.`, "bad");
          personResult("Never Paid Back", `${p.name} ghosted on the loan.`,
            { closeness: 8, money: -200 }, [{ label: "Status", value: "Unpaid" }]);
        }
    }},
    { label: `Take ${p.name} on a trip`, desc: "Bonding through travel", cost: 1500, run: () => {
        if (!spend(1500)) { showAftermath("Can't Afford","Trips aren't cheap."); return; }
        p.level = clamp(p.level + 15); State.stats.mood = clamp(State.stats.mood + 7);
        logEvent(`${p.name} and I took a trip together.`, "good");
        personResult("Trip Together", `Five days of laughter and questionable food.`,
          { closeness: 15, mood: 7, money: -1500 });
    }},
    { label: `Confess feelings to ${p.name}`, desc: "Risk the friendship for romance", locked: !!State.partner, run: () => {
        if (Math.random() < 0.35) {
          createPartner();
          State.partner.name = p.name;
          State.partner.gender = p.gender || "F";
          State.friends = State.friends.filter(f => f !== p);
          logEvent(`I confessed to ${p.name}. They felt the same.`, "good");
          personResult("New Couple", `${p.name} is more than a friend now.`,
            null, [{ label: "Status", value: "Together" }]);
        } else {
          p.level = clamp(p.level - 30); State.stats.mood = clamp(State.stats.mood - 8);
          logEvent(`I confessed to ${p.name} and got rejected.`, "bad");
          personResult("Awkward", `They don't feel the same. Friendship is shaky.`,
            { closeness: -30, mood: -8 });
        }
    }},
    { label: `Pick a fight with ${p.name}`, desc: "Why is unclear", run: () => {
        p.level = clamp(p.level - 25); State.stats.mood = clamp(State.stats.mood - 5);
        logEvent(`I picked a fight with ${p.name}.`, "bad");
        personResult("Picked a Fight", `${p.name} and I traded words. Both walked away mad.`,
          { closeness: -25, mood: -5 });
    }},
    { label: `Betray ${p.name}`, desc: "Final, ugly cut", run: () => {
        const name = p.name;
        State.friends = State.friends.filter(f => f !== p);
        State.stats.mood = clamp(State.stats.mood - 6);
        State.memory = State.memory || {};
        State.memory.betrayedFriend = true;
        logEvent(`I betrayed ${name}. We're not friends anymore.`, "bad");
        personResult("Betrayed", `I sold out ${name}. They'll find out soon.`,
          { mood: -6 }, [{ label: "Reason", value: "Personal gain" }]);
    }},
    { label: `Stop being friends with ${p.name}`, desc: "Quiet exit", run: () => {
        const name = p.name;
        State.friends = State.friends.filter(f => f !== p);
        State.stats.mood = clamp(State.stats.mood - 3);
        logEvent(`I cut ties with ${name}.`);
        personResult("Friendship Ended", `${name} and I are no longer friends.`,
          { mood: -3 });
    }},
  ];
}

function petActions(p) {
  return [
    { label: `Play with ${p.name}`, desc: "Tug, toss, chase", run: () => {
        p.level = clamp(p.level + 5); State.stats.mood = clamp(State.stats.mood + 5);
        logEvent(`I played with my ${p.kind} ${p.name}.`);
        personResult("Play Time", `${p.name} is exhausted and happy.`, { closeness: 5, mood: 5 });
    }},
    { label: `Take ${p.name} for a walk`, desc: "Some fresh air", run: () => {
        p.level = clamp(p.level + 4); State.stats.mood = clamp(State.stats.mood + 4);
        State.stats.health = clamp(State.stats.health + 1);
        logEvent(`I took ${p.name} on a long walk.`);
        personResult("Walk", `Long loop around the park with ${p.name}.`,
          { closeness: 4, mood: 4, health: 1 });
    }},
    { label: `Feed ${p.name} treats`, desc: "They love these", cost: 20, run: () => {
        if (!spend(20)) { showAftermath("Can't Afford","Not enough cash."); return; }
        p.level = clamp(p.level + 6); State.stats.mood = clamp(State.stats.mood + 3);
        logEvent(`I spoiled ${p.name} with treats.`);
        personResult("Treats", `${p.name} would do anything for these.`,
          { closeness: 6, mood: 3, money: -20 });
    }},
    { label: `Take ${p.name} to the vet`, desc: "Annual checkup", cost: 300, run: () => {
        if (!spend(300)) { showAftermath("Can't Afford","Vet bills aren't cheap."); return; }
        p.level = clamp(p.level + 3); State.stats.mood = clamp(State.stats.mood + 4);
        logEvent(`Took ${p.name} for a vet checkup.`);
        personResult("Vet Visit", `${p.name} got a clean bill of health.`,
          { closeness: 3, mood: 4, money: -300 });
    }},
    { label: `Buy ${p.name} a fancy toy`, desc: "Latest pet gadget", cost: 80, run: () => {
        if (!spend(80)) { showAftermath("Can't Afford","Not enough cash."); return; }
        p.level = clamp(p.level + 8); State.stats.mood = clamp(State.stats.mood + 3);
        logEvent(`I bought ${p.name} a fancy toy.`);
        personResult("New Toy", `${p.name} is obsessed with the new toy.`,
          { closeness: 8, mood: 3, money: -80 });
    }},
    { label: `Train ${p.name}`, desc: "Sit. Stay. Good.", run: () => {
        p.level = clamp(p.level + 4); State.stats.mood = clamp(State.stats.mood + 3);
        logEvent(`Trained ${p.name}.`);
        personResult("Training", `${p.name} learned a new trick.`, { closeness: 4, mood: 3 });
    }},
    { label: `Cuddle ${p.name}`, desc: "Sometimes that's enough", run: () => {
        p.level = clamp(p.level + 7); State.stats.mood = clamp(State.stats.mood + 6);
        logEvent(`I cuddled with ${p.name} for hours.`);
        personResult("Cuddles", `Pure comfort with ${p.name}.`, { closeness: 7, mood: 6 });
    }},
    { label: `Give ${p.name} away`, desc: "Find them a new home", run: () => {
        const name = p.name;
        State.pets = State.pets.filter(x => x !== p);
        State.stats.mood = clamp(State.stats.mood - 8);
        logEvent(`I gave away my pet ${name}.`, "bad");
        personResult("Gone", `${name} has a new home.`,
          { mood: -8 }, [{ label: "Reason", value: "Couldn't keep them" }]);
    }},
  ];
}

function viewMenu() {
  showSubview("MENU", body => {
    const sec1 = document.createElement("div");
    sec1.className = "form-section";
    sec1.innerHTML = `<h4>About</h4>
      <div class="info-row"><div>Name</div><div class="v">${State.name}</div></div>
      <div class="info-row"><div>Age</div><div class="v">${State.age}</div></div>
      <div class="info-row"><div>Country</div><div class="v">${State.country}</div></div>
      <div class="info-row"><div>Education</div><div class="v">${State.education}</div></div>`;
    body.appendChild(sec1);

    // BADGES (preset + AI-granted)
    const badgeSec = document.createElement("div");
    badgeSec.className = "form-section";
    const aiBadgeIds = Object.keys(State.aiBadges);
    const totalBadgeIds = GAME.badges.map(b => b.id).concat(aiBadgeIds);
    const earned = State.badges.filter(id => totalBadgeIds.includes(id)).length;
    const totalCount = GAME.badges.length + aiBadgeIds.length;
    badgeSec.innerHTML = `<h4>🏆 Badges (${earned}/${totalCount})</h4>`;
    const grid = document.createElement("div");
    grid.className = "badge-grid";
    // Preset badges first
    for (const b of GAME.badges) {
      const unlocked = State.badges.includes(b.id);
      const cell = document.createElement("div");
      cell.className = "badge-cell" + (unlocked ? "" : " locked");
      cell.title = b.desc;
      cell.innerHTML = `
        <div class="b-ico ${unlocked ? "" : "locked"}"><i data-lucide="${unlocked ? b.icon : "lock"}"></i></div>
        <div class="b-name">${b.name}</div>`;
      grid.appendChild(cell);
    }
    // AI-granted custom badges (always unlocked when they appear)
    for (const id of aiBadgeIds) {
      const b = State.aiBadges[id];
      const cell = document.createElement("div");
      cell.className = "badge-cell";
      cell.title = b.desc;
      cell.innerHTML = `
        <div class="b-ico ai-badge"><i data-lucide="${b.icon || "sparkles"}"></i></div>
        <div class="b-name">${b.name}</div>`;
      grid.appendChild(cell);
    }
    badgeSec.appendChild(grid);
    body.appendChild(badgeSec);

    // AI CONFIG
    const sec2 = document.createElement("div");
    sec2.className = "form-section";
    sec2.innerHTML = `<h4>🤖 AI Configuration</h4>
      <p>Add an API key to unlock <strong>Custom Choice (AI)</strong> in every dialog. Your key stays in your browser only.</p>
      <select id="aiProvider">
        <option value="anthropic" ${State.aiProvider === "anthropic" ? "selected" : ""}>Anthropic (Claude)</option>
        <option value="openai" ${State.aiProvider === "openai" ? "selected" : ""}>OpenAI (GPT)</option>
        <option value="gemini" ${State.aiProvider === "gemini" ? "selected" : ""}>Google (Gemini)</option>
        <option value="grok" ${State.aiProvider === "grok" ? "selected" : ""}>xAI (Grok)</option>
        <option value="poe" ${State.aiProvider === "poe" ? "selected" : ""}>Poe</option>
      </select>
      <input id="aiModel" placeholder="Model (optional - leave blank for default)" value="${State.aiModel}" />
      <input id="aiKey" type="password" placeholder="API Key" value="${State.apiKey}" />
      <div class="btn-row">
        <button class="success" id="saveAI">Save</button>
        <button class="danger" id="clearAI">Clear</button>
      </div>
      <div class="toggle-row">
        <div class="toggle-text">
          <div class="toggle-title">Life Management</div>
          <div class="toggle-desc">Fade older memories when calling the AI. Cheaper per request, but the AI sees less context.</div>
        </div>
        <input type="checkbox" class="toggle" id="lifeManagement" ${State.lifeManagement ? "checked" : ""}>
      </div>
      <div class="toggle-row">
        <div class="toggle-text">
          <div class="toggle-title">AI Mode</div>
          <div class="toggle-desc">Replace preset yearly events with AI-generated ones. Requires an API key.</div>
        </div>
        <input type="checkbox" class="toggle" id="aiMode" ${State.aiMode ? "checked" : ""}>
      </div>
      <div class="toggle-row">
        <div class="toggle-text">
          <div class="toggle-title">Realistic Mode</div>
          <div class="toggle-desc">Advance time in hours, days, or weeks instead of full years. You will need to have a real dedication to keep going, but you'll get lots of events in your life.</div>
        </div>
        <input type="checkbox" class="toggle" id="realisticMode" ${State.realisticMode ? "checked" : ""}>
      </div>`;
    body.appendChild(sec2);
    sec2.querySelector("#saveAI").onclick = () => {
      State.apiKey    = sec2.querySelector("#aiKey").value.trim();
      State.aiModel   = sec2.querySelector("#aiModel").value.trim();
      State.aiProvider= sec2.querySelector("#aiProvider").value;
      localStorage.setItem("bitlife_api_key", State.apiKey);
      localStorage.setItem("bitlife_ai_model", State.aiModel);
      localStorage.setItem("bitlife_ai_provider", State.aiProvider);
      showAftermath("Saved","AI settings saved.");
    };
    sec2.querySelector("#clearAI").onclick = () => {
      State.apiKey = ""; State.aiModel = ""; State.aiProvider = "anthropic";
      localStorage.removeItem("bitlife_api_key");
      localStorage.removeItem("bitlife_ai_model");
      localStorage.removeItem("bitlife_ai_provider");
      viewMenu();
    };
    sec2.querySelector("#lifeManagement").onchange = (e) => {
      State.lifeManagement = e.target.checked;
      localStorage.setItem("bitlife_life_management", e.target.checked ? "1" : "0");
    };
    sec2.querySelector("#aiMode").onchange = (e) => {
      State.aiMode = e.target.checked;
      localStorage.setItem("bitlife_ai_mode", e.target.checked ? "1" : "0");
      if (e.target.checked && !State.apiKey) {
        showAftermath("Add a key", "AI Mode needs an API key. Save one above first.");
      }
    };
    sec2.querySelector("#realisticMode").onchange = (e) => {
      if (e.target.checked) {
        const ok = confirm("You will need to have a real dedication to keep going, but you'll get lots of events in your life. Enable Realistic Mode?");
        if (!ok) { e.target.checked = false; return; }
      }
      State.realisticMode = e.target.checked;
      localStorage.setItem("bitlife_realistic_mode", e.target.checked ? "1" : "0");
      if (e.target.checked) {
        showAftermath("Realistic Mode On", "Click the main button to choose how much time to advance each click. You can pick between minutes, hours, and days.");
      }
      render(); // update day-button label
    };

    const sec3 = document.createElement("div");
    sec3.className = "form-section";
    sec3.innerHTML = `<h4>Game</h4>
      <div class="btn-row">
        <button class="danger" id="newLifeBtn">New Life</button>
        <button id="copyStory">Copy Story</button>
      </div>`;
    body.appendChild(sec3);
    sec3.querySelector("#newLifeBtn").onclick = () => {
      if (confirm("Abandon this life and start over?")) { newLife(); closeSubview(); }
    };
    sec3.querySelector("#copyStory").onclick = () => {
      const text = State.log.map(e => `[${e.age === 0 ? "Day 1" : `Age ${e.age}`}] ${e.text}`).join("\n");
      navigator.clipboard.writeText(text).then(() => showAftermath("Copied","Life story copied to clipboard."));
    };

    // === Save slots (3 manual slots) ===
    const sec4 = document.createElement("div");
    sec4.className = "form-section";
    const fmtTime = (ts) => {
      if (!ts) return "";
      const d = new Date(ts);
      return d.toLocaleDateString() + " " + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    };
    let slotHtml = `<h4>Save Slots</h4>
      <div class="save-slots-hint">Auto-save runs every age-up. Use slots to keep up to 3 named saves.</div>`;
    for (let n = 1; n <= NUM_SLOTS; n++) {
      const info = slotInfo(n);
      const label = info
        ? `${escapeHtml(info.name)}, age ${info.age}${info.alive ? "" : " ✝"} <span class="slot-meta">— ${fmtTime(info.savedAt)}</span>`
        : `<span class="slot-empty">Empty</span>`;
      slotHtml += `
        <div class="save-slot-row">
          <div class="save-slot-label">Slot ${n}: ${label}</div>
          <div class="save-slot-actions">
            <button class="slot-save" data-slot="${n}">Save</button>
            <button class="slot-load" data-slot="${n}" ${info ? "" : "disabled"}>Load</button>
            <button class="slot-delete danger" data-slot="${n}" ${info ? "" : "disabled"}>Del</button>
          </div>
        </div>`;
    }
    sec4.innerHTML = slotHtml;
    body.appendChild(sec4);

    sec4.querySelectorAll(".slot-save").forEach(btn => {
      btn.onclick = () => {
        const n = parseInt(btn.dataset.slot, 10);
        const existing = slotInfo(n);
        if (existing && !confirm(`Overwrite Slot ${n} (${existing.name}, age ${existing.age})?`)) return;
        if (saveToSlot(n)) {
          showAftermath("Saved", `Slot ${n} updated.`, { onClose: () => viewMenu() });
        } else {
          showAftermath("Save failed", "Couldn't write to that slot.");
        }
      };
    });
    sec4.querySelectorAll(".slot-load").forEach(btn => {
      btn.onclick = () => {
        const n = parseInt(btn.dataset.slot, 10);
        const info = slotInfo(n);
        if (!info) return;
        if (!confirm(`Load Slot ${n}: ${info.name}, age ${info.age}? Your current life will be replaced.`)) return;
        if (loadFromSlot(n)) {
          closeSubview();
          render();
          showAftermath("Loaded", `Resumed: ${info.name}, age ${info.age}.`);
        } else {
          showAftermath("Load failed", "Couldn't read that slot.");
        }
      };
    });
    sec4.querySelectorAll(".slot-delete").forEach(btn => {
      btn.onclick = () => {
        const n = parseInt(btn.dataset.slot, 10);
        const info = slotInfo(n);
        if (!info) return;
        if (!confirm(`Delete Slot ${n} (${info.name}, age ${info.age})? This can't be undone.`)) return;
        deleteSlot(n);
        viewMenu();
      };
    });

    // === Google Sync (BETA) ===
    const secSync = document.createElement("div");
    secSync.className = "form-section";
    const linked = !!localStorage.getItem("ailife_account_email");
    const linkedEmail = localStorage.getItem("ailife_account_email") || "";
    const lastSync = localStorage.getItem("ailife_last_sync");
    secSync.innerHTML = `<h4>☁️ Sync progress <span class="beta-badge">BETA</span></h4>
      <p style="font-size:13px;color:#555;line-height:1.5;margin-bottom:10px;">
        ${linked
          ? `Linked as <strong>${linkedEmail}</strong>.`
          : "Link your account to back up your saves to the cloud."}
        ${lastSync ? `<br>Last sync: ${new Date(parseInt(lastSync,10)).toLocaleString()}.` : ""}
      </p>
      <div class="btn-row">
        ${linked
          ? `<button class="success" id="acctPush">Push Save</button>
             <button id="acctPull">Pull Save</button>
             <button class="danger" id="acctUnlink">Unlink</button>`
          : `<button class="success" id="acctLink">Link my account</button>`}
      </div>`;
    body.appendChild(secSync);

    if (linked) {
      secSync.querySelector("#acctPush").onclick = () => {
        localStorage.setItem("ailife_last_sync", String(Date.now()));
        showAftermath("Pushed", "Save synced to your account.", { onClose: () => viewMenu() });
      };
      secSync.querySelector("#acctPull").onclick = () => {
        if (!confirm("Pull save from your account? Your current life will be replaced.")) return;
        localStorage.setItem("ailife_last_sync", String(Date.now()));
        showAftermath("Pulled", "Save loaded from your account.", { onClose: () => viewMenu() });
      };
      secSync.querySelector("#acctUnlink").onclick = () => {
        if (!confirm("Unlink account? Your saves stay in the cloud but won't sync anymore.")) return;
        localStorage.removeItem("ailife_account_email");
        viewMenu();
      };
    } else {
      secSync.querySelector("#acctLink").onclick = () => {
        // Open the login page. GitHub Pages serves static files only, so
        // we link to login.html directly (works on any static host).
        window.location.href = "login.html";
      };
    }

    // === Support the developer ===
    const secCoffee = document.createElement("div");
    secCoffee.className = "form-section";
    secCoffee.innerHTML = `<h4>☕ Support</h4>
      <p style="font-size:13px;color:#555;line-height:1.5;margin-bottom:10px;">
        AILife is free and ad-free. If you're enjoying it, you can support development on Ko-Fi — it helps keep the lights on.
      </p>
      <a href="https://ko-fi.com/stavroselpro" target="_blank" rel="noopener noreferrer" class="kofi-link">
        ☕ Support on Ko-Fi
      </a>`;
    body.appendChild(secCoffee);

    // === About / Legal ===
    const sec5 = document.createElement("div");
    sec5.className = "form-section";
    sec5.innerHTML = `<h4>About</h4>
      <div class="about-text">
        <p><strong>AILife</strong> — A Dynamic AI-Driven Life Simulator.</p>
        <p class="about-disclaimer">
          AILife is an independent fan-made remake. It is <strong>not affiliated with, endorsed by,
          or made by</strong> BitLife or Candywriter LLC. All trademarks belong to their respective
          owners. AILife strips all monetization — no ads, no in-app purchases, no paywalls — and
          focuses on a dynamic, AI-driven life simulation. Provided as-is, free of charge, for
          personal use only.
        </p>
      </div>`;
    body.appendChild(sec5);
  });
}

/* ============ AI INTEGRATION ============
 * AI response schema (JSON only, no markdown):
 * {
 *   "title":  "<dialog title if options follow>",
 *   "body":   "<dialog body if options follow>",
 *   "narration": "<first-person past-tense log line>",
 *   "logKind": "good"|"bad"|"normal"|"ai",
 *   "stats": {"mood":N,"health":N,"smarts":N,"looks":N},   // deltas
 *   "money": <integer, can be negative>,
 *   "addBadge": {"id":"<short_id>","name":"<short>","icon":"<lucide-name>","desc":"<short>"},
 *   "options": [                                           // optional: follow-up choice dialog
 *     {"label":"...","narration":"...","stats":{...},"money":N,"tone":"good|bad|normal"}
 *   ]
 * }
 * Behavior:
 *   - If options[] present → show as options dialog
 *   - Otherwise apply effects directly. Narration goes to the life record.
 *   - addBadge grants a new badge (chained after the rest).
 */

// Life log context for the AI. Life Management ON = fade to last 5; OFF = last 25.
function lifeLogForAI() {
  const limit = State.lifeManagement ? 5 : 25;
  const recent = State.log.slice(-limit);
  return recent.map(e => `[age ${e.age}] ${e.text}`).join("\n");
}

function stateSummaryForAI() {
  const bits = [
    `Age ${State.age} in ${State.country}.`,
    State.inJail ? `IMPRISONED: ${State.inJail.served}/${State.inJail.sentence} years for ${State.inJail.crime}.` : "",
    State.job ? `Works as ${State.job.title} (${money(State.job.salary)}/yr).` : (State.inJail ? "" : "Unemployed."),
    State.partner ? `${State.partner.married ? "Married to" : State.partner.engaged ? "Engaged to" : "Dating"} ${State.partner.name}.` : "Single.",
    State.children.length ? `${State.children.length} child(ren).` : "",
    State.pets.length    ? `${State.pets.length} pet(s).`     : "",
    State.friends.length ? `${State.friends.length} friend(s).` : "",
    `Education: ${State.education}.`,
    State.illnesses.length ? `Active illnesses: ${State.illnesses.join(", ")}.` : "",
    `Stats — mood ${State.stats.mood}, health ${State.stats.health}, smarts ${State.stats.smarts}, looks ${State.stats.looks}.`,
    `Net worth ${money(netWorth())}.`,
    State.criminalRecord ? `Criminal record: ${State.criminalRecord} prior(s).` : "",
    State.addictions.length ? `Addictions: ${State.addictions.join(", ")}.` : "",
  ].filter(Boolean);
  return bits.join(" ");
}

async function callAI(userAct, contextLabel, customSystem) {
  const baseSchema = `Respond with STRICT JSON only (no markdown). Schema:
{"title":"<optional>","body":"<optional>","narration":"<first-person past-tense, 1-2 sentences>","logKind":"good"|"bad"|"normal"|"ai","stats":{"mood":<-15..15>,"health":<-15..15>,"smarts":<-15..15>,"looks":<-15..15>},"money":<integer; can be negative>,"addBadge":{"id":"<snake_case>","name":"<short>","icon":"<lucide icon name>","desc":"<short>"},"options":[{"label":"<short>","narration":"<result>","stats":{...},"money":<int>,"tone":"good|bad|normal"}]}
All fields are optional EXCEPT narration (or options if you provide a follow-up choice). Use options[] for follow-up choices; otherwise omit it. addBadge ONLY for major milestones — leave it out for normal events. Stats are DELTAS, not totals. Be concise.`;

  const sys = customSystem || `You narrate a life simulator. Context tag: ${contextLabel}.
${stateSummaryForAI()}
Recent life log:
${lifeLogForAI()}
${baseSchema}`;

  // Default model per provider
  const defaultModels = {
    anthropic: "claude-sonnet-4-20250514",
    openai:    "gpt-4o-mini",
    gemini:    "gemini-2.0-flash",
    grok:      "grok-2-latest",
    poe:       "GPT-4o-Mini",
  };
  const model = State.aiModel || defaultModels[State.aiProvider] || "gpt-4o-mini";

  if (State.aiProvider === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": State.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model, max_tokens: 600, system: sys, messages: [{ role: "user", content: userAct }] }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j.content?.[0]?.text || "";

  } else if (State.aiProvider === "gemini") {
    // Google Gemini — uses URL-keyed REST endpoint with a different message shape
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(State.apiKey)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: "user", parts: [{ text: userAct }] }],
        generationConfig: { maxOutputTokens: 600 }
      }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j.candidates?.[0]?.content?.parts?.[0]?.text || "";

  } else if (State.aiProvider === "grok") {
    // xAI Grok — uses an OpenAI-compatible chat completions API
    const r = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${State.apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: userAct }], max_tokens: 600 }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j.choices?.[0]?.message?.content || "";

  } else if (State.aiProvider === "poe") {
    // Poe API — OpenAI-compatible chat completions
    const r = await fetch("https://api.poe.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${State.apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: userAct }], max_tokens: 600 }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j.choices?.[0]?.message?.content || "";

  } else {
    // OpenAI (default)
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${State.apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: userAct }], max_tokens: 600 }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j.choices?.[0]?.message?.content || "";
  }
}

function parseAIResult(text) {
  let s = (text || "").trim();
  if (s.startsWith("```")) s = s.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "");
  // Try to find JSON inside whatever the AI returned
  const first = s.indexOf("{");
  const last  = s.lastIndexOf("}");
  if (first === -1 || last === -1) return null;
  try { return JSON.parse(s.slice(first, last + 1)); } catch { return null; }
}

// Apply a single AI "outcome" — narration + stats + money + optional badge.
// Returns true if a follow-up dialog (options or badge) was opened.
function applyAIOutcome(parsed) {
  if (!parsed) return false;

  if (parsed.narration) {
    const kind = parsed.logKind || (parsed.tone === "good" ? "good" : parsed.tone === "bad" ? "bad" : "ai");
    logEvent(parsed.narration, kind);
  }
  if (parsed.stats) applyStats(parsed.stats);
  if (parsed.money != null) applyStats({ money: parsed.money });

  // Custom badge from AI
  if (parsed.addBadge && parsed.addBadge.name) {
    const b = {
      id:   parsed.addBadge.id   || "ai_" + Date.now(),
      name: parsed.addBadge.name,
      icon: parsed.addBadge.icon || "sparkles",
      desc: parsed.addBadge.desc || "",
    };
    if (!State.badges.includes(b.id)) {
      State.aiBadges[b.id] = b;
      State.badges.push(b.id);
      logEvent(`🏆 Badge unlocked: ${b.name}.`, "good");
      showAftermath("Badge Unlocked!", "", { badge: b });
      return true;
    }
  }
  return false;
}

// Decide what to show after an AI response
function presentAIResult(parsed, fallbackTitle) {
  if (!parsed) {
    showAftermath("AI Glitch", "The AI returned something I couldn't parse.");
    return;
  }

  // If the AI proposed follow-up options, show them as a new dialog
  if (Array.isArray(parsed.options) && parsed.options.length > 0) {
    // Apply any base narration / stats first (silently — the dialog itself will narrate)
    if (parsed.narration) logEvent(parsed.narration, parsed.logKind || "ai");
    if (parsed.stats) applyStats(parsed.stats);
    if (parsed.money != null) applyStats({ money: parsed.money });

    const choices = parsed.options.map(o => ({
      label: o.label || "...",
      run: () => {
        // Each choice is itself an AI outcome
        const opened = applyAIOutcome({
          narration: o.narration,
          logKind: o.logKind || (o.tone === "good" ? "good" : o.tone === "bad" ? "bad" : "ai"),
          stats: o.stats,
          money: o.money,
          addBadge: o.addBadge,
        });
        // Only show aftermath if the AI explicitly asked for one
        if (!opened && o.aftermath) showAftermath(o.aftermathTitle || "Aftermath", o.aftermath);
      },
    }));
    showOptions(parsed.title || fallbackTitle || "Decision", parsed.body || parsed.narration || "What do I do?", choices);
    return;
  }

  // No follow-up — apply directly. Show aftermath only when the AI clearly intends a moment
  const opened = applyAIOutcome(parsed);
  if (opened) return;
  if (parsed.aftermath) {
    showAftermath(parsed.title || fallbackTitle || "AI", parsed.aftermath);
  } else {
    // Silent log — aftermath only when necessary (bitlife-style)
  }
}

// User clicked Custom Choice (AI) — prompt for typed action, then call AI.
function askAICustomAction(prompt, contextLabel) {
  DLG.header.textContent = "Custom Choice (AI)";
  DLG.body.innerHTML = "";
  DLG.hint.style.display = "none";
  const q = document.createElement("div");
  q.className = "dlg-question";
  q.textContent = prompt;
  DLG.body.appendChild(q);
  const ta = document.createElement("textarea");
  ta.className = "ai-input";
  ta.placeholder = "What do you do? (be specific)";
  DLG.body.appendChild(ta);
  const btn = document.createElement("button");
  btn.className = "dlg-ai-btn";
  btn.innerHTML = `<i data-lucide="sparkles"></i><span>Generate Outcome</span>`;
  DLG.body.appendChild(btn);
  DLG.overlay.classList.add("show");
  if (window.lucide) lucide.createIcons();
  ta.focus();

  btn.onclick = async () => {
    const action = ta.value.trim();
    if (!action) return;
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2"></i><span>Thinking...</span>`;
    if (window.lucide) lucide.createIcons();
    try {
      const text = await callAI(action, contextLabel);
      closeDialog();
      const parsed = parseAIResult(text);
      presentAIResult(parsed, "Custom Choice");
    } catch (err) {
      console.error(err);
      closeDialog();
      showAftermath("AI Error", "Reaching the AI failed: " + err.message);
    }
    render();
  };
}

// AI Mode: ask the AI for a random life event this year, optionally with choices.
async function triggerAIEvent(age) {
  try {
    const userPrompt = `Invent a single specific life event for me this year. Make it varied, surprising, and grounded in my circumstances. Provide a "narration" of what happened. If the event involves a decision, include 2-4 "options" so I can choose. Otherwise omit options.`;
    const text = await callAI(userPrompt, `year_event_age_${age}`);
    const parsed = parseAIResult(text);
    if (!parsed) return;
    presentAIResult(parsed, "Life Event");
    render();
  } catch (err) {
    console.error("AI event error:", err);
    // Silent fallback — don't bother the user every year if the API is down
  }
}

/* ============ NEW LIFE + BIND ============ */
function newLife() {
  clearSave();
  State = blankState();
  render();
  saveGame();
}

function bind() {
  DOM.dayBtn.onclick = () => { playSound("age"); advanceTime(); };
  // Tap-to-toggle the QoL tooltip on mobile (hover handles desktop via CSS)
  if (DOM.personaRight) {
    DOM.personaRight.addEventListener("click", (e) => {
      DOM.personaRight.classList.toggle("show");
      e.stopPropagation();
    });
    document.addEventListener("click", () => DOM.personaRight.classList.remove("show"));
  }
  // Long-press the day button (realistic mode only) to change time unit.
  let _pressTimer = null;
  const startPress = (ev) => {
    if (!State.realisticMode) return;
    _pressTimer = setTimeout(() => {
      _pressTimer = null;
      pickRealisticUnit();
    }, 600);
  };
  const cancelPress = () => {
    if (_pressTimer) { clearTimeout(_pressTimer); _pressTimer = null; }
  };
  DOM.dayBtn.addEventListener("mousedown",  startPress);
  DOM.dayBtn.addEventListener("mouseup",    cancelPress);
  DOM.dayBtn.addEventListener("mouseleave", cancelPress);
  DOM.dayBtn.addEventListener("touchstart", startPress);
  DOM.dayBtn.addEventListener("touchend",   cancelPress);
  DOM.dayBtn.addEventListener("touchcancel",cancelPress);
  document.querySelectorAll("[data-open]").forEach(b => {
    b.onclick = () => {
      const tgt = b.dataset.open;
      if (tgt === "activities") viewActivities();
      if (tgt === "job")        viewJob();
      if (tgt === "school")     viewSchool();
      if (tgt === "finance")    viewFinance();
      if (tgt === "relations")  viewRelations();
      if (tgt === "jail")       viewJail();
    };
  });
  document.getElementById("menuBtn").onclick  = viewMenu;
  document.getElementById("menuBtn2").onclick = viewMenu;
  document.getElementById("subviewBack").onclick = closeSubview;
}

/* ============ BOOT ============ */
async function init() {
  const splash = document.getElementById("loadingSplash");
  try {
    const res = await fetch("game.json?v=20");
    if (!res.ok) throw new Error("HTTP " + res.status);
    GAME = await res.json();
  } catch (err) {
    splash.innerHTML = `
      <div class="err">
        <h3>Couldn't load game.json</h3>
        <p>The game needs to load <code style="display:inline">game.json</code> over HTTP. Browsers block this for local files opened directly.</p>
        <p><strong>Quick fix:</strong> run a local server from the folder containing these files:</p>
        <code>python3 -m http.server 8000</code>
        <p>Then open <code style="display:inline">http://localhost:8000/index.html</code></p>
        <p style="margin-top:10px;font-size:12px;color:#888">Error: ${escapeHtml(err.message)}</p>
      </div>`;
    return;
  }
  splash.remove();
  document.getElementById("mainView").style.visibility = "visible";

  // Try to load a saved life; fall back to a fresh one
  const loaded = loadGame();
  if (!loaded) {
    newLife();
  } else {
    render();
  }
  bind();
  initSounds();
  if (window.lucide) lucide.createIcons();

  // Click-to-play overlay: wait for user gesture before unlocking audio + playing menu sound
  const ctp = document.getElementById("clickToPlay");
  if (ctp) {
    const startGame = () => {
      unlockAudio();
      playSound("menu");
      ctp.classList.add("hidden");
      setTimeout(() => ctp.remove(), 350);
    };
    ctp.addEventListener("click", startGame, { once: true });
    ctp.addEventListener("touchstart", startGame, { once: true });
  }
}

init();
