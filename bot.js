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
const HP_FLEE    = 10;  // 5 hearts → run
const HP_SHELTER =  6;  // 3 hearts → build shelter
const HP_SAFE    = 16;  // 8 hearts → resume
const MOB_DETECT = 10;  // detect hostiles within 10 blocks
const ATK_DIST   = 3.5; // swing reach
const FOOD_GOAL  = 20;  // always keep 20 food items

// ══════════════════════════════════════════
// LISTS
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

const SWORD_P = ['netherite_sword','diamond_sword','iron_sword',
                 'stone_sword','wooden_sword','golden_sword'];
const PICK_P  = ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe',
                 'stone_pickaxe','wooden_pickaxe','golden_pickaxe'];
const AXE_P   = ['netherite_axe','diamond_axe','iron_axe',
                 'stone_axe','wooden_axe','golden_axe'];

// ══════════════════════════════════════════
// STATE
// ══════════════════════════════════════════
const S = {
  IDLE:'idle', COMBAT:'combat', FLEE:'flee', SHELTER:'shelter',
  EAT:'eat', HUNT:'hunt', WOOD:'wood', STONE:'stone', CRAFT:'craft', COOK:'cook'
};

let bot, mcData;
let state = S.IDLE, registered = false, target = null, busy = false;
let mainLoop, lookLoop;

// ══════════════════════════════════════════
// CREATE BOT
// ══════════════════════════════════════════
function createBot() {
  state = S.IDLE; registered = false; target = null; busy = false;
  bot = mineflayer.createBot(config);
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    mcData = mcDataLoader(bot.version);
    const mov = new Movements(bot);
    mov.allowSprinting = true;
    bot.pathfinder.setMovements(mov);
    console.log('[BOT] Spawned');
    startAuthFlow();
  });

  bot.on('message', msg => {
    const m = msg.toString().toLowerCase();
    console.log('[SERVER]', m);
    if (registered) return;

    // Server doesn't even recognize the command → no auth plugin installed, nothing to do.
    if (m.includes('unknown or incomplete command') || m.includes('unknown command')) {
      console.log('[AUTH] Server has no auth plugin — skipping registration');
      resolveAuth();
      return;
    }

    if (m.includes('already registered')) { attemptLogin(); return; }
    if (m.includes('not registered') || m.includes('please register')) { attemptRegister(); return; }
    if (m.includes('please login') || m.includes('please log in') ||
        m.includes('you need to login') || m.includes('you need to log in')) {
      attemptLogin();
      return;
    }
    if (m.includes('successfully registered') || m.includes('registration successful')) {
      // Some auth plugins still require a separate /login after registering.
      setTimeout(() => { if (!registered) attemptLogin(); }, 1000);
      return;
    }
    if (m.includes('successfully logged in') || m.includes('logged in successfully') ||
        m.includes('login successful') || m.includes('welcome back')) {
      resolveAuth();
    }
  });

  bot.on('health', () => { if (registered) onHealth(); });
  bot.on('kicked', r => { console.log('[KICKED]', r);        cleanup(); setTimeout(createBot, 10000); });
  bot.on('error',  e => { console.log('[ERROR]',  e.message); cleanup(); setTimeout(createBot, 10000); });
  bot.on('end',    () => { console.log('[END]');              cleanup(); setTimeout(createBot, 10000); });
}

// ══════════════════════════════════════════
// AUTH — bounded attempts, cooldown between tries,
// and a hard watchdog so the bot can never get stuck
// spamming /register forever.
// ══════════════════════════════════════════
const MAX_AUTH_ATTEMPTS    = 2;     // total /register + /login attempts allowed
const AUTH_RETRY_COOLDOWN  = 4000;  // ms — minimum gap between attempts
const AUTH_WATCHDOG_MS     = 15000; // ms — give up waiting and just start AI

let authAttempts  = 0;
let lastAuthTry    = 0;
let authWatchdog   = null;

