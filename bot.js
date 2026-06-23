const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalGetToBlock } = goals;
const { Vec3 } = require('vec3');

// ... (Keep your existing CONFIG, HP, HOSTILE_MOBS, FOOD_ITEMS, and STATE constants)

let bot, mcData, state = STATE.IDLE, registered = false, target = null, mainTick, lookTick, isWorking = false;
let lastPos = null, stuckCount = 0; // New trackers

function createBot() {
  bot = mineflayer.createBot(config);
  bot.loadPlugin(pathfinder);
  bot.once('spawn', () => {
    mcData = require('minecraft-data')(bot.version);
    bot.pathfinder.setMovements(new Movements(bot));
    setTimeout(() => { if (!registered) tryRegister(); }, 2000);
  });
  
  // ... (Keep your message handling and auth logic here)

  bot.on('health', () => { if (registered) handleHealth(); });
  bot.on('kicked', (r) => { cleanup(); setTimeout(createBot, 10000); });
}

// ── NEW: ADVANCED UTILITIES ──
function checkStuck() {
  if (state === STATE.IDLE || state === STATE.COMBAT || !bot.entity) return;
  if (!lastPos) { lastPos = bot.entity.position.clone(); return; }
  const dist = bot.entity.position.distanceTo(lastPos);
  if (dist < 0.5) {
    stuckCount++;
    if (stuckCount > 8) { // Increased sensitivity
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

// ── INTEGRATED AI LOOP ──
function startAI() {
  mainTick = setInterval(() => {
    if (!bot?.entity) return;

    // 1. NIGHT SAFETY
    const time = bot.time.timeOfDay;
    if (time > 13000 && time < 23000 && state !== STATE.SHELTERING && state !== STATE.COMBAT) {
      setState(STATE.SHELTERING);
      buildShelter();
      return;
    }

    // 2. RUN UTILITIES
    if (!isWorking) {
      checkStuck();
      cleanInventory();
    }

    // 3. MAIN STATE SWITCH
    if (isWorking) return;
    switch (state) {
      case STATE.IDLE:      idleTick();     break;
      case STATE.COMBAT:    combatTick();   break;
      case STATE.HUNTING:   huntTick();     break;
      case STATE.GATHERING: gatherTick();   break;
      case STATE.CRAFTING:  craftingTick(); break;
    }
  }, 1000);
}

// ... (Paste your original idleTick, combatTick, gatherTick, craftingTick, etc., below here)

// ── HELPER FUNCTIONS ──────────────────────────────────
function setState(s) { if (state !== s) console.log(`[BOT] ${state} → ${s}`); state = s; }
function stopMovement() { ['forward','back','left','right','jump','sneak','sprint'].forEach(c => bot.setControlState(c, false)); }
function cleanup() { clearInterval(mainTick); clearInterval(lookTick); isWorking = false; if (bot?.entity) stopMovement(); }

createBot();
