const mineflayer   = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
const { Vec3 }     = require('vec3');
const mcDataLoader = require('minecraft-data');

// ══════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════
const config = {
  host:     process.env.SERVER_HOST || 'tiktokbuddies.aternos.me',
  port:     parseInt(process.env.SERVER_PORT) || 64617,
  username: process.env.BOT_USERNAME || 'AFKBot',
  version:  '1.21.1'
};
const REG_PASSWORD = process.env.REG_PASSWORD || 'BotPass1234';

// ══════════════════════════════════════════
// TUNING
// ══════════════════════════════════════════
const HP_FLEE       = 10;   // 5 hearts  → run
const HP_SHELTER    =  6;   // 3 hearts  → go home / build shelter
const HP_SAFE       = 16;   // 8 hearts  → resume
const MOB_DETECT    = 12;   // detect hostiles within N blocks
const PLAYER_DETECT = 20;   // detect enemy players within N blocks
const ATK_DIST      = 3.5;  // melee reach
const FOOD_GOAL     = 20;   // keep this many food items

// Reconnect back-off: starts at 20 s, doubles on throttle, caps at 90 s
let reconnectDelay  = 20000;

// ══════════════════════════════════════════
// ITEM LISTS
// ══════════════════════════════════════════
const HOSTILE = new Set([
  'zombie','skeleton','creeper','spider','cave_spider','enderman','witch',
  'pillager','vindicator','ravager','phantom','drowned','husk','stray',
  'blaze','ghast','magma_cube','slime','silverfish','endermite','guardian',
  'elder_guardian','shulker','zombie_villager','warden','zombified_piglin',
  'hoglin','zoglin','bogged','breeze'
]);
const ANIMALS = new Set(['cow','pig','sheep','chicken','rabbit','mooshroom']);

const FOOD_SET = new Set([
  'cooked_beef','cooked_porkchop','cooked_chicken','cooked_mutton','cooked_rabbit',
  'cooked_salmon','cooked_cod','beef','porkchop','chicken','mutton','rabbit',
  'salmon','cod','bread','apple','golden_apple','carrot','baked_potato',
  'melon_slice','sweet_berries','dried_kelp','golden_carrot','pumpkin_pie',
  'mushroom_stew','rabbit_stew','chorus_fruit','enchanted_golden_apple'
]);
const RAW_LIST    = ['beef','porkchop','chicken','mutton','rabbit','cod','salmon'];
const COOKED_LIST = ['cooked_beef','cooked_porkchop','cooked_chicken',
                     'cooked_mutton','cooked_rabbit','cooked_cod','cooked_salmon'];

const LOGS   = ['oak_log','spruce_log','birch_log','jungle_log','acacia_log',
                'dark_oak_log','mangrove_log','cherry_log'];
const PLANKS = ['oak_planks','spruce_planks','birch_planks','jungle_planks',
                'acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks'];
const STONE  = ['stone','cobblestone','cobbled_deepslate',
                'granite','diorite','andesite','deepslate'];
const COBBLE = ['cobblestone','cobbled_deepslate'];
const ORES   = ['iron_ore','deepslate_iron_ore','copper_ore','deepslate_copper_ore',
                'gold_ore','deepslate_gold_ore'];

const SWORD_P = ['netherite_sword','diamond_sword','iron_sword',
                 'stone_sword','wooden_sword','golden_sword'];
const PICK_P  = ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe',
                 'stone_pickaxe','wooden_pickaxe','golden_pickaxe'];
const AXE_P   = ['netherite_axe','diamond_axe','iron_axe',
                 'stone_axe','wooden_axe','golden_axe'];

const BUILD_BLOCKS = ['cobblestone','cobbled_deepslate','dirt','sand','gravel',
                      'oak_planks','spruce_planks','stone'];
const DOORS = ['oak_door','spruce_door','birch_door','jungle_door',
               'acacia_door','dark_oak_door','mangrove_door','cherry_door'];

// Useful items worth picking up off the ground
const PICKUP_NAMES = new Set([
  ...LOGS, ...COBBLE, ...ORES,
  'coal','charcoal','iron_ingot','gold_ingot','diamond',
  'stick','crafting_table','furnace',
  ...RAW_LIST, ...COOKED_LIST,
  'apple','carrot','bread','baked_potato','golden_apple','golden_carrot'
]);

// ══════════════════════════════════════════
// STATE
// ══════════════════════════════════════════
const S = {
  STARTUP:'startup', IDLE:'idle',
  COMBAT:'combat', PVP:'pvp',
  FLEE:'flee', HOME:'home', SHELTER:'shelter',
  EAT:'eat', HUNT:'hunt',
  WOOD:'wood', STONE:'stone', CRAFT:'craft', COOK:'cook', SMELT:'smelt',
  BUILD_HOUSE:'build_house', REPAIR_HOUSE:'repair_house', PICKUP:'pickup'
};

let bot, mcData;
let state = S.STARTUP, registered = false;
let target = null, playerTarget = null, busy = false;
let mainLoop, lookLoop;
let startupDone = false;

// ══════════════════════════════════════════
// HOUSE MEMORY
// ══════════════════════════════════════════
const house = {
  pos:    null,    // Vec3 of the house centre (persists across reconnects)
  exists: false,
  door:   null     // Vec3 of the door block
};

// ══════════════════════════════════════════
// UTIL
// ══════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms));
// True only while the current bot session is live
const alive = () => !!(bot?.entity && registered);

