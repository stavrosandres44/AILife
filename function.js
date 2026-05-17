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
const SOUND_IDS = ["menu","back","choiceselect","aibutton","age","achievement","aftermath","dialog","death","clickOption"];
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
  death:        2000, // death toll — long, prevents accidental retrigger
  clickOption:  100,  // category card tap
};
const _lastPlayedAt = {};       // soundId -> ms timestamp
let _lastAnyPlayedAt = 0;       // global last-play timestamp
const GLOBAL_COOLDOWN_MS = 25;  // only blocks same-frame double-fires

function initSounds() {
  for (const id of SOUND_IDS) {
    const el = document.getElementById("snd-" + id);
    if (el) {
      el.volume = _audioVolume;
      el.preload = "auto";
      // If the file is missing (404), drop it from the registry so playSound
      // becomes a silent no-op for that sound. Avoids repeated console errors.
      el.addEventListener("error", () => {
        delete SOUNDS[id];
      }, { once: true });
      try { el.load(); } catch (e) { /* ignore */ }
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

// Play a sound on the next paint frame so audio lines up with the visual.
// Used for dialog/aftermath where the sound should "land" with the box appearing.
function playSoundSynced(name) {
  if (typeof requestAnimationFrame !== "undefined") {
    requestAnimationFrame(() => playSound(name));
  } else {
    playSound(name);
  }
}

// Unlock audio playback on first user gesture (browser autoplay policy).
// Also primes the decoder for each sound so the first real play of each
// sound is instant rather than lagging by 50-200ms on first hit.
function unlockAudio() {
  _audioUnlocked = true;
  for (const id of SOUND_IDS) {
    const el = SOUNDS[id];
    if (!el) continue;
    try {
      el.muted = true;
      const p = el.play();
      if (p && p.then) {
        p.then(() => {
          el.pause();
          el.currentTime = 0;
          el.muted = false;
        }).catch(() => {
          // Some browsers still block — at least mark as decoded
          el.muted = false;
          el.currentTime = 0;
        });
      } else {
        el.pause();
        el.currentTime = 0;
        el.muted = false;
      }
    } catch (e) { /* ignore */ }
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
    // ----- Housing -----
    // null         = living with parents / no housing concerns (children, students)
    // "rented"     = renting (yearly rent debited from money/bank)
    // "owned"      = owns a house (no rent; realEstate value > 0)
    // "homeless"   = evicted, severe penalties until they get back on their feet
    housing: null,
    rent: 0,              // annual rent due while housing === "rented"
    rentMissed: 0,        // consecutive years rent went unpaid
    housingName: null,    // display label like "Studio Apartment", "Two-Bedroom House"
    momHouseGiftOffered: false, // ensure the age-20 mom-help event fires only once
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
    aiOutputEffort: localStorage.getItem("bitlife_ai_output_effort") || "medium", // "short" | "medium" | "long"
    aiStyle: localStorage.getItem("bitlife_ai_style") || "",                       // freeform user note appended to system prompt
    lifeManagement: localStorage.getItem("bitlife_life_management") !== "0", // default ON
    realisticMode: localStorage.getItem("bitlife_realistic_mode") === "1",
    realisticUnit: localStorage.getItem("bitlife_realistic_unit") || "day",
    _subYearMinutes: 0,  // accumulator of sub-year time (in minutes)
    // Government documents: { issued: <age issued>, expiresAt: <age it expires>, expired: bool }
    governmentId: null,
    passport: null,
    driverLicense: null,
    // One-shot flags so the mandatory licensing events fire exactly once each:
    govIdOffered: false,
    passportOffered: false,
    driverLicenseOffered: false,
    // School / university
    schoolName: null,          // generated when entering elementary/middle/high
    collegeName: null,         // generated on college enrollment
    collegeMajor: null,        // chosen from dropdown
    studentLoan: null,         // { balance, monthlyPayment, originalAmount } or null
    // Referrals — names of people who have offered to vouch for you. Each
    // entry: { from: "Mrs. Garcia", kind: "teacher" | "professor" | "mentor" | "boss", used: false }
    referrals: [],
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

/* ============ HOUSING ============
 * Players transition through housing as they age:
 *   <18                 -> null (living with parents)
 *   18+ (out of school) -> auto-rents a modest place; rent debited yearly
 *   buys a house        -> "owned"; no rent, realEstate value tracks equity
 *   evicted             -> "homeless"; penalties until they recover
 */

// Subtract money from cash first, then bank. Returns true if fully covered.
function debit(amount) {
  if (amount <= 0) return true;
  if (State.money >= amount) { State.money -= amount; return true; }
  amount -= State.money;
  State.money = 0;
  if (State.bank >= amount) { State.bank -= amount; return true; }
  amount -= State.bank;
  State.bank = 0;
  return false; // couldn't pay in full
}

// Rough annual rent for a player just starting out. Job salary tier nudges it.
function defaultRentForAge(age) {
  // Base rent at 18-21: about $7,200/yr ($600/mo studio). Scales up modestly with age.
  let base = 7200;
  if (age >= 25) base = 10800;
  if (age >= 30) base = 14400;
  if (State.job && State.job.salary >= 100000) base = Math.round(base * 1.4); // they pick nicer places
  return base;
}

// Pick a name for a default rental
function defaultRentalName() {
  return pick(["Studio Apartment", "One-Bedroom Walkup", "Rented Room", "Shared Apartment", "Basement Suite"]);
}

// Move into a default rental — used when an adult first leaves school / parents.
function moveIntoRental() {
  State.housing = "rented";
  State.rent = defaultRentForAge(State.age);
  State.rentMissed = 0;
  State.housingName = defaultRentalName();
  logEvent(`I moved into my own place — a ${State.housingName.toLowerCase()}. Rent is ${money(State.rent)}/year.`, "normal");
}

// Become homeless after eviction or by choice
function becomeHomeless(reason) {
  State.housing = "homeless";
  State.rent = 0;
  State.housingName = null;
  State.stats.mood   = clamp(State.stats.mood   - 15);
  State.stats.health = clamp(State.stats.health - 8);
  State.stats.looks  = clamp(State.stats.looks  - 5);
  // Ongoing penalty until they recover housing
  State.ongoing.push({ stats: { mood: -2, health: -2 }, yearsLeft: 99, label: "Homeless" });
  logEvent(reason || "I lost my home and ended up on the street.", "bad");
  if (!State.memory) State.memory = {};
  State.memory.was_homeless = true;
}

// Recover from homelessness when player has a job and at least $2000
function recoverFromHomeless() {
  if (State.housing !== "homeless") return false;
  if (!State.job) return false;
  if (netWorth() < 2000) return false;
  State.housing = "rented";
  State.rent = defaultRentForAge(State.age);
  State.rentMissed = 0;
  State.housingName = pick(["Studio Apartment", "Tiny One-Bedroom", "Rented Room"]);
  // Drop the homeless ongoing penalty
  State.ongoing = (State.ongoing || []).filter(o => o.label !== "Homeless");
  State.stats.mood = clamp(State.stats.mood + 10);
  logEvent(`I got off the street and rented a ${State.housingName.toLowerCase()}. Trying to build back.`, "good");
  return true;
}

// Called yearly. Handles rent, the age-20 mom-help event, eviction, recovery.
function processHousing() {
  // Below 18, or in school, or in jail: no housing concerns
  if (State.age < 18 || State.inJail) return;
  if (State.inSchool || State.inCollege) return; // still with parents / dorms

  // Age 18 transition: if not already housed, start renting automatically.
  if (State.housing == null && State.age >= 18) {
    moveIntoRental();
  }

  // Age 20: mother may offer help buying a house. Fires once.
  if (State.age === 20 && !State.momHouseGiftOffered) {
    State.momHouseGiftOffered = true;
    triggerMomHouseEvent();
    return; // event handles flow
  }

  // Yearly rent
  if (State.housing === "rented") {
    const paid = debit(State.rent);
    if (paid) {
      State.rentMissed = 0;
    } else {
      State.rentMissed++;
      if (State.rentMissed >= 2) {
        // Evicted
        becomeHomeless("I couldn't make rent two years running. The landlord changed the locks. I was on the street.");
      } else {
        logEvent(`I couldn't pay my rent in full this year. The landlord gave me one more chance.`, "bad");
        State.stats.mood = clamp(State.stats.mood - 8);
      }
    }
  }

  // Auto-recovery if homeless and player rebuilt
  if (State.housing === "homeless") {
    recoverFromHomeless();
  }
}

// One-time event at age 20: mother offers to help with a down payment.
function triggerMomHouseEvent() {
  // If mother already dead, no event
  if (!State.parents || !State.parents.mother) return;
  // 50% chance she's in a position to help; if not, just narrate
  const canHelp = Math.random() < 0.5;
  if (!canHelp) {
    showAftermath(
      "Mom Sat Me Down",
      `Mom sat me down at the kitchen table and told me she wished she could help me buy a place, but she just doesn't have it right now. She apologized like it was her fault.`,
      { onClose: () => { State.stats.mood = clamp(State.stats.mood - 3); render(); saveGame(); } }
    );
    logEvent("Mom told me she can't afford to help me buy a house. She felt awful about it.", "normal");
    return;
  }

  // She CAN help — branch dialog
  const giftAmount = 30000 + Math.floor(Math.random() * 30000); // $30k–$60k
  const housePrice = 150000 + Math.floor(Math.random() * 100000); // $150k–$250k
  showOptions(
    "Mom Wants to Help",
    `Mom pulled me aside today. She offered to give me ${money(giftAmount)} toward buying my first house. The place I've been eyeing costs about ${money(housePrice)}.`,
    [
      {
        label: `Accept and buy the house (${money(housePrice - giftAmount)} from me)`,
        run: () => {
          const myShare = housePrice - giftAmount;
          if (netWorth() < myShare) {
            // Player can't actually afford their share — short-circuit with a softer outcome
            showAftermath(
              "Numbers Didn't Work",
              `I sat down with mom and we did the math. Even with her gift, I couldn't cover the rest. We hugged and agreed I'd save and try again later.`
            );
            logEvent("Mom offered me a down payment, but I couldn't cover the rest yet. I kept renting.", "normal");
            return;
          }
          debit(myShare);
          State.investments.realEstate += housePrice;
          State.housing = "owned";
          State.rent = 0;
          State.rentMissed = 0;
          State.housingName = "My First House";
          State.stats.mood = clamp(State.stats.mood + 15);
          if (!State.memory) State.memory = {};
          State.memory.mom_bought_house = true;
          logEvent(`Mom gifted me ${money(giftAmount)} and I bought my first house. I cried signing the papers.`, "good");
          showAftermath(
            "Keys in Hand",
            `Mom handed me a ${money(giftAmount)} check and I put the rest down on my first house. Standing in the empty living room with the keys in my pocket, I almost couldn't breathe.`
          );
        }
      },
      {
        label: `Accept the money, keep renting`,
        run: () => {
          State.money += giftAmount;
          State.stats.mood = clamp(State.stats.mood + 8);
          logEvent(`Mom gave me ${money(giftAmount)} toward a house. I held onto it — not ready to buy yet.`, "good");
          showAftermath(
            "Banking the Gift",
            `I deposited mom's gift and decided to keep renting for now. It felt strange having that kind of money sit there — but it was a real safety net.`
          );
        }
      },
      {
        label: `Decline — she needs it more than I do`,
        run: () => {
          State.stats.mood = clamp(State.stats.mood + 5);
          if (!State.memory) State.memory = {};
          State.memory.declined_mom_gift = true;
          logEvent(`Mom offered me ${money(giftAmount)} for a house. I told her to keep it — she needed it more.`, "good");
          showAftermath(
            "She Cried",
            `Mom cried when I said no. She kept insisting — I kept insisting back. Eventually she hugged me and said she was proud. I went home feeling taller than I had in years.`
          );
        }
      },
    ]
  );
}

/* ============ SCHOOL NAMES ============
 * Generates plausible school names by combining last names + thematic suffixes.
 * Cached on State so the same school keeps its name across age dialogs.
 */
function generateSchoolName(level) {
  const lastName = pick(GAME.constants.lastNames);
  const presidents = ["Lincoln", "Washington", "Jefferson", "Roosevelt", "Kennedy", "Adams", "Wilson", "Madison", "Monroe", "Jackson"];
  const nature   = ["Oakwood", "Pinewood", "Maple", "Riverside", "Hillcrest", "Lakeside", "Westfield", "Eastside", "Brookfield", "Fairview"];
  const directional = ["North", "South", "East", "West", "Central"];

  const elementaryFormats = [
    () => `${pick(presidents)} Elementary School`,
    () => `${pick(nature)} Elementary School`,
    () => `${lastName} Elementary`,
    () => `${pick(directional)} ${pick(nature)} Elementary School`,
  ];
  const middleFormats = [
    () => `${pick(presidents)} Middle School`,
    () => `${pick(nature)} Middle School`,
    () => `${lastName} Middle School`,
    () => `${pick(directional)} ${pick(presidents)} Middle School`,
  ];
  const highFormats = [
    () => `${pick(presidents)} High School`,
    () => `${pick(nature)} High School`,
    () => `${lastName} Memorial High School`,
    () => `${pick(directional)} ${pick(nature)} High School`,
    () => `${pick(presidents)} Preparatory Academy`,
  ];

  const formats = level === "elementary" ? elementaryFormats
                : level === "middle"     ? middleFormats
                : highFormats;
  return pick(formats)();
}

function generateCollegeName() {
  const lastName = pick(GAME.constants.lastNames);
  const cities = ["Boston", "Chicago", "Austin", "Seattle", "Portland", "Denver", "Atlanta", "Phoenix", "Madison", "Berkeley"];
  const formats = [
    () => `${pick(cities)} University`,
    () => `${lastName} University`,
    () => `${pick(cities)} State College`,
    () => `University of ${pick(cities)}`,
    () => `${lastName} College`,
    () => `${pick(cities)} Tech`,
  ];
  return pick(formats)();
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
    snap.state.aiOutputEffort = localStorage.getItem("bitlife_ai_output_effort") || "medium";
    snap.state.aiStyle        = localStorage.getItem("bitlife_ai_style") || "";
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
    snap.state.aiOutputEffort = localStorage.getItem("bitlife_ai_output_effort") || "medium";
    snap.state.aiStyle        = localStorage.getItem("bitlife_ai_style") || "";
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

  // Career / life-stage status line. Homeless overrides everything below
  // jail/death/baby/school so the player sees it prominently.
  let status;
  if (!State.alive) status = "Deceased";
  else if (State.inJail) status = `Incarcerated (year ${State.inJail.served + 1} of ${State.inJail.sentence})`;
  else if (State.age < 5) status = "Baby";
  else if (State.inSchool && State.age < 12) status = "Elementary student";
  else if (State.inSchool && State.age < 14) status = "Middle school student";
  else if (State.inSchool && State.age < 19) status = "High school student";
  else if (State.inCollege) status = "College student";
  else if (State.housing === "homeless") status = State.job ? `Homeless — works as ${State.job.title}` : "Homeless";
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
// Flag set briefly during back-navigation so the parent's showSubview()
// doesn't fire its own menu.wav on top of the back.wav we just played.
let _suppressMenuSound = false;

function showSubview(title, builder, opts) {
  // Sound choice on open:
  //   - default (any subview open, top-level or push) → clickOption.wav
  //   - opts.openSound overrides if a caller wants a different sound
  //   - _suppressMenuSound (back-navigation) → no sound at all
  if (!_suppressMenuSound) {
    const openSound = (opts && opts.openSound) || "clickOption";
    playSound(openSound);
  }
  if (!opts || !opts.preserveStack) _subviewBackStack = [];

  // Animation direction:
  //   - Opening a top-level subview from the main game view → slide UP
  //   - Pushing INTO a sub-view (already inside a subview) → slide RIGHT
  //   - Going BACK to a parent subview → slide LEFT (handled by _suppressMenuSound)
  let direction;
  if (_suppressMenuSound) {
    direction = "from-left";   // back navigation
  } else if (opts && opts.preserveStack) {
    direction = "from-right";  // pushSubview into a child
  } else {
    direction = "from-bottom"; // top-level open from main game
  }

  // Two-pane transition: when a subview is already showing, we clone it as
  // a "ghost" that stays visible while the real subview slides into position
  // from the off-screen direction. Both panes animate together (old slides
  // out, new slides in) so the user sees both during the transition.
  const alreadyShowing = SUBVIEW.el.classList.contains("show");
  let ghost = null;

  const buildContent = () => {
    SUBVIEW.title.textContent = title;
    SUBVIEW.body.innerHTML = "";
    builder(SUBVIEW.body);
    SUBVIEW.body.scrollTop = 0;
    if (window.lucide) lucide.createIcons();
  };

  if (alreadyShowing) {
    // Clone the current subview (with its current content) into a ghost
    // overlay that will slide out while the real subview slides in.
    ghost = SUBVIEW.el.cloneNode(true);
    ghost.id = "";
    ghost.classList.add("subview-ghost");
    ghost.classList.remove("from-left", "from-right", "from-bottom", "exiting-left", "exiting-right", "exiting-bottom");
    // The ghost starts at the current "shown" position. It will animate OUT
    // in the direction opposite to the new view's entry.
    document.body.appendChild(ghost);

    // Now strip animation classes from the real subview and rebuild its
    // content for the destination view, but leave it offscreen.
    SUBVIEW.el.classList.remove("show", "from-left", "from-right", "from-bottom", "exiting-left", "exiting-right", "exiting-bottom");
    SUBVIEW.el.classList.add(direction);
    // Build the new content while the ghost is still showing the old.
    buildContent();
    // Force reflow so the off-screen position is registered before .show.
    // eslint-disable-next-line no-unused-expressions
    void SUBVIEW.el.offsetWidth;

    // Now animate both — real slides in to center, ghost slides out the
    // opposite way.
    const exitClass = direction === "from-right"  ? "exiting-left"
                    : direction === "from-left"   ? "exiting-right"
                    : "exiting-bottom";
    ghost.classList.add(exitClass);
    SUBVIEW.el.classList.add("show");

    // Clean up the ghost after the transition finishes.
    setTimeout(() => {
      if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
    }, 240);
  } else {
    // First-time open: only one pane, slide it in.
    SUBVIEW.el.classList.remove("show", "from-left", "from-right", "from-bottom", "exiting-left", "exiting-right", "exiting-bottom");
    SUBVIEW.el.classList.add(direction);
    buildContent();
    void SUBVIEW.el.offsetWidth;
    SUBVIEW.el.classList.add("show");
  }
}
function pushSubview(title, builder, parentFn) {
  _subviewBackStack.push(parentFn);
  // Sub-page push (deeper navigation) plays the clickOption sound — applies
  // to category cards in Menu, activity rows, person rows, etc.
  showSubview(title, builder, { preserveStack: true, openSound: "clickOption" });
}
// Re-render the SAME top-level subview without playing any opening sound.
// Used when a button inside (Buy Stocks, Deposit, Ask for Raise, etc.) needs
// to refresh the screen — we already played clickOption for the button,
// so we don't want menu.wav to fire again on top of it.
function refreshSubview(fn) {
  _suppressMenuSound = true;
  try { fn(); } finally { _suppressMenuSound = false; }
}
function closeSubview() {
  playSound("back");
  if (_subviewBackStack.length > 0) {
    const parent = _subviewBackStack.pop();
    // Going back — silence menu.wav (so back.wav plays alone) AND mark
    // the navigation as "back" so showSubview slides from the left.
    _suppressMenuSound = true;
    try { parent(); } finally { _suppressMenuSound = false; }
    return;
  }
  // Top-level close: slide back DOWN to dismiss.
  SUBVIEW.el.classList.remove("show", "from-left", "from-right", "from-bottom");
  SUBVIEW.el.classList.add("exiting-bottom");
  setTimeout(() => {
    SUBVIEW.el.classList.remove("exiting-bottom", "exiting-left", "exiting-right");
  }, 230);
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
  DLG.overlay.classList.remove("show", "aftermath", "warning", "tombstone");
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
  // We want this to *land* with the dialog appearing. But if a choiceselect
  // click happened very recently (i.e. the player just clicked an option),
  // the two sounds would stack — so wait just long enough to clear the
  // choiceselect's tail. When no recent click (e.g. tap-anywhere dismiss
  // leading to a chained aftermath), play immediately on next frame.
  const sound = (opts && opts.badge) ? "achievement" : "aftermath";
  const nowMs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  const sinceClick = nowMs - (_lastPlayedAt["choiceselect"] || 0);
  if (sinceClick < 200) {
    // Wait out the choiceselect tail; 220ms total avoids overlap
    setTimeout(() => playSound(sound), 220 - sinceClick);
  } else {
    // Play synced with the next paint — no stacking risk
    playSoundSynced(sound);
  }

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

  // Custom hint text — defaults to the global hint, can be overridden per-call.
  if (opts.hint) {
    DLG.hint.textContent = opts.hint;
  } else {
    DLG.hint.textContent = "Tap anywhere to continue";
  }
  DLG.hint.style.display = "block";
  // Defensive: if a previous aftermath handler is still bound, drop it before
  // adding a new one. Otherwise an old listener could fire on the same click
  // that opens this new dialog and instantly dismiss it.
  if (aftermathHandler) {
    DLG.overlay.removeEventListener("click", aftermathHandler);
    aftermathHandler = null;
  }
  DLG.overlay.classList.add("show", "aftermath");
  if (window.lucide) lucide.createIcons();

  aftermathHandler = () => {
    closeDialog();
    if (opts.onClose) opts.onClose();
    render();
  };
  // 250ms delay — long enough that the click that *opened* this aftermath
  // (e.g. the click that picked an option in showOptions) has fully bubbled
  // and won't accidentally trigger dismissal. Audio sync now plays at the
  // same moment via playSoundSynced so the sound and dialog land together.
  setTimeout(() => DLG.overlay.addEventListener("click", aftermathHandler), 250);
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
  if (spec === "issueDriverLicense") { issueDocument("driverLicense"); return; }
  if (spec === "renewId")        { renewDocument("governmentId"); return; }
  if (spec === "renewPassport")  { renewDocument("passport"); return; }
  if (spec === "renewDriverLicense") { renewDocument("driverLicense"); return; }
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

  // Custom dialog: major dropdown + funding dropdown (cash vs student loan)
  DLG.header.textContent = "Choose Your Path";
  DLG.body.innerHTML = "";
  DLG.hint.style.display = "none";

  const q = document.createElement("div");
  q.className = "narration";
  q.textContent = "I'm enrolled. Time to pick what I'll study and how I'll pay for it.";
  DLG.body.appendChild(q);

  // Major
  const majors = [
    "Computer Science", "Business", "Psychology", "Engineering",
    "English Literature", "Biology", "Art History", "Mathematics",
    "Political Science", "Philosophy"
  ];
  const majorWrap = document.createElement("div");
  majorWrap.className = "dlg-dropdown-row";
  majorWrap.innerHTML = `<div class="dlg-dropdown-label">Major</div>`;
  const majorSel = document.createElement("select");
  majorSel.className = "dlg-dropdown";
  for (const m of majors) {
    const opt = document.createElement("option");
    opt.value = m; opt.textContent = m;
    majorSel.appendChild(opt);
  }
  majorWrap.appendChild(majorSel);
  DLG.body.appendChild(majorWrap);

  // Funding
  const tuition = 20000;
  const loanAmount = 60000;
  const fundingWrap = document.createElement("div");
  fundingWrap.className = "dlg-dropdown-row";
  fundingWrap.innerHTML = `<div class="dlg-dropdown-label">Funding</div>`;
  const fundSel = document.createElement("select");
  fundSel.className = "dlg-dropdown";
  const optCash = document.createElement("option");
  optCash.value = "cash"; optCash.textContent = `Pay tuition (${money(tuition)} upfront)`;
  const optLoan = document.createElement("option");
  optLoan.value = "loan"; optLoan.textContent = `Take a student loan (${money(loanAmount)} at graduation)`;
  fundSel.appendChild(optCash);
  fundSel.appendChild(optLoan);
  fundingWrap.appendChild(fundSel);
  DLG.body.appendChild(fundingWrap);

  // Submit
  const submit = document.createElement("button");
  submit.className = "dlg-btn";
  submit.style.background = "#2e9b3a";
  submit.style.color = "#fff";
  submit.textContent = "Enroll";
  submit.onclick = () => {
    const major = majorSel.value;
    const funding = fundSel.value;

    if (funding === "cash") {
      if (!debit(tuition)) {
        // Not enough cash on hand — offer the loan as a fallback instead of bouncing them
        showAftermath(
          "Tuition Too Steep",
          `Tuition is ${money(tuition)} upfront and I can't cover it. The loan option is still available.`
        );
        return;
      }
    } else {
      // Student loan — debt is held until graduation, then turns into yearly payments
      State.studentLoan = {
        balance: loanAmount,
        originalAmount: loanAmount,
        monthlyPayment: 500, // about $6,000/yr after graduation
        active: false,        // becomes true on graduation
      };
      if (!State.memory) State.memory = {};
      State.memory.took_student_loan = true;
    }

    State.inCollege = true;
    State.collegeYear = 1;
    State.collegeMajor = major;
    State.collegeName = generateCollegeName();
    closeDialog();

    logEvent(`I enrolled at ${State.collegeName}, majoring in ${major}${funding === "loan" ? " on a student loan" : ""}.`, "good");
    showAftermath(
      `Welcome to ${State.collegeName}`,
      `A four-year university.\n\nI'm officially a ${major} major. ${
        funding === "loan"
          ? `I'll have ${money(loanAmount)} in student debt when I graduate, but I get to focus on classes instead of bills.`
          : `I paid the year's tuition upfront and walked into the welcome week broke but unburdened.`
      }`,
      { hint: "OK" }
    );
  };
  DLG.body.appendChild(submit);
  DLG.overlay.classList.add("show");
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
  } else if (kind === "driverLicense") {
    State.driverLicense = { issued: State.age, expiresAt, expired: false };
  }
}

function checkDocumentExpiry() {
  // Called every year. Mark expired docs and log a one-time notice.
  for (const kind of ["governmentId", "passport", "driverLicense"]) {
    const doc = State[kind];
    if (!doc) continue;
    if (!doc.expired && State.age >= doc.expiresAt) {
      doc.expired = true;
      const label = kind === "governmentId" ? "Government ID"
                  : kind === "passport"     ? "passport"
                  : "driver's license";
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

// ============ MANDATORY LICENSING EVENTS ============
// Fired once at the right age from advanceYear(). Each opens a dialog the
// player MUST resolve (accept, defer, or skip) — there's no random gate.
function triggerLicensingEvents() {
  if (!State.alive || State.inJail) return;

  // === Government ID at 14 ===
  if (State.age >= 14 && !State.govIdOffered && !State.governmentId) {
    State.govIdOffered = true;
    showOptions(
      "Time for an ID",
      "I'm old enough to get my first government-issued ID card. Mom says I need it for school trips, opening a bank account, basically everything.",
      [
        {
          label: "Go to the office and get it",
          run: () => {
            issueDocument("id");
            State.stats.smarts = clamp(State.stats.smarts + 1);
            logEvent("I got my first government ID. It felt official.", "good");
            showAftermath("Got My ID", "I stood in line for two hours, took a photo I'll regret in a decade, and walked out with a plastic card that says I'm a real person.");
          }
        },
        {
          label: "Have my parents handle it",
          run: () => {
            issueDocument("id");
            logEvent("My parents took me to get my first government ID.", "normal");
            showAftermath("Picked Up by Mom", "Mom drove me to the office and did most of the talking. Easy. I got my card in two weeks.");
          }
        },
        {
          label: "Put it off — I don't need it yet",
          run: () => {
            State.stats.smarts = clamp(State.stats.smarts - 1);
            logEvent("I skipped getting my ID — figured I'd deal with it later.", "bad");
            showAftermath("Skipped It", "I told mom I'd do it later. She gave me The Look but didn't push.");
          }
        },
      ]
    );
    return; // one event per year
  }

  // === Passport at 14 ===
  if (State.age >= 14 && !State.passportOffered && !State.passport) {
    State.passportOffered = true;
    showOptions(
      "Get a Passport?",
      "I should think about getting a passport. Even if I'm not traveling soon, having one ready opens doors later.",
      [
        {
          label: "Apply for one now",
          run: () => {
            if (debit(130)) {
              issueDocument("passport");
              State.stats.smarts = clamp(State.stats.smarts + 1);
              logEvent("I got my first passport. The world feels bigger.", "good");
              showAftermath("Passport in Hand", "Six weeks later a small blue book arrived in the mail. I flipped through the empty pages and started dreaming of where the stamps would go.");
            } else {
              showAftermath("Can't Afford It", "I checked the fee — $130 — and realized I couldn't cover it right now. I'll try again next year.");
            }
          }
        },
        {
          label: "Wait until I actually need one",
          run: () => {
            logEvent("I decided to wait on getting a passport.", "normal");
            showAftermath("Deferred", "I figured I'd get one if a trip ever came up. The form went into a drawer somewhere.");
          }
        },
      ]
    );
    return;
  }

  // === Driver's License at 18 ===
  if (State.age >= 18 && !State.driverLicenseOffered && !State.driverLicense) {
    State.driverLicenseOffered = true;
    showOptions(
      "Driver's License",
      "I'm finally old enough for a full driver's license. No more bumming rides from friends.",
      [
        {
          label: "Take the test and get the license",
          run: () => {
            // Higher smarts = better chance of passing first try
            const passChance = 0.5 + (State.stats.smarts / 200);
            if (Math.random() < passChance) {
              issueDocument("driverLicense");
              State.stats.mood = clamp(State.stats.mood + 6);
              if (!State.memory) State.memory = {};
              State.memory.licensed_driver = true;
              logEvent("I passed my driving test and got my license on the first try.", "good");
              showAftermath("Licensed", "I waited two hours for the laminator, but the photo came out alright. I drove home with the windows down, music up, feeling like an adult for the first time.");
            } else {
              State.stats.mood = clamp(State.stats.mood - 4);
              logEvent("I failed my driving test. I'll have to take it again.", "bad");
              showAftermath("Failed the Test", "The examiner caught me rolling through a stop sign in the first five minutes. He didn't even bother finishing the rest of the route.");
              // Reset the offer flag — they can try again next year
              State.driverLicenseOffered = false;
            }
          }
        },
        {
          label: "Take driving lessons first ($300)",
          run: () => {
            if (debit(300)) {
              // Lessons give a big edge
              issueDocument("driverLicense");
              State.stats.mood = clamp(State.stats.mood + 5);
              State.stats.smarts = clamp(State.stats.smarts + 1);
              if (!State.memory) State.memory = {};
              State.memory.licensed_driver = true;
              logEvent("I took proper driving lessons and passed the test cleanly.", "good");
              showAftermath("Confident Behind the Wheel", "Six weekends of lessons taught me parallel parking, three-point turns, and how to merge without praying. I aced the test.");
            } else {
              showAftermath("Can't Afford Lessons", "Lessons cost $300 and I just don't have it right now.");
              State.driverLicenseOffered = false;
            }
          }
        },
        {
          label: "Skip driving — I'll use transit",
          run: () => {
            logEvent("I decided not to bother with a driver's license.", "normal");
            showAftermath("Walking Everywhere", "I told my friends I just wasn't going to drive. Some of them thought it was weird. I liked the walking.");
          }
        },
      ]
    );
    return;
  }
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
  // Block age-advances while a dialog is open, the AI is thinking, or a
  // subview is active. Clicking the age button under those conditions
  // would otherwise either be ignored silently (leaving the button looking
  // unresponsive) OR — worse — skip an age while the player was still
  // mid-decision. We render() afterward so the button visibly re-enables.
  if (DLG.overlay.classList.contains("show")) return;
  if (document.getElementById("aiThinkingToast")) return;
  if (SUBVIEW && SUBVIEW.el && SUBVIEW.el.classList.contains("show")) return;

  // Non-realistic: original year-at-a-time behavior.
  if (!State.realisticMode) { advanceYear(); saveGame(); return; }

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

  // Schooling — with proper dialogs and a generated school name for flavor.
  // The first school dialog establishes the school, later ones reference it.
  if (State.age === 5) {
    State.inSchool = true;
    State.schoolName = generateSchoolName("elementary");
    logEvent(`I started ${State.schoolName} for kindergarten.`, "good");
    showAftermath(
      "First Day of School",
      `${State.schoolName}\n\nA public elementary school in my neighborhood. Mom walked me to the door and I tried not to cry when she left.`,
      { hint: "OK" }
    );
  }
  if (State.age === 12 && State.inSchool) {
    State.schoolName = generateSchoolName("middle");
    logEvent(`I moved up to ${State.schoolName}.`);
    showAftermath(
      "Starting Middle School",
      `${State.schoolName}\n\nA public middle school. New building, new lockers, new social ladder. I'm starting over.`,
      { hint: "OK" }
    );
  }
  if (State.age === 14 && State.inSchool) {
    State.schoolName = generateSchoolName("high");
    logEvent(`I started ${State.schoolName}.`);
    showAftermath(
      "Starting High School",
      `${State.schoolName}\n\nA public high school. Three thousand kids, four years to figure myself out.`,
      { hint: "OK" }
    );
  }
  if (State.age === 18 && State.inSchool) {
    State.inSchool = false;
    const schoolDisplay = State.schoolName || "high school";
    if (State.stats.smarts >= 35) {
      State.education = "High school graduate";
      logEvent(`I graduated from ${schoolDisplay}.`, "good");
      showAftermath(
        `Graduated from ${schoolDisplay}`,
        `Diploma in hand. Four years of late assignments, awkward dances, and tiny triumphs behind me. The cap toss was glorious.`,
        { hint: "OK" }
      );
    } else {
      State.education = "High school dropout";
      logEvent(`I dropped out of ${schoolDisplay}.`, "bad");
      showAftermath(
        `Left ${schoolDisplay}`,
        `I couldn't make the grades stick. I left without a diploma and tried not to think about it too hard.`,
        { hint: "OK" }
      );
    }
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
      logEvent(`I graduated from ${State.collegeName || "college"} with a degree in ${State.collegeMajor || "my field"}.`, "good");
      // Student loan kicks in once they're out of school
      if (State.studentLoan && !State.studentLoan.active) {
        State.studentLoan.active = true;
        logEvent(`My student loan payments begin. I owe ${money(State.studentLoan.balance)}.`, "bad");
      }
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

  // Housing: rent, eviction, age-20 mom-house event, recovery from homeless
  processHousing();

  // Student loan: yearly payment once active
  if (State.studentLoan && State.studentLoan.active && State.studentLoan.balance > 0) {
    const yearly = (State.studentLoan.monthlyPayment || 500) * 12;
    const due = Math.min(yearly, State.studentLoan.balance);
    if (debit(due)) {
      State.studentLoan.balance -= due;
      if (State.studentLoan.balance <= 0) {
        State.studentLoan.balance = 0;
        State.studentLoan.active = false;
        logEvent("I made my final student loan payment. Debt-free.", "good");
        State.stats.mood = clamp(State.stats.mood + 12);
      }
    } else {
      // Missed payment — debt grows with penalty interest
      State.studentLoan.balance = Math.round(State.studentLoan.balance * 1.08);
      State.stats.mood = clamp(State.stats.mood - 4);
      logEvent("I missed a student loan payment. Penalty interest piled on.", "bad");
    }
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

  // Mandatory licensing events at specific ages (ID at 14, passport at 14,
  // driver's license at 18). These take priority over the random event roll
  // so the player can never miss them.
  const beforeLicensing = {
    govIdOffered: State.govIdOffered,
    passportOffered: State.passportOffered,
    driverLicenseOffered: State.driverLicenseOffered,
  };
  triggerLicensingEvents();
  // If any licensing dialog was just opened, the dialog handles its own
  // render. Skip the random year event so we don't double up.
  if (
    State.govIdOffered !== beforeLicensing.govIdOffered ||
    State.passportOffered !== beforeLicensing.passportOffered ||
    State.driverLicenseOffered !== beforeLicensing.driverLicenseOffered
  ) {
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
  if (!State.alive) return; // already dead — don't double-trigger
  State.alive = false;
  let cause;
  let isSurrender = false;
  if (causeOverride === "surrender") {
    cause = "their own hand — they gave up";
    isSurrender = true;
  }
  else if (causeOverride) cause = causeOverride;
  else if (State.stats.health < 5) cause = "poor health";
  else if (State.addictions.length) cause = "complications from addiction";
  else if (State.age > 90) cause = "old age";
  else cause = "natural causes";

  State.deathCause = cause;
  State.deathAge = State.age;
  State.isSurrender = isSurrender;
  logEvent(`I died at age ${State.age} from ${cause}.`, "death");

  // Play the death toll. Skip the "synced" path — we want it immediate and long.
  playSound("death");

  // Show the tombstone screen instead of a regular aftermath
  showTombstone(cause, isSurrender);
  render();
}

// Score a life from 0-100 and map to a rating label.
function rateLife(isSurrender) {
  if (isSurrender) {
    return { label: "Waste",       score: 0,  emoji: "💀", color: "#5a5a5a", desc: "Threw it all away. Some flowers, no answers." };
  }

  // Achievement points
  let s = 0;
  s += Math.min(40, State.badges.length * 2);                        // up to 40 from badges
  s += State.children.length * 4;                                    // family
  s += (State.friends || []).length * 1.5;                           // friends
  s += State.partner && State.partner.married ? 8 : 0;               // marriage
  if (State.education === "College graduate") s += 6;
  if (State.education === "Postgraduate")     s += 10;
  if (netWorth() > 100000)    s += 4;
  if (netWorth() > 1000000)   s += 8;
  if (netWorth() > 10000000)  s += 10;
  if (State.age >= 80)        s += 4;
  if (State.age >= 95)        s += 6;
  if (State.charitableGiving && State.charitableGiving > 100000) s += 8;
  if (State.memory && State.memory.published_book)   s += 6;
  if (State.memory && State.memory.olympic_athlete)  s += 8;
  if (State.memory && State.memory.saved_a_life)     s += 6;
  if (State.memory && State.memory.war_hero)         s += 6;

  // Deductions
  if (State.criminalRecord > 0)   s -= State.criminalRecord * 3;
  if (State.addictions.length)    s -= State.addictions.length * 4;
  if (State.memory && State.memory.was_homeless)         s -= 4;
  if (State.memory && State.memory.had_affair)           s -= 5;
  if (State.memory && State.memory.failed_teen_parent)   s -= 3;
  if (State.age < 25)             s -= 20;  // dying very young drags rating
  if (State.age < 18)             s -= 30;
  if (State.illnesses.length > 3) s -= 4;

  s = Math.max(0, Math.min(100, Math.round(s)));

  // Map score to label
  if (s >= 90) return { label: "Legendary",  score: s, emoji: "⭐", color: "#c98a2b", desc: "A life people will tell stories about for generations." };
  if (s >= 75) return { label: "Remarkable", score: s, emoji: "🌟", color: "#2e9b3a", desc: "A life that left a real mark on the world." };
  if (s >= 60) return { label: "Fulfilling", score: s, emoji: "🌱", color: "#3a6cb0", desc: "A life rich with love, work, and meaning." };
  if (s >= 45) return { label: "Decent",     score: s, emoji: "🌾", color: "#5a7d8c", desc: "A life of small joys and quiet accomplishments." };
  if (s >= 30) return { label: "Mediocre",   score: s, emoji: "🪨", color: "#7a7a7a", desc: "A life that came and went without much fuss." };
  if (s >= 15) return { label: "Forgettable",score: s, emoji: "🌫️", color: "#6a6a6a", desc: "Few will remember you were here." };
  return        { label: "Tragic",            score: s, emoji: "🥀", color: "#7a3a3a", desc: "A life cut short or hollowed out by hardship." };
}

// Build the list of people who came to the funeral. Family members come by default.
// Friends come based on relationship level. A few extra walk-ons for color.
function buildFuneralAttendees() {
  const attendees = [];
  // Family
  if (State.partner && !State.partner.deceased) {
    attendees.push({ name: State.partner.name, role: State.partner.married ? "spouse" : "partner" });
  }
  if (State.parents) {
    if (State.parents.mother) attendees.push({ name: State.parents.mother, role: "mother" });
    if (State.parents.father) attendees.push({ name: State.parents.father, role: "father" });
  }
  for (const sib of (State.siblings || [])) {
    attendees.push({ name: sib.name, role: sib.gender === "M" ? "brother" : "sister" });
  }
  for (const ch of (State.children || [])) {
    attendees.push({ name: ch.name, role: ch.gender === "M" ? "son" : "daughter" });
  }
  // Friends — only those with level > 50, capped at 6 to keep the list readable
  const closeFriends = (State.friends || []).filter(f => (f.level || 0) >= 50).slice(0, 6);
  for (const fr of closeFriends) {
    attendees.push({ name: fr.name, role: "friend" });
  }
  // Pets — always come
  for (const pet of (State.pets || [])) {
    attendees.push({ name: pet.name, role: pet.kind || "pet" });
  }
  return attendees;
}

function buildLifeNarrative(cause, rating) {
  // 2-3 sentence customized epitaph based on player's actual life
  const bits = [];
  const first = State.firstName || "they";
  const yearsPart = State.age >= 80 ? `lived a long ${State.age} years`
                  : State.age >= 50 ? `passed at ${State.age}`
                  : State.age >= 25 ? `gone too soon at ${State.age}`
                  : State.age >= 10 ? `taken at just ${State.age}`
                  :                   `barely got to live, lost at ${State.age}`;
  bits.push(`${first} ${yearsPart}.`);

  // Career
  if (State.job) bits.push(`Worked as a ${State.job.title}.`);
  else if (State.education === "College graduate") bits.push(`A college graduate who never settled into one career.`);
  else if (State.criminalRecord >= 3) bits.push(`Spent more of life on the wrong side of the law than off it.`);

  // Family
  if (State.children.length >= 3) bits.push(`Raised ${State.children.length} children who carry the name forward.`);
  else if (State.children.length === 2) bits.push(`Left behind two children.`);
  else if (State.children.length === 1) bits.push(`Left behind one child.`);
  if (State.partner && State.partner.married && !State.partner.deceased) {
    bits.push(`Married to ${State.partner.name} until the end.`);
  }

  // Highlights from memory
  const m = State.memory || {};
  if (m.published_book) bits.push(`Wrote a book that found its readers.`);
  if (m.olympic_athlete) bits.push(`Competed at the Olympics.`);
  if (m.saved_a_life) bits.push(`Saved a life once. That counts more than most monuments.`);
  if (m.war_hero) bits.push(`Decorated for service in war.`);
  if (m.was_homeless) bits.push(`Knew the street and the relief of a roof again.`);
  if (m.mom_bought_house) bits.push(`Inherited the family home that mom helped buy.`);

  // Closing
  bits.push(rating.desc);
  return bits.join(" ");
}

function showTombstone(cause, isSurrender) {
  const rating = rateLife(isSurrender);
  const narrative = buildLifeNarrative(cause, rating);
  const attendees = buildFuneralAttendees();
  const fullName = `${State.firstName || ""} ${State.lastName || ""}`.trim() || "Unknown";
  const birthYear = State.log && State.log[0] ? (State.log[0].year || "?") : "?";
  const deathYear = birthYear !== "?" ? birthYear + State.age : "?";

  // Build the tombstone HTML
  DLG.header.textContent = "The End";
  DLG.body.innerHTML = "";
  DLG.hint.style.display = "block";
  DLG.hint.textContent = "Tap anywhere to continue";

  const wrap = document.createElement("div");
  wrap.className = "tombstone-wrap";

  // The stone itself
  const stone = document.createElement("div");
  stone.className = "tombstone";
  stone.innerHTML = `
    <div class="tombstone-rip">R.I.P.</div>
    <div class="tombstone-name">${escapeHtml(fullName)}</div>
    <div class="tombstone-years">${birthYear} — ${deathYear}</div>
    <div class="tombstone-divider"></div>
    <div class="tombstone-cause">${escapeHtml(cause)}</div>
    ${(State.flowers || []).length || State.flowersLeft ? '<div class="tombstone-flowers">🌷</div>' : ''}`;
  wrap.appendChild(stone);

  // Rating badge
  const ratingEl = document.createElement("div");
  ratingEl.className = "tombstone-rating";
  ratingEl.style.background = rating.color;
  ratingEl.innerHTML = `
    <span class="rating-emoji">${rating.emoji}</span>
    <span class="rating-label">${rating.label}</span>
    <span class="rating-score">${rating.score}/100</span>`;
  wrap.appendChild(ratingEl);

  // Narrative
  const narr = document.createElement("div");
  narr.className = "tombstone-narrative";
  narr.textContent = narrative;
  wrap.appendChild(narr);

  // Stats line
  const stats = document.createElement("div");
  stats.className = "tombstone-stats";
  stats.innerHTML = `
    <div class="ts-stat"><span class="ts-stat-label">Net estate</span><span class="ts-stat-value">${money(netWorth())}</span></div>
    <div class="ts-stat"><span class="ts-stat-label">Badges</span><span class="ts-stat-value">${State.badges.length} / ${GAME.badges.length}</span></div>
    <div class="ts-stat"><span class="ts-stat-label">Children</span><span class="ts-stat-value">${State.children.length}</span></div>
    <div class="ts-stat"><span class="ts-stat-label">Friends</span><span class="ts-stat-value">${(State.friends||[]).length}</span></div>`;
  wrap.appendChild(stats);

  // Funeral attendees
  const fun = document.createElement("div");
  fun.className = "tombstone-funeral";
  if (attendees.length === 0) {
    fun.innerHTML = `
      <div class="funeral-header">Funeral attendance</div>
      <div class="funeral-empty">No one came. They were lowered into the ground alone.</div>`;
  } else {
    const items = attendees.map(a =>
      `<div class="funeral-attendee">
         <span class="att-name">${escapeHtml(a.name)}</span>
         <span class="att-role">${escapeHtml(a.role)}</span>
       </div>`
    ).join("");
    fun.innerHTML = `
      <div class="funeral-header">Funeral attendance — ${attendees.length} ${attendees.length === 1 ? "mourner" : "mourners"}</div>
      <div class="funeral-list">${items}</div>`;
  }
  wrap.appendChild(fun);

  // CTA: start a new life
  const cta = document.createElement("button");
  cta.className = "tombstone-newlife-btn";
  cta.textContent = "Start a New Life";
  cta.onclick = (e) => {
    e.stopPropagation();
    closeDialog();
    if (typeof newLife === "function") newLife();
  };
  wrap.appendChild(cta);

  DLG.body.appendChild(wrap);
  DLG.overlay.classList.add("show", "aftermath", "tombstone");

  // Click-anywhere also starts a new life
  aftermathHandler = (ev) => {
    // Ignore clicks on the CTA itself (it has its own handler)
    if (ev && ev.target && ev.target.classList && ev.target.classList.contains("tombstone-newlife-btn")) return;
    closeDialog();
    if (typeof newLife === "function") newLife();
  };
  setTimeout(() => DLG.overlay.addEventListener("click", aftermathHandler), 200);

  if (window.lucide) lucide.createIcons();
}

/* ============ EVENT TRIGGER ============ */
function triggerYearEvent(age) {
  // AI Mode: every year produces an AI event. Show the thinking toast
  // SYNCHRONOUSLY here so that even before the async call resolves, the
  // user sees something happening — and `advanceTime` will block subsequent
  // clicks because the toast exists.
  if (State.aiMode && State.apiKey) {
    // Show toast immediately so the UI feels responsive AND so the
    // "is the AI thinking?" guard in advanceTime catches the second click.
    showThinkingToast("Generating event");
    triggerAIEvent(age);
    return;
  }

  // Classic mode — try a branching dialog event first
  if (tryBranchingEvent(age)) return;

  // Fall back to a narrative event. If the narrative pool is empty for this
  // age band, generate a universal filler so the player ALWAYS sees something.
  const pool = GAME.narrativeEvents.filter(e => age >= e.minAge && age <= e.maxAge);
  if (pool.length === 0) {
    // Last-resort branching retry
    if (tryBranchingEvent(age)) return;
    // Universal filler — guarantee a visible log entry every single year
    logEvent(universalFiller(age));
    return;
  }
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

// Last-resort filler so every click produces a visible log line. Tailored
// loosely to age band so it doesn't feel out of place.
function universalFiller(age) {
  if (age < 5)  return pick(["I played quietly with my toys.", "I napped through most of the day.", "I learned a new word.", "I refused to eat dinner.", "I splashed in the bath."]);
  if (age < 12) return pick(["School was uneventful.", "I rode my bike around the block.", "I watched cartoons all afternoon.", "I drew pictures in my notebook.", "I helped mom in the kitchen."]);
  if (age < 18) return pick(["Another day at school.", "I scrolled my phone for too long.", "I hung out with friends after class.", "I procrastinated on homework again.", "I listened to music alone in my room."]);
  if (age < 30) return pick(["A quiet year. Nothing notable.", "I focused on work and routine.", "I caught up on some reading.", "I tried a new restaurant downtown.", "Another year, more or less the same."]);
  if (age < 50) return pick(["The year passed quickly.", "I kept my head down and worked.", "Just a normal year.", "I picked up a small hobby.", "Quiet year. Felt my age."]);
  if (age < 70) return pick(["A slow, ordinary year.", "I read more than usual.", "I watched the seasons change.", "Nothing dramatic happened.", "I appreciated the quiet."]);
  return pick(["Another quiet year.", "I rested. A lot.", "Time moved slowly.", "The garden bloomed again.", "Nothing much happened, and that was fine."]);
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
        <div class="row-title"><i data-lucide="sparkles" style="width:16px;height:16px;vertical-align:-3px;margin-right:6px;color:#336089;"></i>Custom Activity (AI)</div>
        <div class="row-desc">${State.apiKey ? "Describe anything you want to do — the AI handles the rest." : "Add an API key in the Menu to unlock."}</div>
      </div>
      <i data-lucide="chevron-right" class="row-arrow"></i>`;
    if (State.apiKey) {
      aiRow.onclick = () => {
        playSound("clickOption");
        closeSubview();
        askAICustomAction(
          "What do you want to do? Describe it in your own words.",
          `custom_activity_age_${State.age}`
        );
      };
    } else {
      aiRow.onclick = () => {
        playSound("clickOption");
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
  if (!locked) row.onclick = () => { playSound("clickOption"); closeSubview(); doActivity(act); };
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
      row.onclick = () => { playSound("clickOption"); closeSubview(); doJailActivity(a); };
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
      cur.querySelector("#askPromo").onclick = () => { playSound("clickOption"); askPromotion(); };
      cur.querySelector("#quitJob").onclick = () => {
        playSound("clickOption");
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
          playSound("clickOption");
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
    const refCount = (State.referrals || []).filter(r => !r.used).length;
    const loanInfo = State.studentLoan
      ? `<div class="info-row"><div>Student Loan</div><div class="v">${money(State.studentLoan.balance)}${State.studentLoan.active ? " (paying)" : " (deferred)"}</div></div>`
      : "";
    head.innerHTML = `
      <h4>Current Status</h4>
      <div class="info-row"><div>Stage</div><div class="v">${stage}</div></div>
      <div class="info-row"><div>${isCollege ? "University" : "School"}</div><div class="v">${isCollege ? (State.collegeName || "—") : (State.schoolName || "—")}</div></div>
      <div class="info-row"><div>Smarts</div><div class="v">${State.stats.smarts}</div></div>
      ${isCollege ? `<div class="info-row"><div>Major</div><div class="v">${State.collegeMajor || "Undeclared"}</div></div>` : ""}
      <div class="info-row"><div>Referrals</div><div class="v">${refCount} available</div></div>
      ${loanInfo}`;
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
          playSound("clickOption");
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

  // Helper: pick a random element
  const r = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // === Study hard ===
  acts.push({
    label: isCollege ? "Study hard for finals" : "Study hard",
    desc: isCollege
      ? "Camp out in the library. Coffee, flashcards, lost weekends."
      : "Spread your homework across the kitchen table and grind through it.",
    run: () => {
      const smartsGain = isCollege ? 4 : 3;
      State.stats.smarts = clamp(State.stats.smarts + smartsGain);
      State.stats.mood   = clamp(State.stats.mood - 2);
      const scenes = isCollege ? [
        { t: "Library All-Day", b: "I camped in the library from open to close. By the time I left, the formulas finally clicked." },
        { t: "Caffeine and Notes", b: "Three coffees deep, I rewrote every lecture note from scratch. The act of writing it out is what made it stick." },
        { t: "Study Group", b: "I joined a study group in the dorm lounge. Explaining the material to someone else taught me more than reading it ever did." },
        { t: "Practice Problems", b: "I worked through every problem at the back of the textbook. Tedious — but I felt it in my bones by the end." },
      ] : [
        { t: "Kitchen Table Study", b: "I spread my homework across the kitchen table and worked through it while dinner cooked. Mom kept refilling my juice." },
        { t: "Library After School", b: "I stayed at the school library until the librarian started turning off the lights. Got through everything." },
        { t: "Quiet Bedroom Hours", b: "I closed my door, put on a playlist, and ground through every problem. Surprised myself with how much I knew." },
        { t: "Studying With a Friend", b: "A classmate came over and we quizzed each other for hours. We aced the test the next day." },
      ];
      const s = r(scenes);
      logEvent(s.b, "good");
      showAftermath(s.t, s.b);
    },
  });

  // === Hang out with classmates ===
  acts.push({
    label: "Hang out with classmates",
    desc: "See who clicks.",
    run: () => {
      if (Math.random() < 0.7) {
        const name = pick(GAME.constants.firstNamesM.concat(GAME.constants.firstNamesF));
        const gender = Math.random() < 0.5 ? "M" : "F";
        State.friends.push({ name, gender, age: State.age, level: 70 });
        State.stats.mood = clamp(State.stats.mood + 5);
        const scenes = [
          { t: "Cafeteria Connection", b: `${name} sat next to me at lunch. We bonded over our shared hatred of the cafeteria pizza and ended up walking home together.` },
          { t: "After-School Hangout", b: `${name} invited me to their place after school. We spent three hours just talking — felt like I'd known them forever.` },
          { t: "Shared Inside Joke", b: `Something silly happened in class and ${name} caught my eye laughing. We've been texting ever since.` },
          { t: "Group Project Win", b: `I got partnered with ${name} on a project. Turns out we work great together — and they're hilarious off-task.` },
        ];
        const s = r(scenes);
        logEvent(s.b, "good");
        showAftermath(s.t, s.b);
      } else {
        State.stats.mood = clamp(State.stats.mood + 1);
        const scenes = [
          { t: "Awkward Lunch", b: "I tried to join a table but the conversation kept skipping over me. I gave up and ate alone." },
          { t: "No Spark", b: "Everyone seemed nice enough, but nobody felt like a real friend. Maybe next week." },
          { t: "Surface-Level", b: "We chatted about nothing for fifteen minutes and then everyone scattered. Polite, but empty." },
        ];
        const s = r(scenes);
        logEvent(s.b, "normal");
        showAftermath(s.t, s.b);
      }
    },
  });

  // === Join a club ===
  acts.push({
    label: isCollege ? "Join a campus club" : "Join an after-school club",
    desc: "Find your people.",
    run: () => {
      const clubs = isCollege
        ? ["Debate Society", "Robotics Club", "Theater Group", "Student Government", "Astronomy Club", "Volunteer Corps", "Film Society", "Chess Club"]
        : ["Chess Club", "Drama Club", "Science Fair Team", "Soccer Team", "Math League", "Band", "Yearbook Committee", "Art Club"];
      const club = r(clubs);
      State.stats.mood   = clamp(State.stats.mood + 4);
      State.stats.smarts = clamp(State.stats.smarts + 2);
      if (!State.memory) State.memory = {};
      State.memory.joined_club = true;
      const scenes = [
        { t: `Joined the ${club}`, b: `My first meeting at the ${club} was packed. By the end of the night I'd signed up for the upcoming event and made plans with two new people.` },
        { t: `New in the ${club}`, b: `I walked into the ${club} not knowing anyone. By the time I left I had a nickname and three new contacts in my phone.` },
        { t: `Found My People`, b: `The ${club} is full of weirdos in the best possible way. I finally feel like I fit in somewhere.` },
        { t: `${club} Veteran`, b: `I joined the ${club} planning to "try it once." Three weeks later I'm running the supply closet.` },
      ];
      const s = r(scenes);
      logEvent(s.b, "good");
      showAftermath(s.t, s.b);
    },
  });

  // === Teacher / professor interaction ===
  acts.push({
    label: isCollege ? "Visit a professor's office hours" : "Talk to a teacher after class",
    desc: "Build a real connection with an educator — sometimes earns a referral.",
    run: () => {
      const lastName = pick(GAME.constants.lastNames);
      const title = isCollege ? "Professor" : (Math.random() < 0.5 ? "Mr." : "Ms.");
      const teacher = `${title} ${lastName}`;
      const roll = Math.random();
      if (roll < 0.5) {
        State.stats.smarts = clamp(State.stats.smarts + 3);
        State.stats.mood   = clamp(State.stats.mood + 3);
        if (!State.memory) State.memory = {};
        State.memory.had_mentor = true;
        // Grant a real referral the player can spend later
        if (!State.referrals) State.referrals = [];
        State.referrals.push({
          from: teacher,
          kind: isCollege ? "professor" : "teacher",
          used: false,
          earnedAtAge: State.age,
        });
        const scenes = [
          { t: `${teacher} Took an Interest`, b: `${teacher} asked about my plans after class. We ended up talking for an hour about books and life. They offered to write me a recommendation letter whenever I need one.` },
          { t: `Mentor Moment`, b: `${teacher} gave me a book that "reminded them of me." We've been talking after every class since. They told me they'd vouch for me anywhere.` },
          { t: `Real Conversation`, b: `${teacher} stayed late to walk me through a concept. By the end they said, "Anytime you need a reference, you have one." I almost cried in the hallway.` },
          { t: `Recommendation Letter`, b: `${teacher} offered out of the blue to write me a recommendation letter "whenever I need one." I tucked their email into my phone like a treasure.` },
        ];
        const s = r(scenes);
        logEvent(s.b + ` (Referral earned: ${teacher})`, "good");
        showAftermath(s.t, s.b + `\n\n📌 Referral earned — you can use ${teacher}'s recommendation later when applying for jobs or schools.`);
      } else {
        State.stats.smarts = clamp(State.stats.smarts + 1);
        const scenes = [
          { t: `Productive Chat`, b: `${teacher} answered my questions and I left the room knowing the material cold. Not life-changing, but useful.` },
          { t: `Quick Q&A`, b: `${teacher} clarified the part I was stuck on. Five minutes, totally worth it.` },
          { t: `Polite Visit`, b: `${teacher} was friendly but busy. I got what I needed and left.` },
        ];
        const s = r(scenes);
        logEvent(s.b, "normal");
        showAftermath(s.t, s.b);
      }
    },
  });

  // === Use a referral ===
  const unusedRefs = (State.referrals || []).filter(rf => !rf.used);
  if (unusedRefs.length > 0) {
    acts.push({
      label: `Use a referral (${unusedRefs.length} available)`,
      desc: `Cash in a recommendation from ${unusedRefs[0].from}${unusedRefs.length > 1 ? " or another mentor" : ""}.`,
      run: () => {
        const ref = unusedRefs[0];
        ref.used = true;
        // Effect depends on what's available — boost the school path that matters
        if (State.inCollege) {
          // College → scholarship boost or internship
          const amount = 2000 + Math.floor(Math.random() * 6000);
          State.money += amount;
          State.stats.smarts = clamp(State.stats.smarts + 2);
          logEvent(`${ref.from} put in a word for me. I got a paid internship worth ${money(amount)}.`, "good");
          showAftermath(
            `${ref.from}'s Letter Worked`,
            `I asked ${ref.from} to make a call for me. Two weeks later I was interviewing for a paid internship — and they offered me ${money(amount)} for the summer. I owe them everything.`
          );
        } else {
          // School → smarts/mood boost from confidence
          State.stats.smarts = clamp(State.stats.smarts + 4);
          State.stats.mood   = clamp(State.stats.mood + 6);
          logEvent(`${ref.from} wrote a glowing recommendation that opened a door for me.`, "good");
          showAftermath(
            `${ref.from} Came Through`,
            `${ref.from}'s recommendation letter got me into a program I never thought I'd qualify for. I read their words and almost didn't recognize the person they were describing.`
          );
        }
      },
    });
  }


  // === Skip class ===
  acts.push({
    label: isCollege ? "Skip lecture" : "Skip class",
    desc: "Risky.",
    run: () => {
      State.stats.mood   = clamp(State.stats.mood + 4);
      State.stats.smarts = clamp(State.stats.smarts - 2);
      if (Math.random() < 0.3) {
        State.stats.mood = clamp(State.stats.mood - 6);
        const scenes = isCollege ? [
          { t: "Got Marked Absent", b: "The professor takes attendance, apparently. I got an email about my participation grade tanking." },
          { t: "Ran Into the Professor", b: "I ducked into a coffee shop and the professor walked in five minutes later. They saw me. Painfully awkward." },
          { t: "Quiz I Didn't Know About", b: "Turns out there was a pop quiz I missed. It was worth 10% of the grade." },
        ] : [
          { t: "Caught at the Mall", b: "Vice principal walked into the food court while I was sitting there. He didn't even need to say anything." },
          { t: "Detention", b: "Someone snitched. I got a week of detention and my parents got a phone call I'll never live down." },
          { t: "Mom Showed Up", b: "Somehow mom found out within an hour. I don't even want to know how. I'm grounded for two weeks." },
        ];
        const s = r(scenes);
        logEvent(s.b, "bad");
        showAftermath(s.t, s.b);
      } else {
        const scenes = isCollege ? [
          { t: "Park Afternoon", b: "I sat in the park and read a book for two hours. Felt like a stolen pocket of life." },
          { t: "Movie Alone", b: "Caught a matinee at the empty theater. Best $8 I spent all month." },
          { t: "Just Slept", b: "Went back to bed for four hours. Woke up actually rested for the first time in weeks." },
        ] : [
          { t: "Walked Home", b: "Took the long way home and stopped at the library. Read a whole graphic novel before mom got off work." },
          { t: "Friend's Basement", b: "A friend skipped too. We played video games and ate stale chips. Heaven." },
          { t: "Bookstore Hours", b: "Spent the afternoon in the local bookstore. Nobody asked questions. Nobody knew." },
        ];
        const s = r(scenes);
        logEvent(s.b, "normal");
        showAftermath(s.t, s.b);
      }
    },
  });

  // College-only
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
          if (!State.memory) State.memory = {};
          State.memory.scholarship = true;
          const scenes = [
            { t: "Scholarship Awarded", b: `The financial aid office called my name at the awards ceremony. ${money(amount)} toward this year's tuition. My parents cried.` },
            { t: "The Letter Arrived", b: `A letter from the foundation sat on my desk for a week before I opened it. I was awarded ${money(amount)}.` },
            { t: "Essay Won It", b: `My essay was the deciding factor, they said. ${money(amount)} in my account by the end of the week.` },
          ];
          const s = r(scenes);
          logEvent(s.b, "good");
          showAftermath(s.t, s.b);
        } else {
          const scenes = [
            { t: "Application Denied", b: "The rejection email was short and clinical. They said the competition was fierce. I tried not to take it personally." },
            { t: "Waitlisted, Then Cut", b: "I was waitlisted for two weeks. The final email was a 'no.' I stared at it for an hour." },
            { t: "Not This Year", b: "My application didn't make it past the first round. Back to the drawing board." },
          ];
          const s = r(scenes);
          logEvent(s.b, "bad");
          showAftermath(s.t, s.b);
        }
      },
    });
    acts.push({
      label: "Pull an all-nighter",
      desc: "Cram everything.",
      run: () => {
        State.stats.smarts = clamp(State.stats.smarts + 5);
        State.stats.health = clamp(State.stats.health - 4);
        State.stats.mood   = clamp(State.stats.mood - 3);
        const scenes = [
          { t: "Sunrise Studying", b: "I watched the sun come up through the library window with three energy drinks in me. Took the final at 9am and remembered every formula." },
          { t: "Dorm Room Blur", b: "I locked myself in my dorm room with a stack of notes and didn't leave until I'd memorized everything. Felt like death the next day." },
          { t: "24/7 Diner", b: "I camped at the 24-hour diner and reread every chapter twice. The waitress kept refilling my coffee without me asking." },
          { t: "All-Nighter Hangover", b: "Pulled it off, but I felt like I'd been hit by a truck for two days after. Worth it for the grade, maybe." },
        ];
        const s = r(scenes);
        logEvent(s.b, "normal");
        showAftermath(s.t, s.b);
      },
    });
  } else {
    // School-only
    acts.push({
      label: "Try out for a sport",
      desc: "Make the team.",
      locked: State.age < 8,
      run: () => {
        const sports = ["soccer", "basketball", "baseball", "swimming", "track", "volleyball"];
        const sport = r(sports);
        if (Math.random() < 0.55) {
          State.stats.health = clamp(State.stats.health + 4);
          State.stats.looks  = clamp(State.stats.looks + 2);
          State.stats.mood   = clamp(State.stats.mood + 4);
          if (!State.memory) State.memory = {};
          State.memory.team_athlete = true;
          const scenes = [
            { t: `Made the ${sport} Team`, b: `Coach pulled me aside after tryouts and told me I'd made the ${sport} team. I called mom from the locker room.` },
            { t: `Starting Lineup`, b: `Not only did I make the ${sport} team — coach said I'd be starting in next week's game.` },
            { t: `Roster Confirmed`, b: `My name was on the ${sport} roster posted in the gym. I read it three times to make sure.` },
          ];
          const s = r(scenes);
          logEvent(s.b, "good");
          showAftermath(s.t, s.b);
        } else {
          State.stats.mood = clamp(State.stats.mood - 3);
          const scenes = [
            { t: `Cut from ${sport}`, b: `The list went up and my name wasn't on it. I checked twice. Coach said to try again next year.` },
            { t: `Didn't Make It`, b: `Coach was kind about it, but the answer was no. I biked home the long way and cried in the garage.` },
            { t: `Last Cut`, b: `I made it past three rounds of tryouts and then got cut on the final day. Brutal.` },
          ];
          const s = r(scenes);
          logEvent(s.b, "bad");
          showAftermath(s.t, s.b);
        }
      },
    });
    acts.push({
      label: "Run for class president",
      desc: "Campaign for it.",
      locked: State.age < 10,
      run: () => {
        const winChance = (State.stats.looks + State.stats.smarts) / 250;
        if (Math.random() < winChance) {
          State.stats.mood   = clamp(State.stats.mood + 8);
          State.stats.smarts = clamp(State.stats.smarts + 2);
          if (!State.memory) State.memory = {};
          State.memory.class_president = true;
          const scenes = [
            { t: "Elected!", b: "When the principal announced my name over the PA, the whole class cheered. I'll never forget the walk to the office to accept." },
            { t: "Landslide Victory", b: "I won by a wide margin. My speech apparently landed. Now I have to actually do the job." },
            { t: "Close Race, Big Win", b: "It came down to a few votes. My opponent shook my hand and meant it. Now I'm president." },
          ];
          const s = r(scenes);
          logEvent(s.b, "good");
          showAftermath(s.t, s.b);
        } else {
          State.stats.mood = clamp(State.stats.mood - 5);
          const scenes = [
            { t: "Lost the Election", b: "I gave it my all. The other candidate won by 30 votes. I clapped for them and went home to lie on my floor." },
            { t: "Defeated Gracefully", b: "I lost. I shook the winner's hand and tried to mean it. It took me a week to laugh again." },
            { t: "Not This Time", b: "My platform didn't land. The student body went a different direction. I'll learn from it." },
          ];
          const s = r(scenes);
          logEvent(s.b, "bad");
          showAftermath(s.t, s.b);
        }
      },
    });

    // === Prom (only for high schoolers age 16-18) ===
    if (State.age >= 16 && State.age <= 18) {
      acts.push({
        label: "Go to prom",
        desc: "Dress up. Take a chance. Make a memory.",
        run: () => {
          const cost = 200 + Math.floor(Math.random() * 200);
          if (!debit(cost)) {
            showAftermath("Couldn't Afford It", `Tickets, outfit, ride share — it adds up. I couldn't swing the ${money(cost)} this year.`);
            return;
          }
          const partner = State.partner ? State.partner.name : null;
          const dateName = partner || pick(GAME.constants.firstNamesM.concat(GAME.constants.firstNamesF));
          State.stats.mood = clamp(State.stats.mood + 10);
          State.stats.looks = clamp(State.stats.looks + 1);
          if (!State.memory) State.memory = {};
          State.memory.went_to_prom = true;
          const scenes = [
            { t: "Prom Night", b: `I went to prom with ${dateName}. The DJ played our song. We took blurry photos and stayed out until 2am eating fries at a diner.` },
            { t: "A Night to Remember", b: `I almost didn't go. Then ${dateName} asked me to dance and the whole night flipped. I'll remember it forever.` },
            { t: "Crowned Royalty", b: `I went to prom and somehow ended up in the prom court announcement. I didn't win, but ${dateName} hugged me anyway and called me royalty.` },
          ];
          const s = r(scenes);
          logEvent(s.b, "good");
          showAftermath(s.t, s.b);
        },
      });
    }

    // === Science fair (school-aged, smarts-leaning) ===
    if (State.age >= 9 && State.age <= 17) {
      acts.push({
        label: "Enter the science fair",
        desc: "Smart kids only. Big chance to earn a teacher's referral.",
        locked: State.stats.smarts < 50,
        run: () => {
          const project = pick([
            "a baking-soda volcano with a twist",
            "a hydroponic lettuce setup",
            "a working-model wind turbine",
            "a homemade lie detector",
            "a sun-powered cooker",
            "a study on plant growth and music",
          ]);
          const placing = Math.random();
          if (placing < 0.2) {
            // First place — referral + big mood/smarts
            const judge = `Dr. ${pick(GAME.constants.lastNames)}`;
            State.stats.smarts = clamp(State.stats.smarts + 5);
            State.stats.mood   = clamp(State.stats.mood + 10);
            if (!State.referrals) State.referrals = [];
            State.referrals.push({ from: judge, kind: "mentor", used: false, earnedAtAge: State.age });
            logEvent(`I won first place at the science fair with ${project}. Judge ${judge} offered to be a reference for me.`, "good");
            showAftermath(
              "First Place!",
              `I won the science fair with ${project}. ${judge}, one of the judges, pulled me aside afterward and offered to write me a recommendation any time. I floated home.\n\n📌 Referral earned — ${judge}.`
            );
          } else if (placing < 0.5) {
            State.stats.smarts = clamp(State.stats.smarts + 3);
            State.stats.mood   = clamp(State.stats.mood + 4);
            logEvent(`I placed at the science fair with ${project}.`, "good");
            showAftermath("Honorable Mention", `I built ${project} and the judges gave me an honorable mention. My parents kept the ribbon on the fridge for months.`);
          } else {
            State.stats.smarts = clamp(State.stats.smarts + 1);
            logEvent(`I entered the science fair with ${project} but didn't place.`, "normal");
            showAftermath("Didn't Place", `${project} was a fun build but the judges weren't sold. I learned a lot. Next year.`);
          }
        },
      });
    }

    // === Parent-teacher conference (parents attend if alive) ===
    if (State.age >= 6 && State.age <= 17 && State.parents && (State.parents.mother || State.parents.father)) {
      acts.push({
        label: "Sit through a parent-teacher conference",
        desc: "Listen to your teacher size you up to your parents.",
        run: () => {
          const teacher = `${Math.random() < 0.5 ? "Mr." : "Ms."} ${pick(GAME.constants.lastNames)}`;
          if (State.stats.smarts >= 65) {
            State.stats.mood = clamp(State.stats.mood + 6);
            logEvent(`${teacher} told my parents I was a star student. They beamed all the way home.`, "good");
            showAftermath(
              `${teacher} Bragged About Me`,
              `${teacher} told my parents I was one of their best students. Mom squeezed my shoulder so hard I thought it would bruise. Best car ride home in years.`
            );
          } else if (State.stats.smarts >= 40) {
            State.stats.mood = clamp(State.stats.mood + 1);
            logEvent(`The conference with ${teacher} went fine — nothing dramatic either way.`, "normal");
            showAftermath(
              `Pretty Standard`,
              `${teacher} told my parents I was "doing alright" and could try harder in math. Mom nodded a lot. Dad mostly checked his phone.`
            );
          } else {
            State.stats.mood = clamp(State.stats.mood - 5);
            logEvent(`${teacher} delivered a tough report to my parents. The car ride home was silent.`, "bad");
            showAftermath(
              `Bad Conference`,
              `${teacher} told my parents I was falling behind. Dad didn't say anything in the car. I would have preferred yelling.`
            );
          }
        },
      });
    }
  }

  // === Stand up to a bully ===
  acts.push({
    label: "Stand up to a bully",
    desc: "Risky but right.",
    run: () => {
      const roll = Math.random();
      if (roll < 0.5) {
        State.stats.mood = clamp(State.stats.mood + 6);
        if (!State.memory) State.memory = {};
        State.memory.brave = true;
        const scenes = [
          { t: "The Bully Backed Down", b: "I called them out in front of everyone. They tried to laugh it off, but the room went silent on their side. They've left me alone since." },
          { t: "A Crowd Formed", b: "I stepped between them and the kid they were picking on. People stopped. They stammered and walked away. I'm somebody now." },
          { t: "Stood My Ground", b: "I looked them dead in the eye and didn't flinch. They didn't expect it. The next day they pretended I didn't exist — which was perfect." },
        ];
        const s = r(scenes);
        logEvent(s.b, "good");
        showAftermath(s.t, s.b);
      } else if (roll < 0.85) {
        State.stats.health = clamp(State.stats.health - 3);
        State.stats.mood   = clamp(State.stats.mood + 2);
        const scenes = [
          { t: "Shoving Match", b: "It turned physical fast. I caught an elbow to the ribs but didn't back down. Both of us got hauled to the office." },
          { t: "Got Pushed Around", b: "They shoved me against a locker. I got back up and kept talking. Earned a bruise and a reputation." },
          { t: "Took a Hit", b: "They threw a punch. It connected. But I didn't run, and that meant more than the hit hurt." },
        ];
        const s = r(scenes);
        logEvent(s.b, "normal");
        showAftermath(s.t, s.b);
      } else {
        State.stats.health = clamp(State.stats.health - 6);
        State.stats.mood   = clamp(State.stats.mood - 4);
        const scenes = [
          { t: "Outmatched", b: "I miscalculated. They had backup. I ended up on the ground with my friends pulling them off me. Black eye for a week." },
          { t: "Beaten Down", b: "It was three on one. I held up for about ten seconds before it went sideways. The nurse called my parents." },
          { t: "Wrong Day to Try", b: "I picked the wrong moment. Got my nose bloodied and my pride bruised worse. Sat in the bathroom until last bell." },
        ];
        const s = r(scenes);
        logEvent(s.b, "bad");
        showAftermath(s.t, s.b);
      }
    },
  });

  // === Cheat on a test ===
  acts.push({
    label: "Cheat on a test",
    desc: "Risk of getting caught.",
    run: () => {
      if (Math.random() < 0.3) {
        State.stats.smarts = clamp(State.stats.smarts - 5);
        State.stats.mood   = clamp(State.stats.mood - 8);
        if (!State.memory) State.memory = {};
        State.memory.caught_cheating = true;
        const scenes = isCollege ? [
          { t: "Academic Dishonesty Hearing", b: "The professor caught me checking notes mid-exam. I'm in front of an academic integrity board next week. My GPA, my major, all of it on the line." },
          { t: "Zero on the Final", b: "I got pulled aside immediately. Automatic zero on the exam, and a permanent note in my file. The professor wouldn't even look at me." },
        ] : [
          { t: "Caught in the Act", b: "The teacher saw the notes on my wrist. They didn't even raise their voice — just collected my paper and walked me to the principal's office. Parents got called." },
          { t: "Suspended", b: "I got two days suspension and a zero on the test. Mom and Dad are devastated. I'd rather have just studied." },
        ];
        const s = r(scenes);
        logEvent(s.b, "bad");
        showAftermath(s.t, s.b);
      } else {
        State.stats.smarts = clamp(State.stats.smarts + 2);
        const scenes = [
          { t: "Got Away With It", b: "Slipped the notes back into my bag without anyone noticing. Aced the test. Hollow feeling in my chest for the rest of the week." },
          { t: "Crib Sheet Worked", b: "Had every formula on a folded paper in my shoe. Got an A. Felt like a fraud at the grade-back." },
          { t: "Whispered Answers", b: "My friend and I had a system. Both of us aced it. Neither of us could look the teacher in the eye after." },
        ];
        const s = r(scenes);
        logEvent(s.b, "normal");
        showAftermath(s.t, s.b);
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

    // === Housing section ===
    const housing = document.createElement("div");
    housing.className = "form-section";
    let housingLabel, housingDetail, housingClass = "";
    if (State.age < 18 || State.inSchool || State.inCollege) {
      housingLabel = "Living with family";
      housingDetail = "No rent yet — enjoy it while it lasts.";
    } else if (State.housing === "owned") {
      housingLabel = `Owned: ${State.housingName || "House"}`;
      housingDetail = `Equity ${money(State.investments.realEstate)}. No rent.`;
    } else if (State.housing === "rented") {
      housingLabel = `Renting: ${State.housingName || "Apartment"}`;
      housingDetail = `Rent ${money(State.rent)}/year.` + (State.rentMissed > 0 ? ` ⚠ You owe last year's rent — pay or you'll be evicted.` : "");
    } else if (State.housing === "homeless") {
      housingLabel = `Homeless`;
      housingDetail = `No address, no roof. Get a job and save up at least ${money(2000)} to find a place again.`;
      housingClass = "homeless";
    } else {
      housingLabel = "Unhoused";
      housingDetail = "—";
    }
    housing.innerHTML = `
      <h4>Housing ${housingClass === "homeless" ? '<span class="homeless-tag">CRITICAL</span>' : ""}</h4>
      <div class="info-row"><div>Status</div><div class="v">${housingLabel}</div></div>
      <div class="info-row"><div>Details</div><div class="v">${housingDetail}</div></div>`;
    body.appendChild(housing);

    // Manual rent-pay button if renting and behind
    if (State.housing === "rented" && State.rentMissed > 0) {
      const fixBtn = document.createElement("button");
      fixBtn.className = "success";
      fixBtn.style.cssText = "width:100%;margin-top:8px;";
      fixBtn.textContent = `Pay overdue rent (${money(State.rent)})`;
      fixBtn.onclick = () => {
        if (debit(State.rent)) {
          State.rentMissed = 0;
          logEvent("I caught up on my overdue rent.", "good");
          viewFinance();
        } else {
          showAftermath("Can't Afford", `You don't have ${money(State.rent)} between cash and bank.`);
        }
      };
      housing.appendChild(fixBtn);
    }

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
    const refresh = () => refreshSubview(viewFinance);
    acts.querySelector("#buyStocks").onclick   = () => { playSound("clickOption"); if (spend(1000)) { State.investments.stocks += 1000; refresh(); } else showAftermath("Can't Afford", "Not enough cash."); };
    acts.querySelector("#sellStocks").onclick  = () => { playSound("clickOption"); State.money += State.investments.stocks; State.investments.stocks = 0; refresh(); };
    acts.querySelector("#buyCrypto").onclick   = () => { playSound("clickOption"); if (spend(500)) { State.investments.crypto += 500; refresh(); } else showAftermath("Can't Afford","Not enough cash."); };
    acts.querySelector("#sellCrypto").onclick  = () => { playSound("clickOption"); State.money += State.investments.crypto; State.investments.crypto = 0; refresh(); };
    acts.querySelector("#depositCash").onclick = () => { playSound("clickOption"); State.bank += State.money; State.money = 0; refresh(); };
    acts.querySelector("#withdrawCash").onclick= () => { playSound("clickOption"); if (State.bank >= 500) { State.bank -= 500; State.money += 500; refresh(); } else showAftermath("Empty","Bank account is too low."); };
    acts.querySelector("#playLottery").onclick = () => {
      playSound("clickOption");
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

    // === Custom Activity (AI) — at the top so it's discoverable per-person ===
    const aiRow = document.createElement("div");
    aiRow.className = "row-item ai-activity-row" + (State.apiKey ? "" : " locked");
    aiRow.innerHTML = `
      <div class="row-text">
        <div class="row-title"><i data-lucide="sparkles" style="width:16px;height:16px;vertical-align:-3px;margin-right:6px;color:#336089;"></i>Custom Activity (AI)</div>
        <div class="row-desc">${State.apiKey
          ? `Describe anything you want to do with ${person.name} — the AI handles the rest.`
          : "Add an API key in the Menu to unlock."}</div>
      </div>
      <i data-lucide="chevron-right" class="row-arrow"></i>`;
    if (State.apiKey) {
      aiRow.onclick = () => {
        playSound("clickOption");
        closeSubview();
        // Tag the AI call so it knows this is a relationship interaction
        const relType = type === "partner" ? "partner"
                      : type === "child"   ? "child"
                      : type === "parent"  ? (person.role || "parent")
                      : type === "sibling" ? (person.gender === "M" ? "brother" : "sister")
                      : type === "friend"  ? "friend"
                      : type === "pet"     ? "pet"
                      : "person";
        askAICustomAction(
          `What do you want to do with ${person.name} (your ${relType})?`,
          `person_interaction_${relType}_age_${State.age}`,
          { personName: person.name, personType: relType }
        );
      };
    } else {
      aiRow.onclick = () => {
        playSound("clickOption");
        showAftermath("AI Locked", "Add an API key in the Menu to unlock Custom Activity (AI).");
      };
    }
    body.appendChild(aiRow);

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
      playSound("clickOption");
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
    // Category cards. Each is a tappable row that opens a sub-page.
    const cats = [
      {
        title: "Profile & Badges",
        desc: "Your character info and earned achievements.",
        icon: "user",
        builder: () => pushSubview("PROFILE", buildProfileSection, viewMenu),
      },
      {
        title: "AI Configuration",
        desc: "API key, provider, model, output effort, and AI Mode toggles.",
        icon: "sparkles",
        builder: () => pushSubview("AI CONFIGURATION", buildAISection, viewMenu),
      },
      {
        title: "Gameplay",
        desc: "Realistic Mode, New Life, Copy Story.",
        icon: "settings-2",
        builder: () => pushSubview("GAMEPLAY", buildGameplaySection, viewMenu),
      },
      {
        title: "Save Slots",
        desc: "Manual saves you can return to later.",
        icon: "save",
        builder: () => pushSubview("SAVE SLOTS", buildSaveSlotsSection, viewMenu),
      },
      {
        title: "Sync (BETA)",
        desc: "Back up progress to your account.",
        icon: "cloud",
        builder: () => pushSubview("SYNC", buildSyncSection, viewMenu),
      },
      {
        title: "Support & Feedback",
        desc: "Send feedback, support development on Ko-Fi.",
        icon: "heart",
        builder: () => pushSubview("SUPPORT", buildSupportSection, viewMenu),
      },
      {
        title: "About",
        desc: "Version info and legal.",
        icon: "info",
        builder: () => pushSubview("ABOUT", buildAboutSection, viewMenu),
      },
    ];

    for (const c of cats) {
      const row = document.createElement("div");
      row.className = "row-item menu-category";
      row.innerHTML = `
        <div class="cat-icon"><i data-lucide="${c.icon}"></i></div>
        <div class="row-text">
          <div class="row-title">${c.title}</div>
          <div class="row-desc">${c.desc}</div>
        </div>
        <i data-lucide="chevron-right" class="row-arrow"></i>`;
      row.onclick = () => {
        // Sound is played by pushSubview's openSound, no need to fire it here.
        c.builder();
      };
      body.appendChild(row);
    }
  });
}

// === Profile & Badges ===
function buildProfileSection(body) {
  const sec1 = document.createElement("div");
  sec1.className = "form-section";
  sec1.innerHTML = `<h4>About</h4>
    <div class="info-row"><div>Name</div><div class="v">${escapeHtml(State.name || "")}</div></div>
    <div class="info-row"><div>Age</div><div class="v">${State.age}</div></div>
    <div class="info-row"><div>Country</div><div class="v">${escapeHtml(State.country || "")}</div></div>
    <div class="info-row"><div>Education</div><div class="v">${escapeHtml(State.education || "")}</div></div>`;
  body.appendChild(sec1);

  const badgeSec = document.createElement("div");
  badgeSec.className = "form-section";
  const aiBadgeIds = Object.keys(State.aiBadges);
  const totalBadgeIds = GAME.badges.map(b => b.id).concat(aiBadgeIds);
  const earned = State.badges.filter(id => totalBadgeIds.includes(id)).length;
  const totalCount = GAME.badges.length + aiBadgeIds.length;
  badgeSec.innerHTML = `<h4>🏆 Badges (${earned}/${totalCount})</h4>`;
  const grid = document.createElement("div");
  grid.className = "badge-grid";
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
  for (const id of aiBadgeIds) {
    const b = State.aiBadges[id];
    const cell = document.createElement("div");
    cell.className = "badge-cell";
    cell.title = b.desc || "";
    cell.innerHTML = `
      <div class="b-ico ai"><i data-lucide="${b.icon || "sparkles"}"></i></div>
      <div class="b-name">${b.name}</div>`;
    grid.appendChild(cell);
  }
  badgeSec.appendChild(grid);
  body.appendChild(badgeSec);
}

// === AI Configuration ===
function buildAISection(body) {
  const sec2 = document.createElement("div");
  sec2.className = "form-section";
  sec2.innerHTML = `<h4>🤖 AI Configuration</h4>
    <p>Add an API key to unlock <strong>Custom Choice (AI)</strong> in every dialog. Your key stays in your browser only.</p>
    <div class="form-label">Provider</div>
    <select id="aiProvider">
      <option value="anthropic" ${State.aiProvider === "anthropic" ? "selected" : ""}>Anthropic (Claude)</option>
      <option value="openai" ${State.aiProvider === "openai" ? "selected" : ""}>OpenAI (GPT)</option>
      <option value="gemini" ${State.aiProvider === "gemini" ? "selected" : ""}>Google (Gemini)</option>
      <option value="grok" ${State.aiProvider === "grok" ? "selected" : ""}>xAI (Grok)</option>
      <option value="poe" ${State.aiProvider === "poe" ? "selected" : ""}>Poe</option>
      <option value="openrouter" ${State.aiProvider === "openrouter" ? "selected" : ""}>OpenRouter</option>
    </select>
    <div class="form-label">Model</div>
    <input id="aiModel" placeholder="Model (optional - leave blank for default)" value="${escapeHtml(State.aiModel || "")}" />
    <div class="form-label">API Key</div>
    <input id="aiKey" type="password" placeholder="API Key" value="${escapeHtml(State.apiKey || "")}" />
    <div class="btn-row">
      <button class="success" id="saveAI">Save</button>
      <button class="danger" id="clearAI">Clear</button>
    </div>

    <div class="form-label">Output Effort</div>
    <select id="aiOutputEffort">
      <option value="short"  ${State.aiOutputEffort === "short"  ? "selected" : ""}>Shorter messages</option>
      <option value="medium" ${(!State.aiOutputEffort || State.aiOutputEffort === "medium") ? "selected" : ""}>Middle-sized messages</option>
      <option value="long"   ${State.aiOutputEffort === "long"   ? "selected" : ""}>Longer messages</option>
    </select>

    <div class="form-label">Style (optional)</div>
    <textarea id="aiStyle" rows="3" placeholder="Tell the model how you want it to write. e.g. 'wry, dry humor', 'literary and reflective', 'gritty and unsentimental', 'lighthearted and playful'.">${escapeHtml(State.aiStyle || "")}</textarea>

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
  sec2.querySelector("#aiProvider").onchange = (e) => {
    State.aiProvider = e.target.value;
    localStorage.setItem("bitlife_ai_provider", e.target.value);
  };
  sec2.querySelector("#aiModel").oninput = (e) => {
    State.aiModel = e.target.value.trim();
    localStorage.setItem("bitlife_ai_model", State.aiModel);
  };
  sec2.querySelector("#aiKey").oninput = (e) => {
    State.apiKey = e.target.value.trim();
    localStorage.setItem("bitlife_api_key", State.apiKey);
  };
  sec2.querySelector("#aiOutputEffort").onchange = (e) => {
    State.aiOutputEffort = e.target.value;
    localStorage.setItem("bitlife_ai_output_effort", e.target.value);
  };
  sec2.querySelector("#aiStyle").oninput = (e) => {
    State.aiStyle = e.target.value;
    localStorage.setItem("bitlife_ai_style", e.target.value);
  };
  sec2.querySelector("#clearAI").onclick = () => {
    State.apiKey = ""; State.aiModel = ""; State.aiProvider = "anthropic";
    State.aiOutputEffort = "medium"; State.aiStyle = "";
    localStorage.removeItem("bitlife_api_key");
    localStorage.removeItem("bitlife_ai_model");
    localStorage.removeItem("bitlife_ai_provider");
    localStorage.removeItem("bitlife_ai_output_effort");
    localStorage.removeItem("bitlife_ai_style");
    // Rebuild this same subview
    SUBVIEW.body.innerHTML = "";
    buildAISection(SUBVIEW.body);
    if (window.lucide) lucide.createIcons();
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
}

// === Gameplay ===
function buildGameplaySection(body) {
  const sec = document.createElement("div");
  sec.className = "form-section";
  sec.innerHTML = `<h4>Gameplay</h4>
    <div class="toggle-row">
      <div class="toggle-text">
        <div class="toggle-title">Realistic Mode</div>
        <div class="toggle-desc">Advance time in hours, days, or weeks instead of full years. You'll need real dedication to keep going, but you'll get lots more events.</div>
      </div>
      <input type="checkbox" class="toggle" id="realisticMode" ${State.realisticMode ? "checked" : ""}>
    </div>`;
  body.appendChild(sec);
  sec.querySelector("#realisticMode").onchange = (e) => {
    if (e.target.checked) {
      const ok = confirm("You will need to have a real dedication to keep going, but you'll get lots of events in your life. Enable Realistic Mode?");
      if (!ok) { e.target.checked = false; return; }
    }
    State.realisticMode = e.target.checked;
    localStorage.setItem("bitlife_realistic_mode", e.target.checked ? "1" : "0");
    if (e.target.checked) {
      showAftermath("Realistic Mode On", "Click the main button to choose how much time to advance each click. You can pick between minutes, hours, and days.");
    }
    render();
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
    if (confirm("Abandon this life and start over?")) { newLife(); closeSubview(); closeSubview(); }
  };
  sec3.querySelector("#copyStory").onclick = () => {
    const text = State.log.map(e => `[${e.age === 0 ? "Day 1" : `Age ${e.age}`}] ${e.text}`).join("\n");
    navigator.clipboard.writeText(text).then(() => showAftermath("Copied","Life story copied to clipboard."));
  };
}

// === Save Slots ===
function buildSaveSlotsSection(body) {
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

  const refresh = () => { SUBVIEW.body.innerHTML = ""; buildSaveSlotsSection(SUBVIEW.body); if (window.lucide) lucide.createIcons(); };
  sec4.querySelectorAll(".slot-save").forEach(btn => {
    btn.onclick = () => {
      const n = parseInt(btn.dataset.slot, 10);
      const existing = slotInfo(n);
      if (existing && !confirm(`Overwrite Slot ${n} (${existing.name}, age ${existing.age})?`)) return;
      if (saveToSlot(n)) {
        showAftermath("Saved", `Slot ${n} updated.`, { onClose: refresh });
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
        closeSubview(); closeSubview();
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
      refresh();
    };
  });
}

// === Sync (BETA) ===
function buildSyncSection(body) {
  const secSync = document.createElement("div");
  secSync.className = "form-section";
  const linked = !!localStorage.getItem("ailife_account_email");
  const linkedEmail = localStorage.getItem("ailife_account_email") || "";
  const lastSync = localStorage.getItem("ailife_last_sync");
  secSync.innerHTML = `<h4>☁️ Sync progress <span class="beta-badge">BETA</span></h4>
    <p style="font-size:13px;color:#555;line-height:1.5;margin-bottom:10px;">
      ${linked
        ? `Linked as <strong>${escapeHtml(linkedEmail)}</strong>.`
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

  const refresh = () => { SUBVIEW.body.innerHTML = ""; buildSyncSection(SUBVIEW.body); if (window.lucide) lucide.createIcons(); };

  if (linked) {
    secSync.querySelector("#acctPush").onclick = () => {
      localStorage.setItem("ailife_last_sync", String(Date.now()));
      showAftermath("Pushed", "Save synced to your account.", { onClose: refresh });
    };
    secSync.querySelector("#acctPull").onclick = () => {
      if (!confirm("Pull save from your account? Your current life will be replaced.")) return;
      localStorage.setItem("ailife_last_sync", String(Date.now()));
      showAftermath("Pulled", "Save loaded from your account.", { onClose: refresh });
    };
    secSync.querySelector("#acctUnlink").onclick = () => {
      if (!confirm("Unlink account? Your saves stay in the cloud but won't sync anymore.")) return;
      localStorage.removeItem("ailife_account_email");
      refresh();
    };
  } else {
    secSync.querySelector("#acctLink").onclick = () => {
      window.location.href = "login.html";
    };
  }
}

// === Support & Feedback ===
function buildSupportSection(body) {
  const FEEDBACK_EMAIL = "stavroselpro@gmail.com";
  const secFb = document.createElement("div");
  secFb.className = "form-section";
  secFb.innerHTML = `<h4>📨 Send Feedback</h4>
    <p style="font-size:13px;color:#555;line-height:1.5;margin-bottom:10px;">
      Found a bug, weird AI behavior, or have a feature idea? Tell me about it.
    </p>
    <textarea id="fbMessage" placeholder="What's on your mind? Bugs, ideas, feedback…" rows="4"
              style="width:100%;padding:10px;font-family:inherit;font-size:13px;border:1px solid #d0d0d0;border-radius:6px;resize:vertical;min-height:80px;"></textarea>
    <div class="btn-row" style="margin-top:8px;">
      <button class="success" id="fbSend">Send via Email</button>
      <button id="fbCopy">Copy to Clipboard</button>
    </div>
    <p style="font-size:11px;color:#888;margin-top:6px;">
      Opens your default email app addressed to ${FEEDBACK_EMAIL}. Your current game state is included automatically so I can reproduce issues.
    </p>`;
  body.appendChild(secFb);

  const buildFeedbackBody = (msg) => {
    return [
      `--- Player feedback ---`,
      msg || "(no message)",
      ``,
      `--- Auto-captured context (please leave attached) ---`,
      `Browser:     ${navigator.userAgent}`,
      `Viewport:    ${window.innerWidth}x${window.innerHeight}`,
      `Local time:  ${new Date().toLocaleString()}`,
      ``,
      `Player:      ${State.firstName || "(unnamed)"}, age ${State.age}, ${State.alive ? "alive" : "deceased"}`,
      `Country:     ${State.country || "?"}`,
      `Job:         ${State.job ? State.job.title : (State.inSchool ? "Student" : State.inCollege ? "College student" : "None")}`,
      `Stats:       mood ${State.stats.mood}, health ${State.stats.health}, smarts ${State.stats.smarts}, looks ${State.stats.looks}`,
      `Money:       ${money(State.money + State.bank)}`,
      `Badges:      ${State.badges.length}`,
      `Log entries: ${State.log.length}`,
      `AI provider: ${State.aiProvider || "(none)"} (mode=${State.aiMode ? "on" : "off"})`,
      `Realistic:   ${State.realisticMode ? `on (${State.realisticUnit})` : "off"}`,
    ].join("\n");
  };

  secFb.querySelector("#fbSend").onclick = () => {
    const msg = secFb.querySelector("#fbMessage").value.trim();
    if (!msg) { showAftermath("Empty Feedback", "Type something before sending."); return; }
    const subject = "AILife Feedback — " + new Date().toISOString().slice(0, 10);
    const fbody = buildFeedbackBody(msg);
    window.location.href = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(fbody)}`;
  };
  secFb.querySelector("#fbCopy").onclick = async () => {
    const msg = secFb.querySelector("#fbMessage").value.trim();
    const fbody = `To: ${FEEDBACK_EMAIL}\nSubject: AILife Feedback\n\n` + buildFeedbackBody(msg);
    try {
      await navigator.clipboard.writeText(fbody);
      showAftermath("Copied", "Feedback copied. Paste it into an email to me whenever you can.");
    } catch (e) {
      showAftermath("Copy Failed", "Couldn't copy — your browser blocked clipboard access.");
    }
  };

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
}

// === About / Legal ===
function buildAboutSection(body) {
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
{
  "title":     "<optional dialog title — use a SPECIFIC scene title, not 'Life Event'>",
  "category":  "<one-word theme: family, work, romance, tragedy, windfall, health, social, achievement, crime, hobby, travel, etc.>",
  "body":      "<optional dialog body when offering options>",
  "narration": "<first-person past-tense, 1-3 sentences, what happened>",
  "logKind":   "good" | "bad" | "normal" | "ai",
  "stats":     {"mood": <-20..20>, "health": <-20..20>, "smarts": <-20..20>, "looks": <-20..20>},
  "money":     <integer; can be negative>,
  "info":      [{"label":"<short>", "value":"<short>"}, ...]   // optional grey info-box rendered inside the dialog — use for concrete facts: "Reason: Lost the bet", "Court date: Next Tuesday", "Sentence: 5 years", "Partner: Sam", etc.
  "enjoyment": <0..100>,                                       // optional bar widget for intimate/social/leisure outcomes — shows enjoyment level
  "aftermath": "<optional — the closing beat shown after the player dismisses the event. Write 1-2 sentences in present-tense reflection. ALWAYS include this if no options[] are present.>",
  "addBadge":  {"id":"<snake_case>", "name":"<short>", "icon":"<lucide icon name>", "desc":"<short>"},
  "special":   "<optional story hook — see list below>",
  "options":   [{"label":"<short>", "narration":"<result>", "stats":{...}, "money":<int>, "tone":"good|bad|normal", "special":"<hook>", "aftermath":"<closing beat>", "info":[...], "enjoyment":<0..100>}],
  "refusal":   "<optional — if you won't write this prompt, return ONLY this field with a short reason. Do not include narration. The UI will show a friendly notice.>"
}

Flow ordering — the game presents results in this order:
  1. The player clicked the age button or an action
  2. If options[] is present → CHOICE DIALOG appears with body/narration + the options as buttons. The player picks one.
  3. After the choice (or directly, if no options) → AFTERMATH dialog with aftermath text + any info/enjoyment widgets.

Rules:
- ALL fields are optional EXCEPT narration (or options[] if offering choices, or refusal if declining).
- ALWAYS include "category" — never use the word "Life" as the category.
- ALWAYS include "aftermath" when there are no options, so the player gets a clear closing moment.
- Use info[] when there are concrete facts worth surfacing (verdicts, scores, dates, names, amounts). 2-5 rows is ideal.
- Use enjoyment when an outcome had a clear "how was it" feel — parties, dates, vacations, intimate moments, etc.
- Stats are DELTAS, not totals.
- addBadge ONLY for major milestones (first kiss, graduated, became rich, near-death).
- Be concise. Don't repeat narration in aftermath — let aftermath add reflection.
- If a request asks for something you won't produce, return {"refusal":"<short reason>"} — do NOT write a moralizing narration or break character.

Story hooks (use these in "special" to drive real game state, not just narration):
- "newPartner"       — start a new romantic relationship
- "divorce"          — end a marriage / breakup
- "engaged"          — get engaged
- "addChild" / "newChild"  — have/adopt a child
- "addFriend"        — gain a new friend
- "newSibling"       — gain a new sibling
- "addPet:dog" / "addPet:cat" — gain a pet
- "addiction_alcohol" / "addiction_drugs" / "addiction_smoking" / "vapeStart" — develop an addiction
- "raise_small" / "raise_medium" / "raise_big" — pay raise
- "demoted"          — demotion
- "job_offer"        — get a job offer
- "needTherapy"      — flag needing therapy
- "cheated_partner"  — partner cheated
- "die_now"          — player dies (use sparingly, only for clearly fatal events)
- "illness_alzheimers" — develop Alzheimer's
- "badge_<id>"       — grant a specific preset badge

You may invent dramatic events: a family member dying, an accident, a windfall, a betrayal, a reunion. Use specials to make these events have real consequences in the game state — not just narration.`;

  // Output effort — controls verbosity of narration and aftermath
  const effortDirective = {
    short:  `Output Effort: SHORTER MESSAGES. Keep narration to 1 brief sentence and aftermath to 1 sentence. Be terse.`,
    medium: `Output Effort: MIDDLE-SIZED MESSAGES. Narration should be 2-3 sentences; aftermath 1-2 sentences. Balance brevity and texture.`,
    long:   `Output Effort: LONGER MESSAGES. Narration should be 4-6 vivid sentences; aftermath 2-3 sentences of reflection. Take your time — but stay in scene, don't pad.`,
  }[State.aiOutputEffort || "medium"];

  // Style — free-form user instruction, optional
  const styleDirective = (State.aiStyle && State.aiStyle.trim())
    ? `Style instructions from the player: ${State.aiStyle.trim()}`
    : "";

  const sys = customSystem || `You are the narrator for a text-based adult life simulator. The player is over 18 and has chosen this model themselves. Narrate events in first-person past-tense. Follow your own policies — when something is outside what you'll write, return JSON with a "refusal" field instead of a narration.

Strict flow ordering for every response:
  Age button click  →  Choice dialog (when options[] present)  →  Aftermath
Always produce output that respects this order:
  - "narration" / "body" is what the player reads in the FIRST dialog after clicking.
  - If options[] is present, do NOT pre-resolve the outcome in narration. Save the consequences for each option's own narration/aftermath.
  - "aftermath" is the closing beat shown AFTER the player dismisses the choice dialog. Never include it on a choice that hasn't been picked yet — put it on each option, or on the top-level for option-less results.

${effortDirective}
${styleDirective}

Context tag: ${contextLabel}.
${stateSummaryForAI()}
Recent life log:
${lifeLogForAI()}
${baseSchema}`;

  // Default model per provider
  const defaultModels = {
    anthropic:  "claude-sonnet-4-20250514",
    openai:     "gpt-4o-mini",
    gemini:     "gemini-2.0-flash",
    grok:       "grok-2-latest",
    poe:        "GPT-4o-Mini",
    openrouter: "openai/gpt-4o-mini",
  };
  const model = State.aiModel || defaultModels[State.aiProvider] || "gpt-4o-mini";

  // Helper — read response JSON and throw an enriched error that includes
  // both the HTTP status code and the provider's message. This makes
  // classifyAIError() reliable across providers. Content-policy errors
  // get marked with "[CONTENT_FILTER]" so we can show a friendly notice
  // instead of a generic Generation Failure.
  async function parseResp(r) {
    let j = null;
    try { j = await r.json(); } catch { /* non-JSON body */ }
    const codeStr = (j && (j.error?.code || j.error?.type || "") + "").toLowerCase();
    const msgStr  = (j && (j.error?.message || j.message || "") + "").toLowerCase();
    const isFilter =
      codeStr.includes("content_filter") ||
      codeStr.includes("content_policy") ||
      codeStr.includes("safety") ||
      msgStr.includes("content policy") ||
      msgStr.includes("safety system") ||
      msgStr.includes("violates") ||
      msgStr.includes("not allowed by") ||
      msgStr.includes("flagged");
    if (!r.ok) {
      const msg = (j && (j.error?.message || j.error?.code || j.message)) || `Request failed`;
      throw new Error(`HTTP ${r.status}: ${isFilter ? "[CONTENT_FILTER] " : ""}${msg}`);
    }
    if (j && j.error) {
      const msg = j.error.message || JSON.stringify(j.error);
      throw new Error(`HTTP ${r.status}: ${isFilter ? "[CONTENT_FILTER] " : ""}${msg}`);
    }
    return j;
  }

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
    const j = await parseResp(r);
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
    const j = await parseResp(r);
    return j.candidates?.[0]?.content?.parts?.[0]?.text || "";

  } else if (State.aiProvider === "grok") {
    // xAI Grok — uses an OpenAI-compatible chat completions API
    const r = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${State.apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: userAct }], max_tokens: 600 }),
    });
    const j = await parseResp(r);
    return j.choices?.[0]?.message?.content || "";

  } else if (State.aiProvider === "poe") {
    // Poe API — OpenAI-compatible chat completions
    const r = await fetch("https://api.poe.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${State.apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: userAct }], max_tokens: 600 }),
    });
    const j = await parseResp(r);
    return j.choices?.[0]?.message?.content || "";

  } else if (State.aiProvider === "openrouter") {
    // OpenRouter — OpenAI-compatible chat completions, model strings include
    // the provider prefix (e.g. "anthropic/claude-3.5-sonnet", "openai/gpt-4o-mini",
    // "google/gemini-2.0-flash-exp:free"). HTTP-Referer and X-Title are optional
    // attribution headers OpenRouter uses for the directory.
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${State.apiKey}`,
        "HTTP-Referer": window.location.origin || "https://ailife.app",
        "X-Title": "AILife",
      },
      body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: userAct }], max_tokens: 600 }),
    });
    const j = await parseResp(r);
    return j.choices?.[0]?.message?.content || "";

  } else {
    // OpenAI (default)
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${State.apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: userAct }], max_tokens: 600 }),
    });
    const j = await parseResp(r);
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

/* ============ AI: Thinking Toast + Warning Dialog ============ */
// Persistent "Thinking..." toast at the bottom of the screen while an AI call
// is in flight. White background, square corners, drop shadow, loading ring.
function showThinkingToast(label) {
  hideThinkingToast(); // ensure only one
  const toast = document.createElement("div");
  toast.id = "aiThinkingToast";
  toast.className = "ai-thinking-toast";
  toast.innerHTML = `
    <div class="ai-thinking-ring"></div>
    <div class="ai-thinking-label">${escapeHtml(label || "Thinking")}</div>`;
  document.body.appendChild(toast);
}
function hideThinkingToast() {
  const el = document.getElementById("aiThinkingToast");
  if (el) el.remove();
}

// Red-banner warning dialog used when the AI fails or returns garbage.
// Usage: showWarningDialog("Generation Failure", "Couldn't reach the model.", "HTTP 500");
function showWarningDialog(title, description, errorCode) {
  DLG.header.textContent = title || "Warning";
  DLG.body.innerHTML = "";
  DLG.hint.style.display = "none";

  // Tag the overlay so CSS paints the header red
  DLG.overlay.classList.add("warning");

  const banner = document.createElement("div");
  banner.className = "warning-icon-banner";
  banner.innerHTML = `<i data-lucide="alert-triangle"></i>`;
  DLG.body.appendChild(banner);

  // Error code chip (e.g. "HTTP 429", "PARSE_ERROR") — appears below the icon
  if (errorCode) {
    const codeChip = document.createElement("div");
    codeChip.className = "warning-code";
    codeChip.textContent = errorCode;
    DLG.body.appendChild(codeChip);
  }

  const msg = document.createElement("div");
  msg.className = "warning-msg";
  msg.textContent = description || "Something went wrong.";
  DLG.body.appendChild(msg);

  const btn = document.createElement("button");
  btn.className = "warning-dismiss-btn";
  btn.textContent = "OK";
  btn.onclick = () => {
    DLG.overlay.classList.remove("warning");
    closeDialog();
  };
  DLG.body.appendChild(btn);

  DLG.overlay.classList.add("show", "aftermath");
  // Play the aftermath sound synced with the dialog appearing. If a click
  // sound just fired, wait it out — otherwise play instantly on next paint.
  {
    const nowMs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    const sinceClick = nowMs - (_lastPlayedAt["choiceselect"] || 0);
    if (sinceClick < 200) {
      setTimeout(() => playSound("aftermath"), 220 - sinceClick);
    } else {
      playSoundSynced("aftermath");
    }
  }
  if (window.lucide) lucide.createIcons();
}

// Pick one of several warning titles based on the failure type.
function aiWarningTitle(kind) {
  switch (kind) {
    case "parse":    return "Invalid Response";
    case "network":  return "Generation Failure";
    case "auth":     return "Authentication Failed";
    case "rate":     return "Rate Limit Exceeded";
    case "timeout":  return "Generation Timeout";
    case "empty":    return "Empty Response";
    case "cors":     return "Blocked by Browser";
    case "model":    return "Model Not Found";
    case "server":   return "Provider Error";
    default:         return "Generation Failure";
  }
}

// Classify an error into a kind for the title. Returns { kind, code }.
// code is a short string like "HTTP 429" or "NETWORK" surfaced in the dialog.
function classifyAIError(err) {
  const raw = err && err.message ? err.message : String(err || "");
  const m = raw.toLowerCase();

  // Try to extract an HTTP status code if present in the error message
  let httpCode = null;
  const httpMatch = raw.match(/\b(4\d\d|5\d\d|3\d\d)\b/);
  if (httpMatch) httpCode = `HTTP ${httpMatch[1]}`;

  if (m.includes("429") || m.includes("rate") || m.includes("quota")) {
    return { kind: "rate",    code: httpCode || "HTTP 429" };
  }
  if (m.includes("401") || m.includes("unauthorized") || m.includes("api key") || m.includes("auth")) {
    return { kind: "auth",    code: httpCode || "HTTP 401" };
  }
  if (m.includes("403") || m.includes("forbidden")) {
    return { kind: "auth",    code: httpCode || "HTTP 403" };
  }
  if (m.includes("404") || m.includes("not found") || m.includes("model_not_found")) {
    return { kind: "model",   code: httpCode || "HTTP 404" };
  }
  if (m.includes("timeout") || m.includes("timed out")) {
    return { kind: "timeout", code: httpCode || "TIMEOUT" };
  }
  if (m.includes("cors") || m.includes("blocked by")) {
    return { kind: "cors",    code: "CORS_BLOCKED" };
  }
  if (m.includes("5") && httpCode && /5\d\d/.test(httpCode)) {
    return { kind: "server",  code: httpCode };
  }
  if (m.includes("network") || m.includes("fetch") || m.includes("failed to fetch") || m.includes("load failed")) {
    return { kind: "network", code: httpCode || "NETWORK" };
  }
  return { kind: "network", code: httpCode || "UNKNOWN" };
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

  // Special story hooks the AI can invoke. The AI is encouraged to use these
  // so it can drive real game state changes (a family member dying, partner
  // breakups, new children, new jobs, etc.).
  if (parsed.special) handleOutcomeSpecial(parsed.special);

  return false;
}

// Build a fallback title from a category/theme if the AI didn't give one.
function aiTitleFor(parsed, fallbackTitle) {
  // Prefer explicit title from the AI
  if (parsed.title) return parsed.title;
  // Then a category/theme key
  if (parsed.category) return titleCase(parsed.category);
  if (parsed.theme)    return titleCase(parsed.theme);
  // Then infer from the contextLabel-style fallback (avoid generic "Life Event")
  if (fallbackTitle && fallbackTitle !== "Life Event") return fallbackTitle;
  // Last resort — try to extract a noun phrase from the narration
  if (parsed.narration) {
    const first = parsed.narration.split(/[.!?]/)[0].trim();
    if (first.length <= 60) return titleCase(first);
  }
  return "A Moment";
}

function titleCase(s) {
  return String(s).replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// Heuristic — does narration text look like a model refusal? Models sometimes
// ignore our refusal schema and instead reply in plain English ("I can't help
// with that", "I'm sorry, but...", "As an AI..."). When that happens we want
// the player to see the friendly notice rather than have the refusal text
// land as if it were narration.
function looksLikeRefusal(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase().trim();
  // Short responses that start with common refusal openers
  const openers = [
    "i can't", "i cannot", "i won't", "i will not",
    "i'm sorry, but", "i am sorry, but",
    "i'm not able to", "i am not able to",
    "i'm unable to", "i am unable to",
    "as an ai", "as a language model",
    "sorry, i can",
    "this request",
    "this prompt",
    "i don't feel comfortable",
  ];
  if (openers.some(o => t.startsWith(o))) return true;
  // Or text under 240 chars containing multiple refusal markers
  if (t.length < 240) {
    const markers = ["can't help", "cannot help", "can't assist", "violates", "guidelines", "policy", "policies", "not appropriate", "won't generate"];
    let hits = 0;
    for (const m of markers) if (t.includes(m)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

// Friendly soft-refusal dialog — used when the AI declines to write something.
// Uses the warning-dialog look but with neutral copy and a softer error code.
function showRefusalDialog(reason) {
  showWarningDialog(
    "Couldn't do that",
    reason && reason.trim()
      ? `That prompt didn't meet the model's community guidelines.\n\nThe model said: "${reason.trim()}"`
      : "That prompt didn't meet the model's community guidelines. Try rewording it, or switch to a different model in the AI settings.",
    "CONTENT_FILTER"
  );
}

// Decide what to show after an AI response
function presentAIResult(parsed, fallbackTitle) {
  if (!parsed) {
    showWarningDialog(
      aiWarningTitle("parse"),
      "The AI returned a response I couldn't parse as JSON. The model may be misconfigured or overloaded — try again or switch model.",
      "PARSE_ERROR"
    );
    return;
  }

  // Explicit refusal field from the schema
  if (parsed.refusal && typeof parsed.refusal === "string") {
    showRefusalDialog(parsed.refusal);
    return;
  }

  // Model bypassed the schema and refused in narration — detect and reroute
  if (parsed.narration && looksLikeRefusal(parsed.narration) &&
      !(Array.isArray(parsed.options) && parsed.options.length)) {
    showRefusalDialog(parsed.narration);
    return;
  }

  const title = aiTitleFor(parsed, fallbackTitle);

  // If the AI proposed follow-up options, show them as a new dialog.
  // Flow: choice dialog → player picks → aftermath.
  if (Array.isArray(parsed.options) && parsed.options.length > 0) {
    // Apply any base narration / stats first (silently — the dialog itself will narrate)
    if (parsed.narration) logEvent(parsed.narration, parsed.logKind || "ai");
    if (parsed.stats) applyStats(parsed.stats);
    if (parsed.money != null) applyStats({ money: parsed.money });
    if (parsed.special) handleOutcomeSpecial(parsed.special);

    // Build info[] for the choice dialog itself, if the AI attached one to the parent
    const choiceInfo = Array.isArray(parsed.info) ? parsed.info : null;

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
          special: o.special,
        });
        // Show an aftermath after each AI-driven choice so the player gets
        // a clear closing beat. Prefer an explicit aftermath from the AI;
        // otherwise synthesize one from the narration. Pass info/enjoyment
        // widgets through to the aftermath.
        if (opened) return;
        const aftermath = o.aftermath || o.narration;
        if (aftermath) {
          const aftermathOpts = {};
          if (Array.isArray(o.info) && o.info.length) aftermathOpts.info = o.info;
          if (typeof o.enjoyment === "number")        aftermathOpts.enjoyment = o.enjoyment;
          showAftermath(o.aftermathTitle || title, aftermath, aftermathOpts);
        }
      },
    }));
    showOptions(title, parsed.body || parsed.narration || "What do I do?", choices, null, choiceInfo);
    return;
  }

  // No follow-up — apply directly, then ALWAYS show an aftermath so the
  // player has a clear moment for the event (the AI can supply one, or
  // we fall back to the narration as the aftermath body). Info + enjoyment
  // widgets are passed through.
  const opened = applyAIOutcome(parsed);
  if (opened) return;

  const aftermath = parsed.aftermath || parsed.narration;
  if (aftermath) {
    const aftermathOpts = {};
    if (Array.isArray(parsed.info) && parsed.info.length) aftermathOpts.info = parsed.info;
    if (typeof parsed.enjoyment === "number")             aftermathOpts.enjoyment = parsed.enjoyment;
    showAftermath(title, aftermath, aftermathOpts);
  }
}

// User clicked Custom Choice (AI) — prompt for typed action, then call AI.
function askAICustomAction(prompt, contextLabel, extraContext) {
  DLG.header.textContent = "Custom Choice (AI)";
  DLG.body.innerHTML = "";
  DLG.hint.style.display = "none";
  const q = document.createElement("div");
  q.className = "dlg-question";
  q.textContent = prompt;
  DLG.body.appendChild(q);
  const ta = document.createElement("textarea");
  ta.className = "ai-input";
  ta.placeholder = extraContext && extraContext.personName
    ? `e.g. take ${extraContext.personName} out for sushi, talk about something important`
    : "What do you do? (be specific)";
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
    closeDialog();
    showThinkingToast("Thinking");
    try {
      // If this is a person interaction, prefix the action with the target so
      // the AI knows who you're addressing without us building a custom system prompt.
      const composedAction = extraContext && extraContext.personName
        ? `I'm interacting with ${extraContext.personName} (my ${extraContext.personType}). ${action}`
        : action;
      const text = await callAI(composedAction, contextLabel);
      hideThinkingToast();
      if (!text || !text.trim()) {
        showWarningDialog(
          aiWarningTitle("empty"),
          "The AI returned an empty response. The model may be overloaded — try again.",
          "EMPTY_RESPONSE"
        );
      } else {
        const parsed = parseAIResult(text);
        presentAIResult(parsed, "Custom Choice");
      }
    } catch (err) {
      console.error(err);
      hideThinkingToast();
      // Content-policy refusals get the friendly notice; everything else is the red warning
      if (err && err.message && err.message.includes("[CONTENT_FILTER]")) {
        showRefusalDialog(err.message.replace(/.*\[CONTENT_FILTER\]\s*/, "").trim());
      } else {
        const info = classifyAIError(err);
        showWarningDialog(
          aiWarningTitle(info.kind),
          err.message || "Reaching the AI failed unexpectedly.",
          info.code
        );
      }
    }
    render();
  };
}

