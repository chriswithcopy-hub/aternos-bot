const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalGetToBlock } = goals;
const { Vec3 } = require('vec3');

const config = {
  host:     process.env.SERVER_HOST || 'tiktokbuddies.aternos.me',
  port:     parseInt(process.env.SERVER_PORT) || 64617,
  username: process.env.BOT_USERNAME || 'AFKBot',
  version:  '1.21.1'
};

const REG_PASSWORD = process.env.REG_PASSWORD || 'BotPass1234';

// HP thresholds (max HP = 20)
const HP = {
  FLEE:    10,  
  SHELTER: 6,   
  SAFE:    16   
};

const HOSTILE_MOBS = new Set([
  'zombie','skeleton','creeper','spider','cave_spider','enderman',
  'witch','pillager','vindicator','ravager','phantom','drowned',
  'husk','stray','blaze','ghast','magma_cube','slime','silverfish',
  'endermite','guardian','elder_guardian','shulker','zombie_villager',
  'warden','zombified_piglin','hoglin','zoglin','bogged','breeze'
]);

const FOOD_ANIMALS = new Set([
  'cow','pig','sheep','chicken','rabbit','mooshroom'
]);

const FOOD_ITEMS = new Set([
  'cooked_beef','cooked_porkchop','cooked_chicken','cooked_mutton',
  'cooked_rabbit','cooked_salmon','cooked_cod','bread','apple',
  'golden_apple','enchanted_golden_apple','carrot','baked_potato',
  'beef','porkchop','chicken','mutton','salmon','cod',
  'melon_slice','sweet_berries','dried_kelp','mushroom_stew',
  'rabbit_stew','pumpkin_pie','golden_carrot','chorus_fruit'
]);

const STATE = {
  IDLE:       'idle',
  COMBAT:     'combat',
  FLEEING:    'fleeing',
  SHELTERING: 'sheltering',
  EATING:     'eating',
  HUNTING:    'hunting',
  GATHERING:  'gathering',
  CRAFTING:   'crafting'
};

let bot;
let mcData;
let state      = STATE.IDLE;
let registered = false;
let target     = null;
let mainTick;
let lookTick;
let isWorking  = false; // Prevents overlapping async tasks (mining, crafting)

// ─────────────────────────────────────────────
function createBot() {
  state      = STATE.IDLE;
  registered = false;
  target     = null;
  isWorking  = false;

  bot = mineflayer.createBot(config);
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    console.log('[BOT] Spawned');
    mcData = require('minecraft-data')(bot.version);
    bot.pathfinder.setMovements(new Movements(bot));
    setTimeout(() => { if (!registered) tryRegister(); }, 2000);
  });

  bot.on('message', (jsonMsg) => {
    const msg = jsonMsg.toString().toLowerCase();
    if (msg.includes('register') && !msg.includes('registered') && !registered) tryRegister();
    if ((msg.includes('login') || msg.includes('log in')) && !registered) tryLogin();
    if (!registered && (
      msg.includes('successfully') || msg.includes('logged in') ||
      msg.includes('welcome')      || msg.includes('registered')
    )) {
      registered = true;
      console.log('[BOT] Auth done — starting AI');
      startAI();
    }
  });

  bot.on('health', () => {
    if (!registered) return;
    handleHealth();
  });

  bot.on('kicked',  (r) => { console.log('[BOT] Kicked:', r);       cleanup(); setTimeout(createBot, 10000); });
  bot.on('error',   (e) => { console.log('[BOT] Error:', e.message); cleanup(); setTimeout(createBot, 10000); });
  bot.on('end',     ()  => { console.log('[BOT] Disconnected');      cleanup(); setTimeout(createBot, 10000); });
}

// ── AUTH ─────────────────────────────────────
function tryRegister() {
  bot.chat(`/register ${REG_PASSWORD} ${REG_PASSWORD}`);
  setTimeout(() => { if (!registered) { registered = true; startAI(); } }, 5000);
}
function tryLogin() {
  bot.chat(`/login ${REG_PASSWORD}`);
}