// ══════════════════════════════════════════
// CREATE BOT
// ══════════════════════════════════════════
function createBot() {
  // Full state reset for every new session
  state = S.STARTUP; registered = false;
  target = null; playerTarget = null; busy = false;

  bot = mineflayer.createBot(config);
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    mcData = mcDataLoader(bot.version);
    const mov = new Movements(bot);
    mov.allowSprinting = true;
    bot.pathfinder.setMovements(mov);
    // Hard-clear any lingering movement/sneak on every fresh spawn
    stopMovement();
    console.log('[BOT] Spawned');
    startAuthFlow();
  });

  bot.on('message', handleMessage);

  // ── Damage event: attack back or note player attacker ──────────────────
  bot.on('entityHurt', e => {
    if (e !== bot.entity || !registered) return;

    // BUG FIX 1: always cancel sneak on damage (removes the crouching glitch)
    bot.setControlState('sneak', false);

    // Find the nearest player that isn't ourselves
    const attacker = Object.values(bot.entities).find(en =>
      en &&
      en.type === 'player' &&
      en.isValid &&
      en.username !== config.username &&   // BUG FIX 2: never target self
      bot.entity.position.distanceTo(en.position) < 16
    );

    if (attacker) {
      console.log('[PVP] Hit by player:', attacker.username);
      playerTarget = attacker;
      if (![S.FLEE, S.HOME, S.SHELTER].includes(state)) setState(S.PVP);
    }
  });

  bot.on('health',  () => { if (registered) onHealth(); });
  bot.on('kicked',  r  => {
    const msg = typeof r === 'string' ? r : JSON.stringify(r);
    console.log('[KICKED]', msg);
    // Back off longer if the server is throttling us
    if (msg.toLowerCase().includes('throttl') || msg.toLowerCase().includes('wait')) {
      reconnectDelay = Math.min(reconnectDelay * 2, 90000);
      console.log(`[RECONNECT] Throttle detected – waiting ${reconnectDelay/1000}s`);
    }
    cleanup();
    setTimeout(createBot, reconnectDelay);
  });
  bot.on('error', e => {
    console.log('[ERROR]', e.message);
    cleanup();
    setTimeout(createBot, reconnectDelay);
  });
  bot.on('end', () => {
    console.log('[END]');
    cleanup();
    setTimeout(createBot, reconnectDelay);
  });
}

// ══════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════
const MAX_AUTH_ATTEMPTS   = 2;
const AUTH_RETRY_COOLDOWN = 4000;
const AUTH_WATCHDOG_MS    = 15000;
let authAttempts = 0, lastAuthTry = 0, authWatchdog = null;

function startAuthFlow() {
  authAttempts = 0; lastAuthTry = 0;
  clearTimeout(authWatchdog);
  setTimeout(attemptRegister, 1500);
  authWatchdog = setTimeout(() => {
    if (!registered) {
      console.log('[AUTH] Watchdog – proceeding without auth');
      resolveAuth();
    }
  }, AUTH_WATCHDOG_MS);
}

function canAttemptAuth() {
  return !registered &&
    authAttempts < MAX_AUTH_ATTEMPTS &&
    (Date.now() - lastAuthTry) > AUTH_RETRY_COOLDOWN;
}
function attemptRegister() {
  if (!canAttemptAuth()) return;
  authAttempts++; lastAuthTry = Date.now();
  console.log(`[AUTH] /register (${authAttempts}/${MAX_AUTH_ATTEMPTS})`);
  try { bot.chat(`/register ${REG_PASSWORD} ${REG_PASSWORD}`); } catch {}
}
function attemptLogin() {
  if (!canAttemptAuth()) return;
  authAttempts++; lastAuthTry = Date.now();
  console.log(`[AUTH] /login (${authAttempts}/${MAX_AUTH_ATTEMPTS})`);
  try { bot.chat(`/login ${REG_PASSWORD}`); } catch {}
}
function resolveAuth() {
  if (registered) return;
  registered = true;
  clearTimeout(authWatchdog);
  reconnectDelay = 20000;   // reset back-off on successful auth
  console.log('[BOT] Auth OK – starting AI');
  startAI();
}

function handleMessage(msg) {
  const m = msg.toString().toLowerCase();
  console.log('[SERVER]', m);
  if (registered) return;

  if (m.includes('unknown or incomplete command') || m.includes('unknown command')) {
    console.log('[AUTH] No auth plugin – skipping');
    resolveAuth(); return;
  }
  if (m.includes('already registered'))                                   { attemptLogin();    return; }
  if (m.includes('not registered') || m.includes('please register'))      { attemptRegister(); return; }
  if (m.includes('please login') || m.includes('please log in') ||
      m.includes('you need to login') || m.includes('you need to log in')){ attemptLogin();    return; }
  if (m.includes('successfully registered') || m.includes('registration successful')) {
    setTimeout(() => { if (!registered) attemptLogin(); }, 1000); return;
  }
  if (m.includes('successfully logged in') || m.includes('logged in successfully') ||
      m.includes('login successful') || m.includes('welcome back')) { resolveAuth(); }
}

// ══════════════════════════════════════════
// HEALTH MONITOR
// ══════════════════════════════════════════
function onHealth() {
  const hp = bot.health, food = bot.food;
  console.log(`[HP:${hp.toFixed(0)} Food:${food} State:${state}]`);

  // Eat if hungry
  if (food <= 8 && ![S.HOME, S.SHELTER, S.EAT].includes(state) && hasFood()) eatFood();

  // Critical HP → go home if possible, else flee
  if (hp <= HP_SHELTER && ![S.HOME, S.SHELTER, S.FLEE].includes(state)) {
    if (house.pos) { setState(S.HOME); goHome(); }
    else { setState(S.FLEE); flee(); }
    return;
  }
  if (hp <= HP_FLEE && ![S.FLEE, S.HOME, S.SHELTER].includes(state)) {
    setState(S.FLEE); flee();
  }
  if (hp >= HP_SAFE && state === S.FLEE) setState(S.IDLE);
}

