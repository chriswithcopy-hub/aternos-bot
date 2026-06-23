const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
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
  FLEE:    10,  // 5 hearts → run away
  SHELTER: 6,   // 3 hearts → build dirt shelter
  SAFE:    16   // 8 hearts → safe to come back out
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
  HUNTING:    'hunting'
};

let bot;
let state      = STATE.IDLE;
let registered = false;
let target     = null;
let mainTick;
let lookTick;

// ─────────────────────────────────────────────
function createBot() {
  state      = STATE.IDLE;
  registered = false;
  target     = null;

  bot = mineflayer.createBot(config);
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    console.log('[BOT] Spawned');
    bot.pathfinder.setMovements(new Movements(bot));
    setTimeout(() => { if (!registered) tryRegister(); }, 2000);
  });

  bot.on('message', (jsonMsg) => {
    const msg = jsonMsg.toString().toLowerCase();
    console.log('[SERVER]', msg);
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
  console.log('[BOT] Sending /register...');
  bot.chat(`/register ${REG_PASSWORD} ${REG_PASSWORD}`);
  setTimeout(() => { if (!registered) { registered = true; startAI(); } }, 5000);
}
function tryLogin() {
  console.log('[BOT] Sending /login...');
  bot.chat(`/login ${REG_PASSWORD}`);
}

// ── HEALTH HANDLER ───────────────────────────
function handleHealth() {
  const hp = bot.health;
  console.log(`[HP: ${hp}] [Food: ${bot.food}] [State: ${state}]`);

  // Eat if starving
  if (bot.food <= 8 && state !== STATE.SHELTERING) eatFood();

  // Critical HP → shelter
  if (hp <= HP.SHELTER && state !== STATE.SHELTERING) {
    setState(STATE.SHELTERING);
    buildShelter();
    return;
  }

  // Low HP → flee
  if (hp <= HP.FLEE && state !== STATE.FLEEING && state !== STATE.SHELTERING) {
    setState(STATE.FLEEING);
    flee();
    return;
  }

  // Recovered → back to idle
  if (hp >= HP.SAFE && state === STATE.FLEEING) setState(STATE.IDLE);
}

// ── AI LOOP ──────────────────────────────────
function startAI() {
  clearInterval(mainTick);
  clearInterval(lookTick);

  mainTick = setInterval(() => {
    if (!bot?.entity) return;
    switch (state) {
      case STATE.IDLE:    idleTick();   break;
      case STATE.COMBAT:  combatTick(); break;
      case STATE.HUNTING: huntTick();   break;
    }
  }, 1000);

  // Look around while idle
  lookTick = setInterval(() => {
    if (state === STATE.IDLE && bot?.entity) {
      bot.look(
        (Math.random() * 2 - 1) * Math.PI,
        (Math.random() - 0.5) * (Math.PI / 3),
        true
      );
    }
  }, 3000);
}

// ── IDLE ─────────────────────────────────────
function idleTick() {
  // Hostile mob nearby → fight
  const hostile = getNearestEntity(HOSTILE_MOBS, 16);
  if (hostile) { target = hostile; setState(STATE.COMBAT); return; }

  // Hungry → hunt or eat
  if (bot.food < 15) {
    if (hasFood()) { eatFood(); return; }
    const animal = getNearestEntity(FOOD_ANIMALS, 20);
    if (animal) { target = animal; setState(STATE.HUNTING); return; }
  }

  // Random wander
  if (Math.random() < 0.25) randomWalk();
  // Random jump
  if (Math.random() < 0.08) {
    bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), 300);
  }
  // Swing arm
  if (Math.random() < 0.05) bot.swingArm();
}

// ── COMBAT ───────────────────────────────────
function combatTick() {
  // Target gone → idle
  if (!target?.isValid) { target = null; setState(STATE.IDLE); return; }

  // Too hurt → flee
  if (bot.health <= HP.FLEE) {
    bot.pathfinder.setGoal(null);
    target = null;
    setState(STATE.FLEEING);
    flee();
    return;
  }

  const dist = bot.entity.position.distanceTo(target.position);

  if (dist > 3) {
    // Chase the target
    bot.pathfinder.setGoal(
      new GoalNear(target.position.x, target.position.y, target.position.z, 2)
    );
  } else {
    // Close enough — attack
    bot.pathfinder.setGoal(null);
    bot.lookAt(target.position.offset(0, target.height * 0.9, 0));
    bot.attack(target);
    // Crit hit: jump while attacking
    if (bot.entity.onGround && Math.random() > 0.4) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 250);
    }
  }

  // Switch target if closer hostile appears
  const closer = getNearestEntity(HOSTILE_MOBS, 16);
  if (closer && closer !== target) {
    const d1 = bot.entity.position.distanceTo(closer.position);
    const d2 = bot.entity.position.distanceTo(target.position);
    if (d1 < d2) target = closer;
  }
}