// ── HEALTH HANDLER ───────────────────────────
function handleHealth() {
  const hp = bot.health;

  if (bot.food <= 8 && state !== STATE.SHELTERING) eatFood();

  if (hp <= HP.SHELTER && state !== STATE.SHELTERING && state !== STATE.CRAFTING) {
    setState(STATE.SHELTERING);
    buildShelter();
    return;
  }

  if (hp <= HP.FLEE && state !== STATE.FLEEING && state !== STATE.SHELTERING && state !== STATE.CRAFTING) {
    setState(STATE.FLEEING);
    flee();
    return;
  }

  if (hp >= HP.SAFE && state === STATE.FLEEING) setState(STATE.IDLE);
}

// ── AI LOOP ──────────────────────────────────
function startAI() {
  clearInterval(mainTick);
  clearInterval(lookTick);

  bot.lastAttackTime = 0;
  bot.skipGatherUntil = 0;

  mainTick = setInterval(() => {
    if (!bot?.entity || isWorking) return;
    switch (state) {
      case STATE.IDLE:       idleTick();      break;
      case STATE.COMBAT:     combatTick();    break;
      case STATE.HUNTING:    huntTick();      break;
      case STATE.GATHERING:  gatherTick();    break;
      case STATE.CRAFTING:   craftingTick();  break;
    }
  }, 1000);

  lookTick = setInterval(() => {
    if (state === STATE.IDLE && bot?.entity && !isWorking) {
      bot.look((Math.random() * 2 - 1) * Math.PI, (Math.random() - 0.5) * (Math.PI / 3), true);
    }
  }, 3000);
}

// ── IDLE ─────────────────────────────────────
function idleTick() {
  // 1. Hostile mob nearby → fight
  const hostile = getNearestEntity(HOSTILE_MOBS, 16);
  if (hostile) { target = hostile; setState(STATE.COMBAT); return; }

  // 2. Need Tools → gather wood or craft
  const hasWeapon = bot.inventory.items().some(i => i.name.includes('sword') || i.name.includes('axe'));
  if (!hasWeapon && Date.now() > bot.skipGatherUntil) {
    const hasMaterials = bot.inventory.items().some(i => i.name.includes('log') || i.name.includes('planks'));
    if (hasMaterials) {
      setState(STATE.CRAFTING);
    } else {
      setState(STATE.GATHERING);
    }
    return;
  }

  // 3. Hungry → hunt or eat
  if (bot.food < 15) {
    if (hasFood()) { eatFood(); return; }
    const animal = getNearestEntity(FOOD_ANIMALS, 20);
    if (animal) { target = animal; setState(STATE.HUNTING); return; }
  }

  // 4. Random wander
  if (Math.random() < 0.25) randomWalk();
  if (Math.random() < 0.08) {
    bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), 300);
  }
}

// ── COMBAT (ADVANCED) ────────────────────────
async function combatTick() {
  if (!target?.isValid) { target = null; setState(STATE.IDLE); return; }

  if (bot.health <= HP.FLEE) {
    bot.pathfinder.setGoal(null);
    target = null;
    setState(STATE.FLEEING);
    flee();
    return;
  }

  // Equip best weapon automatically
  await equipBestWeapon();

  const dist = bot.entity.position.distanceTo(target.position);

  if (dist > 3.0) {
    bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 2));
    bot.setControlState('back', false);
    bot.setControlState('jump', false);
  } else {
    // Stop pathfinding, aim directly
    bot.pathfinder.setGoal(null);
    bot.lookAt(target.position.offset(0, target.height * 0.9, 0));

    const now = Date.now();
    // Enforce an attack cooldown so we don't spam and ruin the critical jump rhythm
    if (now - bot.lastAttackTime > 700) {
      if (bot.entity.onGround) {
        // 1. Jump for critical hit
        bot.setControlState('jump', true);
        // 2. Start moving backwards to kite
        bot.setControlState('back', true); 

        // 3. Attack when falling back down (approx 300ms after jump)
        setTimeout(() => {
          if (target?.isValid) {
            bot.attack(target);
            bot.lastAttackTime = Date.now();
          }
          bot.setControlState('jump', false);
        }, 300);

        // 4. Stop moving backward after landing
        setTimeout(() => {
          bot.setControlState('back', false);
        }, 700);
      }
    }
  }

  // Switch target if closer hostile appears
  const closer = getNearestEntity(HOSTILE_MOBS, 16);
  if (closer && closer !== target) {
    if (bot.entity.position.distanceTo(closer.position) < bot.entity.position.distanceTo(target.position)) {
      target = closer;
    }
  }
}