function startAuthFlow() {
  authAttempts = 0;
  lastAuthTry = 0;
  clearTimeout(authWatchdog);

  // Most AuthMe-style plugins expect /register right after join.
  setTimeout(() => attemptRegister(), 1500);

  // No matter what the server says (or doesn't say), never stay stuck here.
  authWatchdog = setTimeout(() => {
    if (!registered) {
      console.log('[AUTH] Watchdog timeout — proceeding without confirmed auth');
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
  console.log(`[AUTH] /register (attempt ${authAttempts}/${MAX_AUTH_ATTEMPTS})`);
  bot.chat(`/register ${REG_PASSWORD} ${REG_PASSWORD}`);
}

function attemptLogin() {
  if (!canAttemptAuth()) return;
  authAttempts++; lastAuthTry = Date.now();
  console.log(`[AUTH] /login (attempt ${authAttempts}/${MAX_AUTH_ATTEMPTS})`);
  bot.chat(`/login ${REG_PASSWORD}`);
}

function resolveAuth() {
  if (registered) return;
  registered = true;
  clearTimeout(authWatchdog);
  console.log('[BOT] Auth resolved — starting AI');
  startAI();
}

// ══════════════════════════════════════════
// HEALTH MONITOR
// ══════════════════════════════════════════
function onHealth() {
  const hp = bot.health, food = bot.food;
  console.log(`[HP:${hp.toFixed(0)} Food:${food} State:${state}]`);
  if (food <= 8 && ![S.SHELTER, S.EAT].includes(state) && hasFood()) eatFood();
  if (hp <= HP_SHELTER && state !== S.SHELTER) { setState(S.SHELTER); buildShelter(); return; }
  if (hp <= HP_FLEE    && ![S.FLEE,S.SHELTER].includes(state)) { setState(S.FLEE); flee(); }
  if (hp >= HP_SAFE    && state === S.FLEE) setState(S.IDLE);
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
        case S.IDLE:   await idleTick();  break;
        case S.COMBAT: combatTick();      break;
        case S.HUNT:   await huntTick();  break;
        case S.WOOD:   await woodTick();  break;
        case S.STONE:  await stoneTick(); break;
        case S.CRAFT:  await craftTick(); break;
        case S.COOK:   await cookTick();  break;
      }
    } catch(e) { console.log('[TICK ERROR]', e.message); busy = false; }
  }, 1000);

  lookLoop = setInterval(() => {
    if (state === S.IDLE && bot?.entity)
      bot.look((Math.random()*2-1)*Math.PI, (Math.random()-0.5)*(Math.PI/3), true);
  }, 3000);
}

// ══════════════════════════════════════════
// IDLE — PRIORITY SYSTEM
// ══════════════════════════════════════════
async function idleTick() {
  // P1: Hostile nearby (10 block range)
  const mob = nearbyEntity(HOSTILE, MOB_DETECT);
  if (mob) { target = mob; setState(S.COMBAT); return; }

  // P2: Eat if hungry
  if (bot.food <= 14 && hasFood()) { await eatFood(); return; }

  // P3: Cook raw food
  if (hasRawFood() && (hasFurnaceNearby() || hasItem('furnace'))) { setState(S.COOK); return; }

  // P4: Always hunt animals to stock food
  if (foodCount() < FOOD_GOAL) {
    const animal = nearbyEntity(ANIMALS, 24);
    if (animal) { target = animal; setState(S.HUNT); return; }
  }

  // P5: Need tools — gather wood or craft
  if (needsCrafting()) {
    const wood = countItems(LOGS)*4 + countItems(PLANKS);
    setState(wood >= 12 ? S.CRAFT : S.WOOD);
    return;
  }

  // P6: Upgrade to stone tools
  const hasStoneToolsAlready = hasItem([
    'stone_sword','stone_pickaxe','stone_axe',
    'iron_sword','iron_pickaxe','iron_axe',
    'diamond_sword','diamond_pickaxe','diamond_axe',
    'netherite_sword','netherite_pickaxe','netherite_axe'
  ]);
  if (!hasStoneToolsAlready && hasItem(PICK_P)) {
    setState(countItems(COBBLE) >= 8 ? S.CRAFT : S.STONE);
    return;
  }

  // P7: Stock up on wood
  if (countItems(LOGS) < 16 && findNearBlock(LOGS, 32)) { setState(S.WOOD); return; }

  // P8: Wander
  if (Math.random() < 0.25) wander();
  if (Math.random() < 0.06) doJump();
  if (Math.random() < 0.04) bot.swingArm();
}