// ══════════════════════════════════════════
// AI LOOP
// ══════════════════════════════════════════
function startAI() {
  clearInterval(mainLoop); clearInterval(lookLoop);

  mainLoop = setInterval(async () => {
    if (!bot?.entity || busy) return;
    try {
      switch (state) {
        case S.STARTUP:       await startupTick();      break;
        case S.IDLE:          await idleTick();          break;
        case S.COMBAT:        combatTick();              break;
        case S.PVP:           pvpTick();                 break;
        case S.HUNT:          await huntTick();          break;
        case S.WOOD:          await woodTick();          break;
        case S.STONE:         await stoneTick();         break;
        case S.CRAFT:         await craftTick();         break;
        case S.COOK:          await cookTick();          break;
        case S.SMELT:         await smeltTick();         break;
        case S.HOME:          await homeTick();          break;
        case S.BUILD_HOUSE:   await buildHouseTick();    break;
        case S.REPAIR_HOUSE:  await repairHouseTick();   break;
        case S.PICKUP:        await pickupTick();        break;
      }
    } catch(e) { console.log('[TICK ERROR]', e.message); busy = false; }
  }, 1000);

  lookLoop = setInterval(() => {
    if (state === S.IDLE && bot?.entity)
      bot.look((Math.random()*2-1)*Math.PI, (Math.random()-0.5)*(Math.PI/3), true);
  }, 3000);
}

// ══════════════════════════════════════════
// STARTUP SEQUENCE  (BUG FIX 3: proper crafting table flow)
//
// mineflayer's recipesFor() only returns a recipe when you
// already have the ingredients.  Sticks need planks; a wooden
// pickaxe needs a 3×3 grid → crafting table.  The old code
// tried to make sticks/pickaxe before either existed, so it
// always got "No recipe".  We now follow the correct order:
//
//  logs → planks (2×2, no table)
//  planks → crafting_table (2×2, no table)
//  place table → sticks + wooden_pickaxe at table
//  mine stone → stone_pickaxe + stone tools at table
// ══════════════════════════════════════════
async function startupTick() {
  if (busy) return;
  if (startupDone) { setState(S.IDLE); return; }
  busy = true;

  try {
    // ── Phase 1: collect 5 logs ──────────────────────────────────────────
    console.log('[STARTUP] P1: collect 5 logs');
    while (alive() && countItems(LOGS) < 5) {
      const lb = findNearBlock(LOGS, 40);
      if (!lb) { wander(); await sleep(3000); continue; }
      try {
        equipBest(AXE_P);
        await bot.pathfinder.goto(new GoalNear(lb.position.x, lb.position.y, lb.position.z, 2));
        const fresh = bot.blockAt(lb.position);
        if (fresh && LOGS.includes(fresh.name)) await bot.dig(fresh);
      } catch {}
      await sleep(400);
    }
    if (!alive()) { busy = false; return; }

    // ── Phase 2: logs → planks (no crafting table needed) ───────────────
    console.log('[STARTUP] P2: craft planks');
    await craftLogsIntoPlanks();
    await sleep(300);
    console.log(`[STARTUP] Planks in inventory: ${countItems(PLANKS)}`);

    // ── Phase 3: make crafting table (4 planks, 2×2) ────────────────────
    console.log('[STARTUP] P3: make crafting table');
    if (!hasItem('crafting_table') && !findNearBlock(['crafting_table'], 16)) {
      await makeNoTable('crafting_table', 1);
      await sleep(300);
    }

    // ── Phase 4: place crafting table & go to it ─────────────────────────
    let table = findNearBlock(['crafting_table'], 10);
    if (!table && hasItem('crafting_table')) {
      await placeBlockNear('crafting_table');
      await sleep(600);
      table = findNearBlock(['crafting_table'], 10);
    }
    if (table) {
      await bot.pathfinder.goto(new GoalNear(table.position.x, table.position.y, table.position.z, 2));
    }

    // ── Phase 5: sticks + wooden pickaxe ────────────────────────────────
    console.log('[STARTUP] P4: craft sticks + wooden pickaxe');
    await make('stick', 4, table);
    await sleep(200);
    if (!hasItem(PICK_P)) await make('wooden_pickaxe', 1, table);
    await sleep(200);
    if (!alive()) { busy = false; return; }

    // ── Phase 6: mine 3 stone ───────────────────────────────────────────
    console.log('[STARTUP] P5: mine 3 stone');
    while (alive() && countItems(COBBLE) < 3) {
      equipBest(PICK_P);
      const sb = findNearBlock(STONE, 30);
      if (!sb) { wander(); await sleep(3000); continue; }
      try {
        await bot.pathfinder.goto(new GoalNear(sb.position.x, sb.position.y, sb.position.z, 2));
        const fresh = bot.blockAt(sb.position);
        if (fresh && STONE.includes(fresh.name)) await bot.dig(fresh);
      } catch {}
      await sleep(400);
    }
    if (!alive()) { busy = false; return; }

    // ── Phase 7: stone pickaxe ──────────────────────────────────────────
    console.log('[STARTUP] P6: craft stone pickaxe');
    table = findNearBlock(['crafting_table'], 10);
    if (!table && hasItem('crafting_table')) {
      await placeBlockNear('crafting_table');
      await sleep(600);
      table = findNearBlock(['crafting_table'], 10);
    }
    if (table)
      await bot.pathfinder.goto(new GoalNear(table.position.x, table.position.y, table.position.z, 2));
    await make('stone_pickaxe', 1, table);
    await sleep(200);
    if (!alive()) { busy = false; return; }

    // ── Phase 8: gather more wood + stone ───────────────────────────────
    console.log('[STARTUP] P7: stock up on wood & stone');
    while (alive() && (countItems(LOGS) < 12 || countItems(COBBLE) < 12)) {
      if (countItems(LOGS) < 12) {
        const lb = findNearBlock(LOGS, 32);
        if (lb) {
          equipBest(AXE_P);
          try {
            await bot.pathfinder.goto(new GoalNear(lb.position.x, lb.position.y, lb.position.z, 2));
            const fresh = bot.blockAt(lb.position);
            if (fresh && LOGS.includes(fresh.name)) await bot.dig(fresh);
          } catch {}
          await sleep(300);
        }
      }
      if (countItems(COBBLE) < 12) {
        equipBest(PICK_P);
        const sb = findNearBlock(STONE, 28);
        if (sb) {
          try {
            await bot.pathfinder.goto(new GoalNear(sb.position.x, sb.position.y, sb.position.z, 2));
            const fresh = bot.blockAt(sb.position);
            if (fresh && STONE.includes(fresh.name)) await bot.dig(fresh);
          } catch {}
          await sleep(300);
        }
      }
    }
    if (!alive()) { busy = false; return; }

    // ── Phase 9: craft full stone tool set ──────────────────────────────
    console.log('[STARTUP] P8: craft stone tools');
    await craftLogsIntoPlanks();   // convert extra logs for sticks
    table = findNearBlock(['crafting_table'], 10);
    if (!table && hasItem('crafting_table')) {
      await placeBlockNear('crafting_table');
      await sleep(600);
      table = findNearBlock(['crafting_table'], 10);
    }
    if (table)
      await bot.pathfinder.goto(new GoalNear(table.position.x, table.position.y, table.position.z, 2));
    await make('stick', 8, table);
    await make('stone_sword',   1, table);
    await make('stone_axe',     1, table);
    await make('stone_pickaxe', 1, table);
    if (countItems(COBBLE) >= 8) await make('furnace', 1, table);

    startupDone = true;
    console.log('[STARTUP] ✅ Done!');
  } catch(e) { console.log('[STARTUP ERROR]', e.message); }

  busy = false;
  setState(S.IDLE);
}