// ── HUNTING ──────────────────────────────────
function huntTick() {
  if (bot.food >= 17) { bot.pathfinder.setGoal(null); target = null; setState(STATE.IDLE); return; }

  const hostile = getNearestEntity(HOSTILE_MOBS, 10);
  if (hostile) { bot.pathfinder.setGoal(null); target = hostile; setState(STATE.COMBAT); return; }

  if (!target?.isValid) {
    const animal = getNearestEntity(FOOD_ANIMALS, 20);
    if (animal) target = animal;
    else {
      if (hasFood()) eatFood();
      setState(STATE.IDLE);
      return;
    }
  }

  equipBestWeapon(); // Equip sword/axe to kill animals faster

  const dist = bot.entity.position.distanceTo(target.position);
  if (dist > 3) {
    bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 2));
  } else {
    bot.pathfinder.setGoal(null);
    bot.lookAt(target.position.offset(0, target.height * 0.9, 0));
    if (Date.now() - bot.lastAttackTime > 600) {
      bot.attack(target);
      bot.lastAttackTime = Date.now();
    }
  }
}

// ── GATHERING WOOD ───────────────────────────
async function gatherTick() {
  if (isWorking) return;
  isWorking = true;

  const log = bot.findBlock({ matching: b => b.name.includes('log'), maxDistance: 32 });
  
  if (!log) {
    console.log('[BOT] No logs nearby, pausing gathering.');
    bot.skipGatherUntil = Date.now() + 15000; // Wait 15 seconds before trying again
    isWorking = false;
    setState(STATE.IDLE);
    return;
  }

  try {
    const dist = bot.entity.position.distanceTo(log.position);
    if (dist > 4) {
      bot.pathfinder.setGoal(new GoalGetToBlock(log.position.x, log.position.y, log.position.z));
      isWorking = false; // allow pathfinder to tick
    } else {
      bot.pathfinder.setGoal(null);
      await bot.lookAt(log.position);
      
      // Equip axe if we have one
      const axe = bot.inventory.items().find(i => i.name.includes('axe'));
      if (axe) await bot.equip(axe, 'hand');
      
      await bot.dig(log);
      console.log(`[BOT] Mined ${log.name}`);
      isWorking = false;
    }
  } catch (err) {
    console.log('[BOT] Gather error:', err.message);
    isWorking = false;
  }
}

