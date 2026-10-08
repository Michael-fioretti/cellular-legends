'use strict';

// Execute the game's own trusted rules, so solo and multiplayer cannot drift.
// No code received over HTTP is ever evaluated here.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function loadGameRules({ htmlPath = path.join(__dirname, 'index.html'), now = Date.now } = {}) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const start = html.indexOf('const questionRows=');
  const end = html.indexOf('        /* GAME STATE */', start);
  if (start < 0 || end < 0) throw new Error('De gedeelde spelregels ontbreken in index.html.');
  class GameDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now()])); }
    static now() { return now(); }
  }
  const context = vm.createContext({ crypto: webcrypto, Date: GameDate });
  const exports = [
    'SquadEngine', 'makeMember', 'chooseQuestion', 'questionDifficulty', 'questionPool',
    'HERO_CLASSES', 'QUESTION_DATABASE', 'QUESTION_MODES', 'GEAR_RECIPES', 'MARKET_STOCK',
    'CAMPAIGN_QUESTS', 'MATERIALS', 'memberStats', 'skillCooldownRemaining',
  ];
  new vm.Script(html.slice(start, end) + '\n;globalThis.rules = {' + exports.join(',') + '};', {
    filename: 'index.html:shared-game-rules',
  }).runInContext(context, { timeout: 2000 });
  return context.rules;
}

module.exports = { loadGameRules };