// Convert every log in inventory to planks using the 2×2 grid (no table needed)
async function craftLogsIntoPlanks() {
  for (const log of bot.inventory.items().filter(i => LOGS.includes(i.name))) {
    const plankName = log.name.replace('_log','_planks');
    const pd = mcData.itemsByName[plankName];
    if (!pd) continue;
    const r = bot.recipesFor(pd.id, null, 1, null);
    if (r.length) {
      try { await bot.craft(r[0], log.count, null); } catch {}
    }
    await sleep(150);
  }
}

// make() variant that explicitly uses no crafting table (2×2 grid only)
async function makeNoTable(name, count) {
  return make(name, count, null);
}

// ══════════════════════════════════════════
// IDLE – PRIORITY QUEUE
// ══════════════════════════════════════════
async function idleTick() {
  // P0 – pick up useful ground items nearby
  if (hasUsefulGroundItems(16)) { setState(S.PICKUP); return; }

  // P1 – hostile mob nearby
  const mob = nearbyEntity(HOSTILE, MOB_DETECT);
  if (mob) { target = mob; setState(S.COMBAT); return; }

  // P1b – follow up on an ongoing player fight
  if (playerTarget?.isValid) { setState(S.PVP); return; }

  // P2 – eat
  if (bot.food <= 14 && hasFood()) { await eatFood(); return; }

  // P3 – smelt ores in furnace
  if (hasItem(ORES) && (hasFurnaceNearby() || hasItem('furnace'))) { setState(S.SMELT); return; }

  // P4 – cook raw meat
  if (hasRawFood() && (hasFurnaceNearby() || hasItem('furnace'))) { setState(S.COOK); return; }

  // P5 – hunt for food
  if (foodCount() < FOOD_GOAL) {
    const animal = nearbyEntity(ANIMALS, 24);
    if (animal) { target = animal; setState(S.HUNT); return; }
  }

  // P6 – craft tools if missing
  if (needsCrafting()) {
    const wood = countItems(LOGS)*4 + countItems(PLANKS);
    setState(wood >= 12 ? S.CRAFT : S.WOOD);
    return;
  }

  // P7 – upgrade wooden → stone tools
  const hasStoneOrBetter = hasItem([
    'stone_sword','stone_pickaxe','stone_axe',
    'iron_sword','iron_pickaxe','iron_axe',
    'diamond_sword','diamond_pickaxe','diamond_axe',
    'netherite_sword','netherite_pickaxe','netherite_axe'
  ]);
  if (!hasStoneOrBetter && hasItem(PICK_P)) {
    setState(countItems(COBBLE) >= 8 ? S.CRAFT : S.STONE);
    return;
  }

  // P8 – stock wood
  if (countItems(LOGS) < 16 && findNearBlock(LOGS, 32)) { setState(S.WOOD); return; }

  // P9 – repair house if damaged
  if (house.pos && !isHouseIntact()) { setState(S.REPAIR_HOUSE); return; }

  // P10 – build house if none
  if (!house.pos) { setState(S.BUILD_HOUSE); return; }

  // P11 – wander/idle
  if (Math.random() < 0.25) wander();
  if (Math.random() < 0.06) doJump();
  if (Math.random() < 0.04) bot.swingArm();
}

// ══════════════════════════════════════════
// ITEM PICKUP
// ══════════════════════════════════════════
function hasUsefulGroundItems(dist) {
  return Object.values(bot.entities).some(e =>
    e.type === 'object' && e.objectType === 'Item' &&
    bot.entity.position.distanceTo(e.position) < dist &&
    PICKUP_NAMES.has(e.metadata?.[8]?.itemId
      ? (mcData.items[e.metadata[8].itemId]?.name || '')
      : '')
  );
}

async function pickupTick() {
  if (busy) return;
  const items = Object.values(bot.entities).filter(e => {
    if (e.type !== 'object' || e.objectType !== 'Item') return false;
    if (bot.entity.position.distanceTo(e.position) > 20) return false;
    const name = mcData.items[e.metadata?.[8]?.itemId]?.name || '';
    return PICKUP_NAMES.has(name);
  });
  if (!items.length) { setState(S.IDLE); return; }

  busy = true;
  const closest = items.reduce((a, b) =>
    bot.entity.position.distanceTo(a.position) <
    bot.entity.position.distanceTo(b.position) ? a : b
  );
  try {
    await bot.pathfinder.goto(
      new GoalNear(closest.position.x, closest.position.y, closest.position.z, 1)
    );
    await sleep(300);
    console.log('[PICKUP] Grabbed item');
  } catch(e) { console.log('[PICKUP ERROR]', e.message); }
  busy = false;
  setState(S.IDLE);
}