// ── CRAFTING ─────────────────────────────────
async function craftingTick() {
  if (isWorking) return;
  isWorking = true;
  bot.pathfinder.setGoal(null);
  console.log('[BOT] Starting auto-crafting sequence...');

  const count = (nameStr) => bot.inventory.items().filter(i => i.name.includes(nameStr)).reduce((a, b) => a + b.count, 0);

  try {
    // 1. Logs -> Planks
    if (count('log') > 0 && count('planks') < 8) {
      const logItem = bot.inventory.items().find(i => i.name.includes('log'));
      if (logItem) {
        const woodType = logItem.name.split('_')[0];
        const plankItem = mcData.itemsByName[`${woodType}_planks`] || mcData.itemsByName['oak_planks'];
        if (plankItem) {
          const recipe = bot.recipesFor(plankItem.id, null, 1, null)[0];
          if (recipe) await bot.craft(recipe, 1, null);
        }
      }
    }

    // 2. Planks -> Sticks
    if (count('planks') >= 2 && count('stick') < 4) {
      const stickId = mcData.itemsByName['stick'].id;
      const recipe = bot.recipesFor(stickId, null, 1, null)[0];
      if (recipe) await bot.craft(recipe, 1, null);
    }

    // 3. Planks -> Crafting Table
    if (count('planks') >= 4 && count('crafting_table') === 0) {
      const tableId = mcData.itemsByName['crafting_table'].id;
      const recipe = bot.recipesFor(tableId, null, 1, null)[0];
      if (recipe) await bot.craft(recipe, 1, null);
    }

    // 4. Place Table & Craft Tools
    if (count('crafting_table') > 0 && count('stick') > 0 && count('planks') >= 2) {
      const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
      await bot.equip(tableItem, 'hand');
      
      // Find a safe ground block to place the table on
      const pos = bot.entity.position.floored();
      const refBlock = bot.blockAt(pos.offset(1, -1, 0)) || bot.blockAt(pos.offset(0, -1, 1)); 
      
      if (refBlock && !['air', 'cave_air', 'water', 'lava'].includes(refBlock.name)) {
        await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
        await bot.waitForTicks(5);
        
        // Find the placed table
        const tableBlock = bot.findBlock({ matching: mcData.blocksByName['crafting_table'].id, maxDistance: 4 });
        
        if (tableBlock) {
          // Craft Axe
          if (count('axe') === 0) {
            const axeId = mcData.itemsByName['wooden_axe'].id;
            const recipe = bot.recipesFor(axeId, null, 1, tableBlock)[0];
            if (recipe) await bot.craft(recipe, 1, tableBlock);
          }
          // Craft Sword
          if (count('sword') === 0) {
            const swordId = mcData.itemsByName['wooden_sword'].id;
            const recipe = bot.recipesFor(swordId, null, 1, tableBlock)[0];
            if (recipe) await bot.craft(recipe, 1, tableBlock);
          }

          // Break the table to take it with us
          const bestTool = bot.inventory.items().find(i => i.name.includes('axe'));
          if (bestTool) await bot.equip(bestTool, 'hand');
          await bot.dig(tableBlock);
        }
      }
    }
  } catch (err) {
    console.log('[BOT] Crafting failed/interrupted:', err.message);
  }

  isWorking = false;
  setState(STATE.IDLE);
}

// ── FLEE (UPDATED) ───────────────────────────
function flee() {
  bot.pathfinder.setGoal(null);
  stopMovement();
  console.log('[BOT] FLEEING!');

  const check = setInterval(() => {
    if (!bot || state !== STATE.FLEEING) { clearInterval(check); return; }

    if (bot.health <= HP.SHELTER) {
      clearInterval(check);
      bot.pathfinder.setGoal(null);
      setState(STATE.SHELTERING);
      buildShelter();
      return;
    }

    const threat = getNearestEntity(HOSTILE_MOBS, 20);

    if (!threat && bot.health >= HP.SAFE) {
      clearInterval(check);
      bot.pathfinder.setGoal(null);
      console.log('[BOT] Safe! Resuming');
      setState(STATE.IDLE);
      return;
    }

    if (threat) {
      const pos = bot.entity.position;
      const tp  = threat.position;
      const dx  = pos.x - tp.x;
      const dz  = pos.z - tp.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;

      bot.pathfinder.setGoal(
        new GoalNear(pos.x + (dx / len) * 20, pos.y, pos.z + (dz / len) * 20, 2)
      );
    } else {
      bot.pathfinder.setGoal(null);
      if (bot.food < 20 && hasFood()) eatFood();
    }
  }, 2000);
}

