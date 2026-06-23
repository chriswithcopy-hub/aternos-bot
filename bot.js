The error you are encountering is caused by the final closing brace `}` at the very end of your script, which is not part of the code structure, and the fact that `STATE` was being used before it was defined.

I have corrected the structure and moved all constant definitions to the top. **Copy and paste this entire block** to replace the content of your `bot.js` file.

```javascript
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
const { Vec3 } = require('vec3');

const STATE = {
  IDLE:       'idle',
  COMBAT:     'combat',
  FLEEING:    'fleeing',
  SHELTERING: 'sheltering',
  EATING:     'eating',
  HUNTING:    'hunting'
};

const config = {
  host:     process.env.SERVER_HOST || 'tiktokbuddies.aternos.me',
  port:     parseInt(process.env.SERVER_PORT) || 64617,
  username: process.env.BOT_USERNAME || 'AFKBot',
  version:  '1.21.1'
};

const REG_PASSWORD = process.env.REG_PASSWORD || 'BotPass1234';

const HP = { FLEE: 10, SHELTER: 6, SAFE: 16 };

const HOSTILE_MOBS = new Set([
  'zombie','skeleton','creeper','spider','cave_spider','enderman',
  'witch','pillager','vindicator','ravager','phantom','drowned',
  'husk','stray','blaze','ghast','magma_cube','slime','silverfish',
  'endermite','guardian','elder_guardian','shulker','zombie_villager',
  'warden','zombified_piglin','hoglin','zoglin','bogged','breeze'
]);

const FOOD_ANIMALS = new Set(['cow','pig','sheep','chicken','rabbit','mooshroom']);

const FOOD_ITEMS = new Set([
  'cooked_beef','cooked_porkchop','cooked_chicken','cooked_mutton',
  'cooked_rabbit','cooked_salmon','cooked_cod','bread','apple',
  'golden_apple','enchanted_golden_apple','carrot','baked_potato',
  'beef','porkchop','chicken','mutton','salmon','cod',
  'melon_slice','sweet_berries','dried_kelp','mushroom_stew',
  'rabbit_stew','pumpkin_pie','golden_carrot','chorus_fruit'
]);

let bot;
let state      = STATE.IDLE;
let registered = false;
let target     = null;
let mainTick;
let lookTick;

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

  bot.on('health', () => { if (registered) handleHealth(); });
  bot.on('kicked',  (r) => { console.log('[BOT] Kicked:', r);       cleanup(); setTimeout(createBot, 10000); });
  bot.on('error',   (e) => { console.log('[BOT] Error:', e.message); cleanup(); setTimeout(createBot, 10000); });
  bot.on('end',     ()  => { console.log('[BOT] Disconnected');      cleanup(); setTimeout(createBot, 10000); });
}

function tryRegister() {
  bot.chat(`/register ${REG_PASSWORD} ${REG_PASSWORD}`);
  setTimeout(() => { if (!registered) { registered = true; startAI(); } }, 5000);
}
function tryLogin() { bot.chat(`/login ${REG_PASSWORD}`); }

function handleHealth() {
  const hp = bot.health;
  if (bot.food <= 8 && state !== STATE.SHELTERING) eatFood();
  if (hp <= HP.SHELTER && state !== STATE.SHELTERING) { setState(STATE.SHELTERING); buildShelter(); return; }
  if (hp <= HP.FLEE && state !== STATE.FLEEING && state !== STATE.SHELTERING) { setState(STATE.FLEEING); flee(); return; }
  if (hp >= HP.SAFE && state === STATE.FLEEING) setState(STATE.IDLE);
}

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
  lookTick = setInterval(() => {
    if (state === STATE.IDLE && bot?.entity) bot.look((Math.random() * 2 - 1) * Math.PI, (Math.random() - 0.5) * (Math.PI / 3), true);
  }, 3000);
}

function idleTick() {
  const hostile = getNearestEntity(HOSTILE_MOBS, 16);
  if (hostile) { target = hostile; setState(STATE.COMBAT); return; }
  if (bot.food < 15) {
    if (hasFood()) { eatFood(); return; }
    const animal = getNearestEntity(FOOD_ANIMALS, 20);
    if (animal) { target = animal; setState(STATE.HUNTING); return; }
  }
  if (Math.random() < 0.25) randomWalk();
  if (Math.random() < 0.08) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 300); }
}

function combatTick() {
  if (!target?.isValid) { target = null; setState(STATE.IDLE); return; }
  if (bot.health <= HP.FLEE) { bot.pathfinder.setGoal(null); target = null; setState(STATE.FLEEING); flee(); return; }
  const dist = bot.entity.position.distanceTo(target.position);
  if (dist > 3) bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 2));
  else {
    bot.pathfinder.setGoal(null);
    bot.lookAt(target.position.offset(0, target.height * 0.9, 0));
    bot.attack(target);
    if (bot.entity.onGround && Math.random() > 0.4) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 250); }
  }
}

function huntTick() {
  if (bot.food >= 17) { bot.pathfinder.setGoal(null); target = null; setState(STATE.IDLE); return; }
  const hostile = getNearestEntity(HOSTILE_MOBS, 10);
  if (hostile) { bot.pathfinder.setGoal(null); target = hostile; setState(STATE.COMBAT); return; }
  if (!target?.isValid) {
    const animal = getNearestEntity(FOOD_ANIMALS, 20);
    if (animal) target = animal; else { if (hasFood()) eatFood(); setState(STATE.IDLE); return; }
  }
  const dist = bot.entity.position.distanceTo(target.position);
  if (dist > 3) bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 2));
  else { bot.pathfinder.setGoal(null); bot.lookAt(target.position.offset(0, target.height * 0.9, 0)); bot.attack(target); }
}

function flee() {
  bot.pathfinder.setGoal(null); stopMovement();
  const threat = getNearestEntity(HOSTILE_MOBS, 20);
  if (!threat) { setState(STATE.IDLE); return; }
  const pos = bot.entity.position; const tp = threat.position;
  const dx = pos.x - tp.x; const dz = pos.z - tp.z; const len = Math.sqrt(dx * dx + dz * dz) || 1;
  bot.pathfinder.setGoal(new GoalNear(pos.x + (dx / len) * 25, pos.y, pos.z + (dz / len) * 25, 2));
  const check = setInterval(() => {
    if (!bot || state !== STATE.FLEEING) { clearInterval(check); return; }
    if (bot.health <= HP.SHELTER) { clearInterval(check); buildShelter(); return; }
    if (!getNearestEntity(HOSTILE_MOBS, 10) && bot.health >= HP.SAFE) { clearInterval(check); setState(STATE.IDLE); }
  }, 2000);
}

async function buildShelter() {
  bot.pathfinder.setGoal(null); stopMovement(); bot.setControlState('sneak', true);
  const blockItem = bot.inventory.items().find(i => ['dirt','cobblestone','stone','sand','gravel','oak_planks','spruce_planks','cobbled_deepslate'].includes(i.name));
  if (blockItem && blockItem.count >= 3) {
    try {
      await bot.equip(blockItem, 'hand');
      const pos = bot.entity.position.floored();
      const sides = [new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1)];
      for (const side of sides) {
        const groundBlock = bot.blockAt(pos.plus(side).offset(0,-1,0));
        if (groundBlock && !['air','cave_air'].includes(groundBlock.name)) { await bot.placeBlock(groundBlock, new Vec3(0,1,0)); await bot.waitForTicks(3); }
      }
    } catch (e) {}
  }
  if (hasFood()) await eatFood();
  waitForSafety();
}

function waitForSafety() {
  const check = setInterval(() => {
    if (!bot || state !== STATE.SHELTERING) { clearInterval(check); return; }
    if (bot.food < 16 && hasFood()) eatFood();
    if (!getNearestEntity(HOSTILE_MOBS, 12) && bot.health >= HP.SAFE) { clearInterval(check); bot.setControlState('sneak', false); setState(STATE.IDLE); }
  }, 3000);
}

async function eatFood() {
  if (state === STATE.EATING) return;
  const food = bot.inventory.items().find(i => FOOD_ITEMS.has(i.name));
  if (!food) return;
  const prevState = state;
  try {
    setState(STATE.EATING);
    await bot.equip(food, 'hand');
    await bot.consume();
  } catch (e) {} finally { setState(prevState === STATE.EATING ? STATE.IDLE : prevState); }
}

function getNearestEntity(nameSet, maxDist) {
  return Object.values(bot.entities).filter(e => e !== bot.entity && nameSet.has(e.name) && e.isValid && bot.entity.position.distanceTo(e.position) <= maxDist).sort((a,b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0] || null;
}

function hasFood() { return bot.inventory.items().some(i => FOOD_ITEMS.has(i.name)); }
function randomWalk() { const dirs = ['forward','back','left','right']; const dir = dirs[Math.floor(Math.random()*dirs.length)]; bot.setControlState(dir, true); setTimeout(() => bot.setControlState(dir, false), 1000 + Math.random()*2000); }
function stopMovement() { ['forward','back','left','right','jump','sneak','sprint'].forEach(c => bot.setControlState(c, false)); }
function setState(s) { state = s; }
function cleanup() { clearInterval(mainTick); clearInterval(lookTick); if (bot?.entity) stopMovement(); }

createBot();

```