// ══════════════════════════════════════════
// HOUSE SYSTEM
// ══════════════════════════════════════════
async function buildHouseTick() {
  if (busy) return;
  busy = true;
  try {
    // Pick a spot 6 blocks in front of the bot
    const dir = bot.entity.yaw;
    const cx  = Math.round(bot.entity.position.x + Math.sin(-dir) * 6);
    const cy  = Math.round(bot.entity.position.y);
    const cz  = Math.round(bot.entity.position.z + Math.cos(-dir) * 6);
    house.pos = new Vec3(cx, cy, cz);

    console.log('[HOUSE] Building at', house.pos);

    const buildBlock = bot.inventory.items().find(i => BUILD_BLOCKS.includes(i.name));
    if (!buildBlock || buildBlock.count < 16) {
      console.log('[HOUSE] Not enough blocks – mining first');
      busy = false;
      setState(S.STONE);
      return;
    }

    await bot.equip(buildBlock, 'hand');

    // Build a simple 5×3×5 (width × height × depth) box with one door gap
    for (let h = 0; h < 3; h++) {
      for (let x = -2; x <= 2; x++) {
        for (let z = -2; z <= 2; z++) {
          // Only walls (perimeter)
          if (Math.abs(x) !== 2 && Math.abs(z) !== 2) continue;
          // Leave a 1-block door gap on the front wall, ground level
          if (h === 0 && x === 0 && z === 2) {
            house.door = new Vec3(cx + x, cy + h, cz + z);
            continue;
          }
          const blockPos = new Vec3(cx + x, cy + h, cz + z);
          const existing = bot.blockAt(blockPos);
          if (!existing || existing.name === 'air' || existing.name === 'cave_air') {
            try {
              const ref = bot.blockAt(blockPos.offset(0, -1, 0));
              if (ref && !['air','cave_air'].includes(ref.name))
                await bot.placeBlock(ref, new Vec3(0, 1, 0));
            } catch {}
            await sleep(80);
          }
        }
      }
    }

    // Place door if we have one
    const doorItem = bot.inventory.items().find(i => DOORS.includes(i.name));
    if (doorItem && house.door) {
      try {
        await bot.equip(doorItem, 'hand');
        const ground = bot.blockAt(house.door.offset(0, -1, 0));
        if (ground) await bot.placeBlock(ground, new Vec3(0, 1, 0));
      } catch {}
    }

    house.exists = true;
    console.log('[HOUSE] Built!');
  } catch(e) { console.log('[HOUSE ERROR]', e.message); }
  busy = false;
  setState(S.IDLE);
}

async function repairHouseTick() {
  if (busy || !house.pos) { setState(S.IDLE); return; }
  busy = true;
  try {
    const buildBlock = bot.inventory.items().find(i => BUILD_BLOCKS.includes(i.name));
    if (!buildBlock) { setState(S.STONE); busy = false; return; }
    await bot.equip(buildBlock, 'hand');

    const cx = house.pos.x, cy = house.pos.y, cz = house.pos.z;
    for (let h = 0; h < 3; h++) {
      for (let x = -2; x <= 2; x++) {
        for (let z = -2; z <= 2; z++) {
          if (Math.abs(x) !== 2 && Math.abs(z) !== 2) continue;
          const blockPos = new Vec3(cx + x, cy + h, cz + z);
          const b = bot.blockAt(blockPos);
          if (b && (b.name === 'air' || b.name === 'cave_air')) {
            try {
              await bot.pathfinder.goto(new GoalNear(blockPos.x, blockPos.y, blockPos.z, 4));
              const ref = bot.blockAt(blockPos.offset(0, -1, 0));
              if (ref && !['air','cave_air'].includes(ref.name))
                await bot.placeBlock(ref, new Vec3(0, 1, 0));
              console.log('[REPAIR] Patched', blockPos);
            } catch {}
            await sleep(150);
          }
        }
      }
    }
    console.log('[REPAIR] Done');
  } catch(e) { console.log('[REPAIR ERROR]', e.message); }
  busy = false;
  setState(S.IDLE);
}

function isHouseIntact() {
  if (!house.pos) return true;
  const cx = house.pos.x, cy = house.pos.y, cz = house.pos.z;
  for (let h = 0; h < 3; h++)
    for (let x = -2; x <= 2; x++)
      for (let z = -2; z <= 2; z++) {
        if (Math.abs(x) !== 2 && Math.abs(z) !== 2) continue;
        const b = bot.blockAt(new Vec3(cx+x, cy+h, cz+z));
        if (b && (b.name === 'air' || b.name === 'cave_air')) return false;
      }
  return true;
}

function goHome() {
  if (!house.pos) { setState(S.FLEE); flee(); return; }
  console.log('[HOME] Running home to', house.pos);
  bot.pathfinder.setGoal(new GoalNear(house.pos.x, house.pos.y, house.pos.z, 4));
}

async function homeTick() {
  if (!house.pos) { setState(S.FLEE); flee(); return; }
  const dist = bot.entity.position.distanceTo(house.pos);
  if (dist < 8) {
    bot.pathfinder.setGoal(null);
    if (hasFood()) await eatFood();
    waitUntilSafe();
  } else {
    goHome();
  }
}

function waitUntilSafe() {
  const ck = setInterval(() => {
    if (!bot || state !== S.HOME) { clearInterval(ck); return; }
    if (bot.food < 16 && hasFood()) eatFood();
    if (!nearbyEntity(HOSTILE, 12) && bot.health >= HP_SAFE) {
      clearInterval(ck);
      bot.setControlState('sneak', false);
      console.log('[HOME] Safe – resuming');
      setState(S.IDLE);
    }
  }, 3000);
}