// ── SHELTER ──────────────────────────────────
async function buildShelter() {
  bot.pathfinder.setGoal(null);
  stopMovement();
  bot.setControlState('sneak', true);
  console.log('[BOT] CRITICAL HP — building shelter!');

  const blockItem = bot.inventory.items().find(i =>
    ['dirt','cobblestone','stone','sand','gravel',
     'oak_planks','spruce_planks','cobbled_deepslate'].includes(i.name)
  );

  if (blockItem && blockItem.count >= 3) {
    try {
      await bot.equip(blockItem, 'hand');
      const pos   = bot.entity.position.floored();
      const sides = [
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1)
      ];
      for (const side of sides) {
        try {
          const groundBlock = bot.blockAt(pos.plus(side).offset(0, -1, 0));
          if (groundBlock && !['air','cave_air'].includes(groundBlock.name)) {
            await bot.placeBlock(groundBlock, new Vec3(0, 1, 0));
            await bot.waitForTicks(3);
          }
        } catch (e) { /* can't place there, skip */ }
      }
      console.log('[BOT] Shelter built!');
    } catch (e) {
      console.log('[BOT] Shelter build error:', e.message);
    }
  }

  if (hasFood()) await eatFood();
  waitForSafety();
}

function waitForSafety() {
  const check = setInterval(() => {
    if (!bot || state !== STATE.SHELTERING) { clearInterval(check); return; }

    if (bot.food < 16 && hasFood()) eatFood();

    const noThreat = !getNearestEntity(HOSTILE_MOBS, 12);
    const hpGood   = bot.health >= HP.SAFE;

    if (noThreat && hpGood) {
      clearInterval(check);
      bot.setControlState('sneak', false);
      setState(STATE.IDLE);
    }
  }, 3000);
}

// ── EAT ──────────────────────────────────────
async function eatFood() {
  if (state === STATE.EATING || isWorking) return;
  const food = bot.inventory.items().find(i => FOOD_ITEMS.has(i.name));
  if (!food) return;
  const prevState = state;
  try {
    setState(STATE.EATING);
    isWorking = true;
    await bot.equip(food, 'hand');
    await bot.consume();
    console.log(`[BOT] Ate ${food.name} — Food: ${bot.food}`);
  } catch (e) {
    console.log('[BOT] Eat error:', e.message);
  } finally {
    isWorking = false;
    setState(prevState === STATE.EATING ? STATE.IDLE : prevState);
  }
}

// ── HELPERS ──────────────────────────────────
async function equipBestWeapon() {
  const weapons = bot.inventory.items().filter(i => i.name.includes('sword') || i.name.includes('axe'));
  if (weapons.length === 0) return;

  // Simple sorting logic to prefer swords over axes, and higher tier over lower tier
  weapons.sort((a, b) => {
    const getScore = (name) => {
      let score = 0;
      if (name.includes('sword')) score += 10;
      if (name.includes('axe'))   score += 5;
      if (name.includes('diamond')) score += 40;
      if (name.includes('iron'))    score += 30;
      if (name.includes('stone'))   score += 20;
      if (name.includes('wooden'))  score += 10;
      return score;
    };
    return getScore(b.name) - getScore(a.name);
  });

  if (bot.heldItem?.name !== weapons[0].name) {
    await bot.equip(weapons[0], 'hand');
  }
}

function getNearestEntity(nameSet, maxDist) {
  return Object.values(bot.entities)
    .filter(e =>
      e !== bot.entity &&
      nameSet.has(e.name) &&
      e.isValid &&
      bot.entity.position.distanceTo(e.position) <= maxDist
    )
    .sort((a, b) =>
      bot.entity.position.distanceTo(a.position) -
      bot.entity.position.distanceTo(b.position)
    )[0] || null;
}

function hasFood() {
  return bot.inventory.items().some(i => FOOD_ITEMS.has(i.name));
}

function randomWalk() {
  const dirs = ['forward','back','left','right'];
  const dir  = dirs[Math.floor(Math.random() * dirs.length)];
  bot.setControlState(dir, true);
  setTimeout(() => bot.setControlState(dir, false), 1000 + Math.random() * 2000);
}

function stopMovement() {
  ['forward','back','left','right','jump','sneak','sprint']
    .forEach(c => bot.setControlState(c, false));
}

function setState(s) {
  if (state !== s) console.log(`[BOT] ${state} → ${s}`);
  state = s;
}

function cleanup() {
  clearInterval(mainTick);
  clearInterval(lookTick);
  isWorking = false;
  if (bot?.entity) stopMovement();
}

createBot();
