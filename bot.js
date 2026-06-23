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

const STATE = {
  IDLE: 'idle', COMBAT: 'combat', FLEEING: 'fleeing',
  SHELTERING: 'sheltering', EATING: 'eating', HUNTING: 'hunting',
  GATHERING: 'gathering', CRAFTING: 'crafting'
};

const HP = { FLEE: 10, SHELTER: 6, SAFE: 16 };

const HOSTILE_MOBS = new Set(['zombie','skeleton','creeper','spider','cave_spider','enderman','witch','pillager','vindicator','ravager','phantom','drowned','husk','stray','blaze','ghast','magma_cube','slime','silverfish','endermite','guardian','elder_guardian','shulker','zombie_villager','warden','zombified_piglin','hoglin','zoglin','bogged','breeze']);
const FOOD_ANIMALS = new Set(['cow','pig','sheep','chicken','rabbit','mooshroom']);
const FOOD_ITEMS = new Set(['cooked_beef','cooked_porkchop','cooked_chicken','cooked_mutton','cooked_rabbit','cooked_salmon','cooked_cod','bread','apple','golden_apple','enchanted_golden_apple','carrot','baked_potato','beef','porkchop','chicken','mutton','salmon','cod','melon_slice','sweet_berries','dried_kelp','mushroom_stew','rabbit_stew','pumpkin_pie','golden_carrot','chorus_fruit']);

let bot, mcData, state = STATE.IDLE, registered = false, target = null, mainTick, lookTick, isWorking = false;
let lastPos = null, stuckCount = 0;

function createBot() {
  state = STATE.IDLE; registered = false; target = null; isWorking = false;
  bot = mineflayer.createBot(config);
  bot.loadPlugin(pathfinder);
  bot.once('spawn', () => {
    mcData = require('minecraft-data')(bot.version);
    bot.pathfinder.setMovements(new Movements(bot));
    setTimeout(() => { if (!registered) tryRegister(); }, 2000);
  });
  bot.on('message', (jsonMsg) => {
    const msg = jsonMsg.toString().toLowerCase();
    if (msg.includes('register') && !registered) tryRegister();
    if (msg.includes('login') && !registered) tryLogin();
    if (!registered && (msg.includes('successfully') || msg.includes('welcome'))) { registered = true; startAI(); }
  });
  bot.on('health', () => { if (registered) handleHealth(); });
  bot.on('kicked', (r) => { cleanup(); setTimeout(createBot, 10000); });
}

function checkStuck() {
  if (state === STATE.IDLE || state === STATE.COMBAT || !bot.entity) return;
  if (!lastPos) { lastPos = bot.entity.position.clone(); return; }
  if (bot.entity.position.distanceTo(lastPos) < 0.5) {
    stuckCount++;
    if (stuckCount > 8) {
      bot.pathfinder.setGoal(null);
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 500);
      stuckCount = 0;
    }
  } else { lastPos = bot.entity.position.clone(); stuckCount = 0; }
}

async function cleanInventory() {
  const trash = ['gravel', 'diorite', 'andesite', 'granite', 'dirt', 'sand'];
  for (const item of bot.inventory.items()) {
    if (trash.includes(item.name) && bot.inventory.slots.filter(i => i).length > 30) {
      await bot.tossStack(item);
    }
  }
}

function startAI() {
  mainTick = setInterval(() => {
    if (!bot?.entity) return;
    const time = bot.time.timeOfDay;
    if (time > 13000 && time < 23000 && state !== STATE.SHELTERING && state !== STATE.COMBAT) {
      setState(STATE.SHELTERING);
      buildShelter();
      return;
    }
    if (!isWorking) { checkStuck(); cleanInventory(); }
    if (isWorking) return;
    switch (state) {
      case STATE.IDLE: idleTick(); break;
      case STATE.COMBAT: combatTick(); break;
      case STATE.HUNTING: huntTick(); break;
      case STATE.GATHERING: gatherTick(); break;
      case STATE.CRAFTING: craftingTick(); break;
    }
  }, 1000);
}

// ... (Copy all your original functions: tryRegister, handleHealth, idleTick, combatTick, huntTick, gatherTick, craftingTick, flee, buildShelter, eatFood, equipBestWeapon, etc., here)

function tryRegister() { bot.chat(`/register ${REG_PASSWORD} ${REG_PASSWORD}`); }
function tryLogin() { bot.chat(`/login ${REG_PASSWORD}`); }
function setState(s) { state = s; }
function cleanup() { clearInterval(mainTick); clearInterval(lookTick); }
createBot();