// ══════════════════════════════════════════
// COMBAT — 10 block detection, best sword
// ══════════════════════════════════════════
function combatTick() {
  if (!target?.isValid) { target = null; setState(S.IDLE); return; }
  if (bot.health <= HP_FLEE) { bot.pathfinder.setGoal(null); setState(S.FLEE); flee(); return; }

  equipBest(SWORD_P);

  const dist = bot.entity.position.distanceTo(target.position);
  if (dist > ATK_DIST) {
    bot.pathfinder.setGoal(
      new GoalNear(target.position.x, target.position.y, target.position.z, 2)
    );
  } else {
    bot.pathfinder.setGoal(null);
    bot.lookAt(target.position.offset(0, target.height * 0.9, 0));
    bot.attack(target);
    // Crit hit: jump while attacking
    if (bot.entity.onGround && Math.random() > 0.4) doJump();
  }

  // Re-target closest threat
  const closest = nearbyEntity(HOSTILE, MOB_DETECT);
  if (closest && closest !== target) {
    const d1 = bot.entity.position.distanceTo(closest.position);
    const d2 = bot.entity.position.distanceTo(target.position);
    if (d1 < d2) target = closest;
  }
}

// ══════════════════════════════════════════
// HUNT — always kills animals for food stock
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
    bot.pathfinder.setGoal(
      new GoalNear(target.position.x, target.position.y, target.position.z, 2)
    );
  } else {
    bot.pathfinder.setGoal(null);
    bot.lookAt(target.position.offset(0, target.height * 0.9, 0));
    bot.attack(target);
  }
}

// ══════════════════════════════════════════
// GATHER WOOD — equips axe
// ══════════════════════════════════════════
async function woodTick() {
  if (busy) return; busy = true;
  const mob = nearbyEntity(HOSTILE, MOB_DETECT);
  if (mob) { busy = false; target = mob; setState(S.COMBAT); return; }
  if (countItems(LOGS) >= 16) { busy = false; setState(S.CRAFT); return; }

  const logBlock = findNearBlock(LOGS, 32);
  if (!logBlock) { busy = false; setState(S.IDLE); return; }

  try {
    equipBest(AXE_P);
    await bot.pathfinder.goto(
      new GoalNear(logBlock.position.x, logBlock.position.y, logBlock.position.z, 2)
    );
    await bot.lookAt(logBlock.position.offset(0.5, 0.5, 0.5));
    const fresh = bot.blockAt(logBlock.position);
    if (fresh && LOGS.includes(fresh.name)) {
      await bot.dig(fresh);
      console.log('[WOOD] Chopped', fresh.name);
    }
  } catch(e) { console.log('[WOOD ERROR]', e.message); }
  busy = false;
}

// ══════════════════════════════════════════
// GATHER STONE — equips pickaxe
// ══════════════════════════════════════════
async function stoneTick() {
  if (busy) return; busy = true;
  const mob = nearbyEntity(HOSTILE, MOB_DETECT);
  if (mob) { busy = false; target = mob; setState(S.COMBAT); return; }
  if (countItems(COBBLE) >= 16) { busy = false; setState(S.CRAFT); return; }
  if (!equipBest(PICK_P)) { busy = false; setState(S.CRAFT); return; }

  const stoneBlock = findNearBlock(STONE, 24);
  if (!stoneBlock) { busy = false; setState(S.IDLE); return; }

  try {
    await bot.pathfinder.goto(
      new GoalNear(stoneBlock.position.x, stoneBlock.position.y, stoneBlock.position.z, 2)
    );
    await bot.lookAt(stoneBlock.position.offset(0.5, 0.5, 0.5));
    const fresh = bot.blockAt(stoneBlock.position);
    if (fresh && STONE.includes(fresh.name)) {
      await bot.dig(fresh);
      console.log('[STONE] Mined', fresh.name);
    }
  } catch(e) { console.log('[STONE ERROR]', e.message); }
  busy = false;
}