// ══════════════════════════════════════════
// COMBAT (hostile mobs)
// ══════════════════════════════════════════
function combatTick() {
  if (!target?.isValid) { target = null; setState(S.IDLE); return; }
  if (bot.health <= HP_FLEE) {
    bot.pathfinder.setGoal(null);
    setState(house.pos ? S.HOME : S.FLEE);
    house.pos ? goHome() : flee();
    return;
  }

  equipBest(SWORD_P);
  const dist = bot.entity.position.distanceTo(target.position);
  if (dist > ATK_DIST) {
    bot.pathfinder.setGoal(new GoalNear(
      target.position.x, target.position.y, target.position.z, 2));
  } else {
    bot.pathfinder.setGoal(null);
    bot.lookAt(target.position.offset(0, target.height * 0.9, 0));
    bot.attack(target);
    if (bot.entity.onGround && Math.random() > 0.4) doJump(); // crit
  }

  // Re-target the closest threat
  const closest = nearbyEntity(HOSTILE, MOB_DETECT);
  if (closest && closest !== target) {
    if (bot.entity.position.distanceTo(closest.position) <
        bot.entity.position.distanceTo(target.position)) target = closest;
  }
}

// ══════════════════════════════════════════
// PVP (player attacked us – fight back)
// ══════════════════════════════════════════
function pvpTick() {
  if (!playerTarget?.isValid) { playerTarget = null; setState(S.IDLE); return; }
  if (bot.health <= HP_FLEE) {
    bot.pathfinder.setGoal(null);
    playerTarget = null;
    setState(house.pos ? S.HOME : S.FLEE);
    house.pos ? goHome() : flee();
    return;
  }

  equipBest(SWORD_P);
  const dist = bot.entity.position.distanceTo(playerTarget.position);
  if (dist > 30) { playerTarget = null; setState(S.IDLE); return; }

  if (dist > ATK_DIST) {
    bot.pathfinder.setGoal(new GoalNear(
      playerTarget.position.x, playerTarget.position.y, playerTarget.position.z, 2));
  } else {
    bot.pathfinder.setGoal(null);
    bot.lookAt(playerTarget.position.offset(0, playerTarget.height * 0.9, 0));
    bot.attack(playerTarget);
    if (bot.entity.onGround && Math.random() > 0.5) doJump(); // crit
  }
}

// ══════════════════════════════════════════
// HUNT (food supply)
// ══════════════════════════════════════════
async function huntTick() {
  const mob = nearbyEntity(HOSTILE, MOB_DETECT);
  if (mob) { bot.pathfinder.setGoal(null); target = mob; setState(S.COMBAT); return; }
  if (foodCount() >= FOOD_GOAL) { bot.pathfinder.setGoal(null); target = null; setState(S.IDLE); return; }

  if (!target?.isValid) {
    target = nearbyEntity(ANIMALS, 24);
    if (!target) { if (hasFood()) await eatFood(); setState(S.IDLE); return; }
  }

  equipBest(SWORD_P);
  const dist = bot.entity.position.distanceTo(target.position);
  if (dist > ATK_DIST) {
    bot.pathfinder.setGoal(new GoalNear(
      target.position.x, target.position.y, target.position.z, 2));
  } else {
    bot.pathfinder.setGoal(null);
    bot.lookAt(target.position.offset(0, target.height * 0.9, 0));
    bot.attack(target);
  }
}

// ══════════════════════════════════════════
// WOOD
// ══════════════════════════════════════════
async function woodTick() {
  if (busy) return; busy = true;
  if (nearbyEntity(HOSTILE, MOB_DETECT)) { busy = false; target = nearbyEntity(HOSTILE, MOB_DETECT); setState(S.COMBAT); return; }
  if (countItems(LOGS) >= 16) { busy = false; setState(S.CRAFT); return; }

  const lb = findNearBlock(LOGS, 32);
  if (!lb) { busy = false; setState(S.IDLE); return; }

  try {
    equipBest(AXE_P);
    await bot.pathfinder.goto(new GoalNear(lb.position.x, lb.position.y, lb.position.z, 2));
    const fresh = bot.blockAt(lb.position);
    if (fresh && LOGS.includes(fresh.name)) { await bot.dig(fresh); console.log('[WOOD]', fresh.name); }
  } catch(e) { console.log('[WOOD ERROR]', e.message); }
  busy = false;
}

// ══════════════════════════════════════════
// STONE
// ══════════════════════════════════════════
async function stoneTick() {
  if (busy) return; busy = true;
  if (nearbyEntity(HOSTILE, MOB_DETECT)) { busy = false; target = nearbyEntity(HOSTILE, MOB_DETECT); setState(S.COMBAT); return; }
  if (countItems(COBBLE) >= 16) { busy = false; setState(S.CRAFT); return; }
  if (!equipBest(PICK_P)) { busy = false; setState(S.CRAFT); return; }

  const sb = findNearBlock(STONE, 24);
  if (!sb) { busy = false; setState(S.IDLE); return; }

  try {
    await bot.pathfinder.goto(new GoalNear(sb.position.x, sb.position.y, sb.position.z, 2));
    const fresh = bot.blockAt(sb.position);
    if (fresh && STONE.includes(fresh.name)) { await bot.dig(fresh); console.log('[STONE]', fresh.name); }
  } catch(e) { console.log('[STONE ERROR]', e.message); }
  busy = false;
}