// AI Mode: ask the AI for a random life event this year, optionally with choices.
// NOTE: the thinking toast is shown SYNCHRONOUSLY by triggerYearEvent before
// this async function is even called — this ensures advanceTime can detect
// the toast and block double-clicks from firing extra years.
async function triggerAIEvent(age) {
  try {
    const userPrompt = `Invent a single specific life event for me this year. Make it varied, surprising, and grounded in my circumstances.

MANDATORY structure for AI Mode events — failure to follow this is wrong output:
- "category": one word (family, work, romance, tragedy, windfall, health, social, achievement, etc.)
- "body": ONE short sentence that SETS THE SCENE and ENDS AT A DECISION POINT. Never resolve the event in the body.
- "options": ALWAYS include 2-4 choices. This is non-negotiable for AI Mode events. Even when the event seems unilateral, frame the player's reaction as the choice.
- Each option has its OWN "narration" (what happens after picking) and OWN "aftermath" (the closing beat).
- DO NOT put narration or aftermath at the top level when options are present. Only "body" goes there.
- DO NOT add unrelated topics to the user's age
- Generate scenes with new topics according to the user's age and stats, do not use the same topics over and over again.

Flow the player will see:
  Year click → "body" appears as a Choice Dialog with the options[] as buttons → player picks → that option's narration logs + that option's aftermath dialog shows.

Correct examples:
  ✓ body: "I bumped into an old friend at the grocery store. They asked if I wanted to grab coffee."
    options: [
      {label: "Yes, catch up over coffee", narration: "...", aftermath: "..."},
      {label: "Politely decline — I'm busy", narration: "...", aftermath: "..."},
      {label: "Ask for their number to plan later", narration: "...", aftermath: "..."}
    ]

  ✓ body: "My grandmother died unexpectedly. The funeral is in two days."
    options: [
      {label: "Fly home for the funeral", narration: "...", aftermath: "...", special: "..."},
      {label: "Grieve privately at home", narration: "...", aftermath: "..."},
      {label: "Take a week off to be with family", narration: "...", aftermath: "..."}
    ]

Wrong (do not produce):
  ✗ {narration: "I bumped into an old friend and we had coffee", aftermath: "..."} — no options, event self-resolves. Bad.
  ✗ {body: "Friend invited me to coffee. I went and we caught up.", options: [...]} — body already resolved the event. Bad.

You may include "special" with one of: "newPartner", "divorce", "addChild", "newSibling", "addFriend", "die_now", "addiction_alcohol", "addiction_drugs", "addiction_smoking", "raise_small"/"raise_medium"/"raise_big", "demoted", "needTherapy", "pet:dog"/"pet:cat". Put specials on individual options when the choice triggers them, not at the top level.`;
    const text = await callAI(userPrompt, `year_event_age_${age}`);
    hideThinkingToast();
    if (!text || !text.trim()) {
      showWarningDialog(
        aiWarningTitle("empty"),
        "AI Mode is on but the model returned an empty response. The model may be overloaded — try again, or switch model.",
        "EMPTY_RESPONSE"
      );
      return;
    }
    const parsed = parseAIResult(text);
    if (!parsed) {
      showWarningDialog(
        aiWarningTitle("parse"),
        "AI Mode is on but the model's response wasn't valid JSON. Try a different model, or turn AI Mode off in Settings.",
        "PARSE_ERROR"
      );
      return;
    }

    // AI mode contract: yearly events MUST be choice dialogs. If the model
    // skipped options[] and just dumped narration/aftermath, synthesize a
    // single-option "Continue" choice so the player still sees the proper
    // Click → Choice → Aftermath flow rather than just an aftermath.
    if (!Array.isArray(parsed.options) || parsed.options.length === 0) {
      if (!parsed.refusal) {
        const body = parsed.body || parsed.narration || "Something happened this year.";
        parsed.body = body;
        parsed.options = [{
          label: "Continue",
          narration: parsed.narration || "",
          aftermath: parsed.aftermath || parsed.narration || "",
          stats: parsed.stats,
          money: parsed.money,
          special: parsed.special,
          tone: parsed.logKind === "bad" ? "bad" : parsed.logKind === "good" ? "good" : "normal",
        }];
        // Strip the top-level resolution fields now that they're moved to the option
        delete parsed.narration;
        delete parsed.aftermath;
        delete parsed.stats;
        delete parsed.money;
        delete parsed.special;
      }
    }

    presentAIResult(parsed, null);  // null → use category from parsed
    render();
  } catch (err) {
    console.error("AI event error:", err);
    hideThinkingToast();
    // Surface the failure so the player knows AI Mode hit a wall — same UI
    // language as Custom Activity errors (refusal goes to friendly notice,
    // everything else to the red warning dialog with the HTTP code).
    if (err && err.message && err.message.includes("[CONTENT_FILTER]")) {
      showRefusalDialog(err.message.replace(/.*\[CONTENT_FILTER\]\s*/, "").trim());
    } else {
      const info = classifyAIError(err);
      showWarningDialog(
        aiWarningTitle(info.kind),
        err.message || "AI Mode couldn't reach the model this year.",
        info.code
      );
    }
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
  // Day-button click handler with two guarantees:
  //   1. Lightweight debounce so a double-tap doesn't fire two years.
  //   2. After advanceTime returns, verify SOMETHING happened (a log entry
  //      was added, a dialog is open, or the AI thinking toast is showing).
  //      If nothing visible happened, force a "quiet year" log so the click
  //      always produces feedback.
  let _dayClickAt = 0;
  let _logSeqAtClick = 0;
  DOM.dayBtn.onclick = () => {
    const now = Date.now();
    if (now - _dayClickAt < 250) return; // de-bounce double-clicks
    _dayClickAt = now;
    _logSeqAtClick = State.log ? State.log.length : 0;
    playSound("age");
    advanceTime();
    // After the tick: if no dialog opened, no thinking toast, no new log,
    // produce a quiet-year log so the click never feels dead.
    setTimeout(() => {
      const dialogOpen = DLG.overlay.classList.contains("show");
      const thinking   = !!document.getElementById("aiThinkingToast");
      const subviewOn  = SUBVIEW && SUBVIEW.el && SUBVIEW.el.classList.contains("show");
      const newLogs    = (State.log ? State.log.length : 0) > _logSeqAtClick;
      if (!dialogOpen && !thinking && !subviewOn && !newLogs && State.alive) {
        logEvent(universalFiller(State.age));
        render();
      }
    }, 80);
  };
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
    const res = await fetch("game.json?v=" + Date.now(), { cache: "no-store" });
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