// ══════════════════════════════════════════
// CRAFT — table, tools, furnace
// ══════════════════════════════════════════
async function craftTick() {
  if (busy) return; busy = true;
  console.log('[CRAFT] Starting...');
  try {
    // 1. Convert logs → planks (no table needed)
    for (const log of bot.inventory.items().filter(i => LOGS.includes(i.name))) {
      const plankName = log.name.replace('_log', '_planks');
      const pd = mcData.itemsByName[plankName];
      if (pd) {
        const r = bot.recipesFor(pd.id, null, 1, null);
        if (r.length) await bot.craft(r[0], log.count, null);
      }
    }

    // 2. Get or place crafting table
    let table = findNearBlock(['crafting_table'], 8);
    if (!table) {
      if (!hasItem('crafting_table')) await make('crafting_table', 1, null);
      if (hasItem('crafting_table')) {
        await placeBlockNear('crafting_table');
        await bot.waitForTicks(10);
        table = findNearBlock(['crafting_table'], 8);
      }
    }
    if (table) {
      await bot.pathfinder.goto(
        new GoalNear(table.position.x, table.position.y, table.position.z, 2)
      );
    }

    // 3. Craft sticks
    await make('stick', 4, table);

    const cobble = countItems(COBBLE);
    const planks = countItems(PLANKS);

    // 4. Pickaxe first (needed to mine stone)
    if (!hasItem(PICK_P)) {
      if (cobble >= 3) await make('stone_pickaxe', 1, table);
      else if (planks >= 3) await make('wooden_pickaxe', 1, table);
    }

    // 5. Sword
    if (!hasItem(SWORD_P)) {
      if (cobble >= 2) await make('stone_sword', 1, table);
      else if (planks >= 2) await make('wooden_sword', 1, table);
    }

    // 6. Axe
    if (!hasItem(AXE_P)) {
      if (cobble >= 3) await make('stone_axe', 1, table);
      else if (planks >= 3) await make('wooden_axe', 1, table);
    }

    // 7. Furnace (8 cobblestone)
    if (!hasItem('furnace') && !hasFurnaceNearby() && cobble >= 8) {
      await make('furnace', 1, table);
    }

    // 8. Upgrade wooden → stone tools if cobble available now
    const c2 = countItems(COBBLE);
    if (c2 >= 2 && hasItem(['wooden_sword']) &&
        !hasItem(['stone_sword','iron_sword','diamond_sword','netherite_sword'])) {
      await make('stone_sword', 1, table);
    }
    if (c2 >= 3 && hasItem(['wooden_pickaxe']) &&
        !hasItem(['stone_pickaxe','iron_pickaxe','diamond_pickaxe','netherite_pickaxe'])) {
      await make('stone_pickaxe', 1, table);
    }
    if (c2 >= 3 && hasItem(['wooden_axe']) &&
        !hasItem(['stone_axe','iron_axe','diamond_axe','netherite_axe'])) {
      await make('stone_axe', 1, table);
    }

    console.log('[CRAFT] Done!');
  } catch(e) { console.log('[CRAFT ERROR]', e.message); }
  busy = false;
  setState(S.IDLE);
}

// ══════════════════════════════════════════
// COOK — place furnace, smelt raw food
// ══════════════════════════════════════════
async function cookTick() {
  if (busy) return; busy = true;
  try {
    let furnaceBlock = findNearBlock(['furnace','lit_furnace'], 16);
    if (!furnaceBlock) {
      if (!hasItem('furnace')) { busy = false; setState(S.IDLE); return; }
      await placeBlockNear('furnace');
      await bot.waitForTicks(10);
      furnaceBlock = findNearBlock(['furnace'], 8);
    }
    if (!furnaceBlock) { busy = false; setState(S.IDLE); return; }

    await bot.pathfinder.goto(
      new GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2)
    );

    const furnace = await bot.openFurnace(furnaceBlock);

    // Put raw food in input slot
    const rawItem = bot.inventory.items().find(i => RAW_LIST.includes(i.name));
    if (rawItem) await furnace.putInput(rawItem.type, null, rawItem.count);

    // Put fuel (prefer coal, then planks/logs)
    const fuelItem = bot.inventory.items().find(i =>
      ['coal','charcoal'].includes(i.name) ||
      PLANKS.includes(i.name) ||
      LOGS.includes(i.name)
    );
    if (fuelItem) await furnace.putFuel(fuelItem.type, null, Math.min(fuelItem.count, 8));

    console.log('[COOK] Smelting...');

    // Wait for output (up to 90 seconds)
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 90000);
      furnace.once('update', () => { clearTimeout(timeout); setTimeout(resolve, 500); });
    });

    try { await furnace.takeOutput(); } catch {}
    furnace.close();
    console.log('[COOK] Done!');
  } catch(e) { console.log('[COOK ERROR]', e.message); }
  busy = false;
  setState(S.IDLE);
}