// ── HUNTING ──────────────────────────────────
function huntTick() {
  // Full enough → stop hunting
  if (bot.food >= 17) { bot.pathfinder.setGoal(null); target = null; setState(STATE.IDLE); return; }

  // If hostile mob gets close, fight it first
  const hostile = getNearestEntity(HOSTILE_MOBS, 10);
  if (hostile) { bot.pathfinder.setGoal(null); target = hostile; setState(STATE.COMBAT); return; }

  if (!target?.isValid) {
    const animal = getNearestEntity(FOOD_ANIMALS, 20);
    if (animal) {
      target = animal;
    } else {
      if (hasFood()) eatFood();
      setState(STATE.IDLE);
      return;
    }
  }

  const dist = bot.entity.position.distanceTo(target.position);
  if (dist > 3) {
    bot.pathfinder.setGoal(
      new GoalNear(target.position.x, target.position.y, target.position.z, 2)
    );
  } else {
    bot.pathfinder.setGoal(null);
    bot.lookAt(target.position.offset(0, target.height * 0.9, 0));
    bot.attack(target);
  }
}

// ── FLEE ─────────────────────────────────────
function flee() {
  bot.pathfinder.setGoal(null);
  stopMovement();
  console.log('[BOT] FLEEING!');

  const check = setInterval(() => {
    // Stop the loop if the bot disconnected or changed state
    if (!bot || state !== STATE.FLEEING) { 
      clearInterval(check); 
      return; 
    }

    // Getting worse → shelter
    if (bot.health <= HP.SHELTER) {
      clearInterval(check);
      bot.pathfinder.setGoal(null);
      setState(STATE.SHELTERING);
      buildShelter();
      return;
    }

    const threat = getNearestEntity(HOSTILE_MOBS, 20);

    // Safe now → idle
    if (!threat && bot.health >= HP.SAFE) {
      clearInterval(check);
      bot.pathfinder.setGoal(null);
      console.log('[BOT] Safe! Resuming');
      setState(STATE.IDLE);
      return;
    }

    // If a threat is still nearby, keep updating the escape route!
    if (threat) {
      const pos = bot.entity.position;
      const tp  = threat.position;
      const dx  = pos.x - tp.x;
      const dz  = pos.z - tp.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;

      // Continuously run away 20 blocks in the opposite direction
      bot.pathfinder.setGoal(
        new GoalNear(pos.x + (dx / len) * 20, pos.y, pos.z + (dz / len) * 20, 2)
      );
    } else {
      // No threat nearby, but still waiting to heal. Stand still and eat!
      bot.pathfinder.setGoal(null);
      if (bot.food < 20 && hasFood()) {
        eatFood();
      }
    }
  }, 2000); // Re-evaluates the escape route every 2 seconds
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
  } else {
    console.log('[BOT] No blocks — crouching and hiding in place');
  }

  if (hasFood()) await eatFood();
  waitForSafety();
}

function waitForSafety() {
  console.log('[BOT] Waiting in shelter for safety...');
  const check = setInterval(() => {
    if (!bot || state !== STATE.SHELTERING) { clearInterval(check); return; }

    // Eat while waiting
    if (bot.food < 16 && hasFood()) eatFood();

    const noThreat = !getNearestEntity(HOSTILE_MOBS, 12);
    const hpGood   = bot.health >= HP.SAFE;

    if (noThreat && hpGood) {
      clearInterval(check);
      bot.setControlState('sneak', false);
      console.log('[BOT] All clear — leaving shelter!');
      setState(STATE.IDLE);
    } else {
      const nearby = getNearestEntity(HOSTILE_MOBS, 12);
      console.log(`[BOT] Still hiding — HP: ${bot.health} | Threat: ${nearby?.name || 'none'}`);
    }
  }, 3000);
}

// ── EAT ──────────────────────────────────────
async function eatFood() {
  if (state === STATE.EATING) return;
  const food = bot.inventory.items().find(i => FOOD_ITEMS.has(i.name));
  if (!food) return;
  const prevState = state;
  try {
    setState(STATE.EATING);
    await bot.equip(food, 'hand');
    await bot.consume();
    console.log(`[BOT] Ate ${food.name} — Food: ${bot.food}`);
  } catch (e) {
    console.log('[BOT] Eat error:', e.message);
  } finally {
    setState(prevState === STATE.EATING ? STATE.IDLE : prevState);
  }
}

// ── HELPERS ──────────────────────────────────
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
  console.log(`[BOT] ${state} → ${s}`);
  state = s;
}

function cleanup() {
  clearInterval(mainTick);
  clearInterval(lookTick);
  if (bot?.entity) stopMovement();
}

createBot();