// ══════════════════════════════════════════
// CRAFT
// ══════════════════════════════════════════
async function craftTick() {
  if (busy) return; busy = true;
  console.log('[CRAFT] Starting...');
  try {
    await craftLogsIntoPlanks();

    let table = findNearBlock(['crafting_table'], 8);
    if (!table) {
      if (!hasItem('crafting_table')) await makeNoTable('crafting_table', 1);
      if (hasItem('crafting_table')) {
        await placeBlockNear('crafting_table');
        await sleep(500);
        table = findNearBlock(['crafting_table'], 8);
      }
    }
    if (table)
      await bot.pathfinder.goto(new GoalNear(table.position.x, table.position.y, table.position.z, 2));

    await make('stick', 4, table);

    const cobble = countItems(COBBLE), planks = countItems(PLANKS);
    if (!hasItem(PICK_P))  {
      if (cobble >= 3) await make('stone_pickaxe', 1, table);
      else if (planks >= 3) await make('wooden_pickaxe', 1, table);
    }
    if (!hasItem(SWORD_P)) {
      if (cobble >= 2) await make('stone_sword', 1, table);
      else if (planks >= 2) await make('wooden_sword', 1, table);
    }
    if (!hasItem(AXE_P))   {
      if (cobble >= 3) await make('stone_axe', 1, table);
      else if (planks >= 3) await make('wooden_axe', 1, table);
    }
    if (!hasItem('furnace') && !hasFurnaceNearby() && cobble >= 8)
      await make('furnace', 1, table);

    // Upgrade wooden → stone if we now have cobble
    const c2 = countItems(COBBLE);
    if (c2 >= 2 && hasItem(['wooden_sword'])    && !hasItem(['stone_sword','iron_sword','diamond_sword','netherite_sword']))
      await make('stone_sword', 1, table);
    if (c2 >= 3 && hasItem(['wooden_pickaxe']) && !hasItem(['stone_pickaxe','iron_pickaxe','diamond_pickaxe','netherite_pickaxe']))
      await make('stone_pickaxe', 1, table);
    if (c2 >= 3 && hasItem(['wooden_axe'])     && !hasItem(['stone_axe','iron_axe','diamond_axe','netherite_axe']))
      await make('stone_axe', 1, table);

    console.log('[CRAFT] Done!');
  } catch(e) { console.log('[CRAFT ERROR]', e.message); }
  busy = false;
  setState(S.IDLE);
}

// ══════════════════════════════════════════
// COOK (raw food → cooked food)
// ══════════════════════════════════════════
async function cookTick() {
  if (busy) return; busy = true;
  try {
    let fb = findNearBlock(['furnace','lit_furnace'], 16);
    if (!fb) {
      if (!hasItem('furnace')) { busy = false; setState(S.IDLE); return; }
      await placeBlockNear('furnace');
      await sleep(600);
      fb = findNearBlock(['furnace'], 8);
    }
    if (!fb) { busy = false; setState(S.IDLE); return; }

    await bot.pathfinder.goto(new GoalNear(fb.position.x, fb.position.y, fb.position.z, 2));
    const furnace = await bot.openFurnace(fb);

    const rawItem = bot.inventory.items().find(i => RAW_LIST.includes(i.name));
    if (rawItem) await furnace.putInput(rawItem.type, null, rawItem.count);

    const fuel = bot.inventory.items().find(i =>
      ['coal','charcoal'].includes(i.name) || PLANKS.includes(i.name) || LOGS.includes(i.name)
    );
    if (fuel) await furnace.putFuel(fuel.type, null, Math.min(fuel.count, 8));

    console.log('[COOK] Smelting food...');
    await new Promise(res => {
      const t = setTimeout(res, 90000);
      furnace.once('update', () => { clearTimeout(t); setTimeout(res, 500); });
    });
    try { await furnace.takeOutput(); } catch {}
    furnace.close();
    console.log('[COOK] Done!');
  } catch(e) { console.log('[COOK ERROR]', e.message); }
  busy = false;
  setState(S.IDLE);
}

// ══════════════════════════════════════════
// SMELT (ores → ingots)
// ══════════════════════════════════════════
async function smeltTick() {
  if (busy) return; busy = true;
  try {
    let fb = findNearBlock(['furnace','lit_furnace'], 16);
    if (!fb) {
      if (!hasItem('furnace')) { busy = false; setState(S.IDLE); return; }
      await placeBlockNear('furnace');
      await sleep(600);
      fb = findNearBlock(['furnace'], 8);
    }
    if (!fb) { busy = false; setState(S.IDLE); return; }

    await bot.pathfinder.goto(new GoalNear(fb.position.x, fb.position.y, fb.position.z, 2));
    const furnace = await bot.openFurnace(fb);

    const ore = bot.inventory.items().find(i => ORES.includes(i.name));
    if (ore) await furnace.putInput(ore.type, null, ore.count);

    const fuel = bot.inventory.items().find(i =>
      ['coal','charcoal'].includes(i.name) || PLANKS.includes(i.name) || LOGS.includes(i.name)
    );
    if (fuel) await furnace.putFuel(fuel.type, null, Math.min(fuel.count, 16));

    console.log('[SMELT] Smelting ores...');
    await new Promise(res => {
      const t = setTimeout(res, 120000);
      furnace.once('update', () => { clearTimeout(t); setTimeout(res, 500); });
    });
    try { await furnace.takeOutput(); } catch {}
    furnace.close();
    console.log('[SMELT] Done!');
  } catch(e) { console.log('[SMELT ERROR]', e.message); }
  busy = false;
  setState(S.IDLE);
}

// ══════════════════════════════════════════
// FLEE
// ══════════════════════════════════════════
function flee() {
  bot.pathfinder.setGoal(null);
  stopMovement();
  console.log('[BOT] FLEE!');

  // BUG FIX 4: if house is nearby, run there instead of random direction
  if (house.pos) {
    const houseDist = bot.entity.position.distanceTo(house.pos);
    if (houseDist < 80) {
      console.log('[FLEE] Running home!');
      setState(S.HOME);
      goHome();
      return;
    }
  }

  // Otherwise flee away from threat
  const mob = nearbyEntity(HOSTILE, 20) || nearbyEntity(new Set([playerTarget?.name||'__']), 20);
  if (!mob) { setState(S.IDLE); return; }
  const p = bot.entity.position, t = mob.position;
  const dx = p.x-t.x, dz = p.z-t.z, len = Math.sqrt(dx*dx+dz*dz)||1;
  bot.pathfinder.setGoal(new GoalNear(p.x + dx/len*30, p.y, p.z + dz/len*30, 2));

  const ck = setInterval(() => {
    if (!bot || state !== S.FLEE) { clearInterval(ck); return; }
    if (bot.health <= HP_SHELTER) {
      clearInterval(ck); bot.pathfinder.setGoal(null);
      setState(house.pos ? S.HOME : S.SHELTER);
      house.pos ? goHome() : buildTempShelter();
      return;
    }
    if (!nearbyEntity(HOSTILE, 10) && bot.health >= HP_SAFE) {
      clearInterval(ck); bot.pathfinder.setGoal(null); setState(S.IDLE);
    }
  }, 2000);
}