// ══════════════════════════════════════════
// FLEE
// ══════════════════════════════════════════
function flee() {
  bot.pathfinder.setGoal(null); stopMovement();
  console.log('[BOT] FLEE!');
  const mob = nearbyEntity(HOSTILE, 20);
  if (!mob) { setState(S.IDLE); return; }
  const p = bot.entity.position, t = mob.position;
  const dx = p.x-t.x, dz = p.z-t.z, len = Math.sqrt(dx*dx+dz*dz)||1;
  bot.pathfinder.setGoal(new GoalNear(p.x+dx/len*25, p.y, p.z+dz/len*25, 2));
  const ck = setInterval(() => {
    if (!bot || state !== S.FLEE) { clearInterval(ck); return; }
    if (bot.health <= HP_SHELTER) {
      clearInterval(ck); bot.pathfinder.setGoal(null); setState(S.SHELTER); buildShelter(); return;
    }
    if (!nearbyEntity(HOSTILE, 10) && bot.health >= HP_SAFE) {
      clearInterval(ck); bot.pathfinder.setGoal(null); setState(S.IDLE);
    }
  }, 2000);
}

// ══════════════════════════════════════════
// SHELTER
// ══════════════════════════════════════════
async function buildShelter() {
  bot.pathfinder.setGoal(null); stopMovement(); bot.setControlState('sneak', true);
  console.log('[BOT] CRITICAL HP – building shelter!');
  const blockItem = bot.inventory.items().find(i =>
    ['dirt','cobblestone','sand','gravel','oak_planks','spruce_planks'].includes(i.name)
  );
  if (blockItem?.count >= 3) {
    try {
      await bot.equip(blockItem, 'hand');
      const pos = bot.entity.position.floored();
      for (const s of [new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1)]) {
        try {
          const ground = bot.blockAt(pos.plus(s).offset(0,-1,0));
          if (ground && !['air','cave_air'].includes(ground.name)) {
            await bot.placeBlock(ground, new Vec3(0,1,0));
            await bot.waitForTicks(3);
          }
        } catch {}
      }
    } catch(e) { console.log('[SHELTER ERROR]', e.message); }
  }
  if (hasFood()) await eatFood();
  waitUntilSafe();
}
function waitUntilSafe() {
  const ck = setInterval(() => {
    if (!bot || state !== S.SHELTER) { clearInterval(ck); return; }
    if (bot.food < 16 && hasFood()) eatFood();
    if (!nearbyEntity(HOSTILE, 12) && bot.health >= HP_SAFE) {
      clearInterval(ck);
      bot.setControlState('sneak', false);
      console.log('[BOT] Safe – resuming');
      setState(S.IDLE);
    }
  }, 3000);
}

// ══════════════════════════════════════════
// EAT — prefers cooked food
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
    console.log('[EAT]', food.name, '→ Food:', bot.food);
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
  if (!r.length) { console.log('[CRAFT] No recipe:', name, '(table:', !!table, ')'); return false; }
  try { await bot.craft(r[0], count, table); console.log('[CRAFT] ✅', count+'x', name); return true; }
  catch(e) { console.log('[CRAFT] ❌', name+':', e.message); return false; }
}

async function placeBlockNear(itemName) {
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) return;
  const pos = bot.entity.position.floored();
  for (const off of [new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1)]) {
    const air = bot.blockAt(pos.plus(off));
    if (air?.name === 'air') {
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

function foodCount() {
  return bot.inventory.items().filter(i => FOOD_SET.has(i.name)).reduce((sum, i) => sum + i.count, 0);
}

function hasFood()        { return bot.inventory.items().some(i => FOOD_SET.has(i.name)); }
function hasRawFood()     { return bot.inventory.items().some(i => RAW_LIST.includes(i.name)); }
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
    .forEach(c => bot.setControlState(c, false));
}

function setState(s) {
  if (state !== s) console.log(`[STATE] ${state} → ${s}`);
  state = s;
}

function cleanup() {
  clearInterval(mainLoop); clearInterval(lookLoop);
  busy = false;
  if (bot?.entity) stopMovement();
}

createBot();
