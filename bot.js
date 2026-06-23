require('dotenv').config();

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
const { Vec3 } = require('vec3');

const STATE = {
IDLE: 'idle',
COMBAT: 'combat',
FLEEING: 'fleeing',
SHELTERING: 'sheltering',
EATING: 'eating',
HUNTING: 'hunting'
};

const config = {
host: process.env.SERVER_HOST || 'tiktokbuddies.aternos.me',
port: parseInt(process.env.SERVER_PORT) || 64617,
username: process.env.BOT_USERNAME || 'AFKBot',
version: '1.21.1'
};

const REG_PASSWORD = process.env.REG_PASSWORD || 'BotPass1234';