// ══════════════════════════════════════════
// TEMP SHELTER (no house built yet)
// ══════════════════════════════════════════
async function buildTempShelter() {
  bot.setControlState('sneak', true);
  console.log('[BOT] Building temp shelter!');
  const blockItem = bot.inventory.items().find(i => BUILD_BLOCKS.includes(i.name));
  if (blockItem?.count >= 3) {
    await bot.equip(blockItem, 'hand');
    const pos = bot.entity.position.floored();
    for (const s of [new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1)]) {
      try {
        const ground = bot.blockAt(pos.plus(s).offset(0,-1,0));
        if (ground && !['air','cave_air'].includes(ground.name)) {
          await bot.placeBlock(ground, new Vec3(0,1,0));
          await sleep(150);
        }
      } catch {}
    }
  }
  bot.setControlState('sneak', false);
  if (hasFood()) await eatFood();
  const ck = setInterval(() => {
    if (!bot || state !== S.SHELTER) { clearInterval(ck); return; }
    if (bot.food < 16 && hasFood()) eatFood();
    if (!nearbyEntity(HOSTILE, 12) && bot.health >= HP_SAFE) {
      clearInterval(ck); console.log('[BOT] Safe – resuming'); setState(S.IDLE);
    }
  }, 3000);
}

// ══════════════════════════════════════════
// EAT
// ══════════════════════════════════════════
async function eatFood() {
  if (state === S.EAT) return;
  const food = bot.inventory.items().find(i => COOKED_LIST.includes(i.name))
            || bot.inventory.items().find(i => FOOD_SET.has(i.name));
  if (!food) return;
  const prev = state;
  try {
    setState(S.EAT);
    await bot.equip(food, 'hand');
    await bot.consume();
    console.log('[EAT]', food.name, '→ food level:', bot.food);
  } catch(e) { console.log('[EAT ERROR]', e.message); }
  finally { setState(prev === S.EAT ? S.IDLE : prev); }
}

// ══════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════
async function make(name, count, table) {
  const item = mcData.itemsByName[name];
  if (!item) return false;
  const r = bot.recipesFor(item.id, null, 1, table);
  if (!r.length) {
    console.log(`[CRAFT] No recipe for "${name}" (table=${!!table}, have planks=${countItems(PLANKS)}, cobble=${countItems(COBBLE)})`);
    return false;
  }
  try {
    await bot.craft(r[0], count, table);
    console.log(`[CRAFT] ✅ ${count}x ${name}`);
    return true;
  } catch(e) { console.log(`[CRAFT] ❌ ${name}:`, e.message); return false; }
}

async function placeBlockNear(itemName) {
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) return;
  const pos = bot.entity.position.floored();
  for (const off of [new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1)]) {
    const target = bot.blockAt(pos.plus(off));
    if (target?.name === 'air') {
      const ground = bot.blockAt(pos.plus(off).offset(0,-1,0));
      if (ground && !['air','cave_air'].includes(ground.name)) {
        try {
          await bot.equip(item, 'hand');
          await bot.placeBlock(ground, new Vec3(0,1,0));
          return;
        } catch {}
      }
    }
  }
}

function findNearBlock(names, dist) {
  const ids = names.map(n => mcData.blocksByName[n]?.id).filter(Boolean);
  return ids.length ? bot.findBlock({ matching: ids, maxDistance: dist }) : null;
}

function nearbyEntity(set, dist) {
  return Object.values(bot.entities)
    .filter(e =>
      e !== bot.entity && set.has(e.name) && e.isValid &&
      bot.entity.position.distanceTo(e.position) <= dist
    )
    .sort((a,b) =>
      bot.entity.position.distanceTo(a.position) -
      bot.entity.position.distanceTo(b.position)
    )[0] || null;
}

function equipBest(priority) {
  for (const name of priority) {
    const item = bot.inventory.items().find(i => i.name === name);
    if (item) { bot.equip(item, 'hand').catch(() => {}); return true; }
  }
  return false;
}

function hasItem(nameOrList) {
  const list = Array.isArray(nameOrList) ? nameOrList : [nameOrList];
  return list.some(n => bot.inventory.items().some(i => i.name === n));
}

function countItems(names) {
  const s = new Set(names);
  return bot.inventory.items().filter(i => s.has(i.name)).reduce((sum, i) => sum + i.count, 0);
}

function foodCount()        { return bot.inventory.items().filter(i => FOOD_SET.has(i.name)).reduce((s,i) => s+i.count, 0); }
function hasFood()          { return bot.inventory.items().some(i => FOOD_SET.has(i.name)); }
function hasRawFood()       { return bot.inventory.items().some(i => RAW_LIST.includes(i.name)); }
function hasFurnaceNearby() { return !!findNearBlock(['furnace','lit_furnace'], 16); }

function needsCrafting() {
  return !hasItem(SWORD_P) || !hasItem(PICK_P) || !hasItem(AXE_P) ||
         (!hasItem('furnace') && !hasFurnaceNearby());
}

function wander() {
  const d = ['forward','back','left','right'][Math.floor(Math.random()*4)];
  bot.setControlState(d, true);
  setTimeout(() => bot.setControlState(d, false), 1000 + Math.random()*2000);
}

function doJump() {
  bot.setControlState('jump', true);
  setTimeout(() => bot.setControlState('jump', false), 300);
}

function stopMovement() {
  ['forward','back','left','right','jump','sneak','sprint']
    .forEach(c => { try { bot.setControlState(c, false); } catch {} });
}

function setState(s) {
  if (state !== s) console.log(`[STATE] ${state} → ${s}`);
  state = s;
}

function cleanup() {
  clearInterval(mainLoop);
  clearInterval(lookLoop);
  busy = false;
  registered = false;
  try { stopMovement(); } catch {}
  try { bot?.end?.(); } catch {}   // BUG FIX 5: cleanly close old session before reconnect
}

createBot();
