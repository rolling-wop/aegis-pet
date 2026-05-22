const express = require('express');
const bcrypt  = require('bcryptjs');
const fetch   = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');
const fs      = require('fs');
const initSqlJs = require('sql.js');
const webPush = require('web-push');

// VAPID keys for push notifications
const VAPID_PUBLIC_KEY  = 'BPCFtrBu2633noWjzOMfBnd7w42erJw2cN0x6jbE5o2oqh0pyR_tHGU_IImkPsb6xPYSnmjOJybq2c-Yta8Zg7I';
const VAPID_PRIVATE_KEY = 'I-zfOoJUTphho31V2jdBOiD_7h-HEn4SseWSdtLD7zw';
webPush.setVapidDetails('mailto:aegispet@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ── DB SETUP (sql.js — pure JS, no native compile) ────────────────────────────
const DB_PATH = process.env.DB_PATH || './aegis.db';
let db;

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL,
      pet_name TEXT NOT NULL, archetype TEXT NOT NULL,
      what_matters TEXT DEFAULT 'Not sure', referral_code TEXT UNIQUE,
      referred_by TEXT, pdpa_consent INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      last_login TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE IF NOT EXISTS game_state (
      player_id TEXT PRIMARY KEY, evolution_stage INTEGER DEFAULT 1,
      guardian_level INTEGER DEFAULT 1, xp INTEGER DEFAULT 0,
      vitality INTEGER DEFAULT 40, stability INTEGER DEFAULT 40,
      resilience INTEGER DEFAULT 40, bond INTEGER DEFAULT 40, legacy INTEGER DEFAULT 40,
      login_streak INTEGER DEFAULT 1, trials_complete INTEGER DEFAULT 0,
      beasts_unlocked TEXT DEFAULT '[]', scenarios_done TEXT DEFAULT '[]',
      last_trial_at TEXT, profile_type TEXT DEFAULT 'UNENGAGED',
      FOREIGN KEY(player_id) REFERENCES players(id)
    );
    CREATE TABLE IF NOT EXISTS trial_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL,
      scenario_id INTEGER NOT NULL, beasts_used TEXT DEFAULT '[]',
      outcome TEXT NOT NULL, dimension_affected TEXT,
      decision_time_ms INTEGER DEFAULT 0, xp_gained INTEGER DEFAULT 0,
      reward_roll INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      FOREIGN KEY(player_id) REFERENCES players(id)
    );
    CREATE TABLE IF NOT EXISTS advisor_sessions (
      token TEXT PRIMARY KEY, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      player_id TEXT NOT NULL, subscription TEXT NOT NULL, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE IF NOT EXISTS referral_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ref_code TEXT NOT NULL, visitor_ip TEXT,
      converted INTEGER DEFAULT 0, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);
  saveDB();
  console.log('✅ Database ready');
}

function saveDB() {
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch(e) { console.error('DB save error:', e.message); }
}

// Helpers wrapping sql.js query API
function dbGet(sql, params=[]) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) { const r = stmt.getAsObject(); stmt.free(); return r; }
  stmt.free(); return null;
}
function dbAll(sql, params=[]) {
  const rows = []; const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free(); return rows;
}
function dbRun(sql, params=[]) {
  db.run(sql, params); saveDB();
}

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8633895902:AAHOkhez6N1XW3fM0sM1b78NvQBupOOZcFQ';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8193595101';
const ADVISOR_PASSWORD   = process.env.ADVISOR_PASSWORD   || 'AEGIS2026!Dylan';

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function sendTelegramAlert(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode:'Markdown' })
    });
  } catch(e) { console.error('Telegram alert failed:', e.message); }
}

function generateRefCode(name) {
  return name.substring(0,3).toUpperCase() + Math.random().toString(36).substring(2,6).toUpperCase();
}

function classifyProfile(gs) {
  if (!gs || (gs.trials_complete||0) < 3) return 'UNENGAGED';
  const beasts = JSON.parse(gs.beasts_unlocked||'[]');
  const forgeBeasts = ['F01','F02','F03','F04','F05','F06'];
  const forgeCount = beasts.filter(b => forgeBeasts.includes(b)).length;
  const shieldCount = beasts.filter(b => !forgeBeasts.includes(b)).length;
  if (forgeCount > shieldCount * 2) return 'BLIND_BUILDER';
  if ((gs.bond||40) > 80 && (gs.vitality||40) > 80 && (gs.resilience||40) < 50) return 'ANXIOUS_PROTECTOR';
  const dims = [gs.vitality,gs.stability,gs.resilience,gs.bond,gs.legacy].map(v=>v||40);
  if (dims.every(v=>v>70)) return 'BALANCED_STRATEGIST';
  if ((gs.login_streak||1) < 3 && (gs.trials_complete||0) > 2) return 'PROCRASTINATOR';
  if ((gs.bond||40) > 75 && (gs.legacy||40) < 40) return 'FAMILY_GUARDIAN';
  if ((gs.resilience||40) > 70 && (gs.vitality||40) > 70 && (gs.legacy||40) < 40) return 'YOUNG_RISK_TAKER';
  if ((gs.legacy||40) > 70 && forgeCount >= 2) return 'LEGACY_PLANNER';
  if ((gs.vitality||40) > 70 && (gs.resilience||40) > 70 && (gs.stability||40) < 50) return 'SURVIVOR_TYPE';
  return 'UNENGAGED';
}

function getConversationOpener(profileType, name, petName, gap) {
  const m = {
    BLIND_BUILDER: `Hey ${name}! I noticed ${petName} is growing strong on the wealth side — but there are a few shields that haven't been summoned yet. Worth a 20-min chat to make sure the foundation matches the ambition? 💪`,
    ANXIOUS_PROTECTOR: `Hey ${name}, ${petName} is well-protected in most areas — I just want to make sure that protection is as efficient as possible. Can we do a quick 20-min review? 🎯`,
    BALANCED_STRATEGIST: `${name}, ${petName}'s profile is one of the strongest I've seen. You're thinking about this the right way. Let's spend 30 mins putting an actual plan together — I think you'll like what's possible 🚀`,
    PROCRASTINATOR: `Hey ${name}! ${petName} hasn't been getting the challenges lately — I get it, life gets busy. But I found one specific gap worth 20 minutes of your time. Can we sort it this week? ⏰`,
    FAMILY_GUARDIAN: `${name}, the way ${petName} always defends the dependants first tells me a lot about what matters to you. I want to show you exactly how we protect that — takes 20 mins 🛡️`,
    YOUNG_RISK_TAKER: `Hey ${name}! ${petName} is fearless — love that energy. Quick question: what's the plan if something unexpected hits before the wealth builds? 20 mins could make a real difference 🔥`,
    LEGACY_PLANNER: `${name}, ${petName}'s always looking at the horizon. I'd love to show you a structure that builds wealth AND legacy at the same time. Coffee chat? ☕`,
    SURVIVOR_TYPE: `Hey ${name}, ${petName} has survived every health trial. That resilience is inspiring. Let's make sure the real-life version is just as strong — 20 mins this week? 💚`,
    UNENGAGED: `Hey ${name}! ${petName} is still finding its feet. I'd love to help unlock the next level — there's a quick gap in ${gap||'protection'} worth discussing. 20 minutes? 🎮`
  };
  return m[profileType] || m.UNENGAGED;
}

function getTopGaps(gs) {
  if (!gs) return [];
  return [
    { name:'Hospitalisation', key:'vitality',   val: gs.vitality||40 },
    { name:'TPD/Income',      key:'stability',  val: gs.stability||40 },
    { name:'CI/Accident',     key:'resilience', val: gs.resilience||40 },
    { name:'Death/Dependants',key:'bond',       val: gs.bond||40 },
    { name:'Legacy/Invest',   key:'legacy',     val: gs.legacy||40 }
  ].sort((a,b)=>a.val-b.val).slice(0,3);
}

const PROFILE_LABELS = {
  BLIND_BUILDER:'The Blind Builder', ANXIOUS_PROTECTOR:'The Anxious Protector',
  BALANCED_STRATEGIST:'The Balanced Strategist', PROCRASTINATOR:'The Procrastinator',
  FAMILY_GUARDIAN:'The Family Guardian', YOUNG_RISK_TAKER:'The Young Risk-Taker',
  LEGACY_PLANNER:'The Legacy Planner', SURVIVOR_TYPE:'The Survivor', UNENGAGED:'The Unengaged'
};

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function advisorAuth(req, res, next) {
  const token = req.headers['x-advisor-token'] || req.query.token;
  if (!token) return res.status(401).json({ error:'Unauthorized' });
  const session = dbGet('SELECT * FROM advisor_sessions WHERE token = ?', [token]);
  if (!session) return res.status(401).json({ error:'Unauthorized' });
  next();
}

// ── CLIENT API ────────────────────────────────────────────────────────────────
app.post('/api/start', async (req, res) => {
  try {
    const { name, phone, petName, archetype, whatMatters, referredBy } = req.body;
    if (!name || !phone || !petName || !archetype) return res.status(400).json({ error:'Missing required fields' });
    const id = uuidv4();
    const refCode = generateRefCode(name);
    const now = new Date().toISOString();
    dbRun(`INSERT INTO players (id,name,phone,pet_name,archetype,what_matters,referral_code,referred_by,created_at,last_login)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, name, phone, petName, archetype, whatMatters||'Not sure', refCode, referredBy||null, now, now]);
    dbRun(`INSERT INTO game_state (player_id) VALUES (?)`, [id]);

    await sendTelegramAlert(
      `🎮 *AEGIS PET — New Player!*\n\n👤 *${name}*\n📱 ${phone}\n🐾 Pet: *${petName}*\n🎭 Archetype: *${archetype}*\n` +
      `❤️ Cares about: ${whatMatters||'Not sure'}\n🔗 Ref: \`${refCode}\`\n\n_View dashboard: /advisor_`
    );
    res.json({ ok:true, playerId:id, refCode });
  } catch(e) { console.error(e); res.status(500).json({ error:e.message }); }
});

app.get('/api/player/:id', (req, res) => {
  const player = dbGet('SELECT * FROM players WHERE id = ?', [req.params.id]);
  if (!player) return res.status(404).json({ error:'Not found' });
  const gs = dbGet('SELECT * FROM game_state WHERE player_id = ?', [req.params.id]);
  const trials = dbAll('SELECT * FROM trial_results WHERE player_id = ? ORDER BY created_at DESC LIMIT 20', [req.params.id]);
  dbRun('UPDATE players SET last_login = ? WHERE id = ?', [new Date().toISOString(), req.params.id]);
  res.json({ player, gameState:gs, trials });
});

app.post('/api/login', (req, res) => {
  const { playerId } = req.body;
  const player = dbGet('SELECT * FROM players WHERE id = ?', [playerId]);
  if (!player) return res.status(404).json({ error:'Not found' });
  const gs = dbGet('SELECT * FROM game_state WHERE player_id = ?', [playerId]);
  const diffHours = (Date.now() - new Date(player.last_login)) / 3600000;
  const streak = gs ? (diffHours > 48 ? 1 : diffHours > 20 ? (gs.login_streak||1)+1 : (gs.login_streak||1)) : 1;
  dbRun('UPDATE game_state SET login_streak = ? WHERE player_id = ?', [streak, playerId]);
  dbRun('UPDATE players SET last_login = ? WHERE id = ?', [new Date().toISOString(), playerId]);
  const updatedGs = dbGet('SELECT * FROM game_state WHERE player_id = ?', [playerId]);
  res.json({ ok:true, streak, gameState:updatedGs });
});

app.post('/api/trial', async (req, res) => {
  try {
    const { playerId, scenarioId, beastsUsed, outcome, dimensionAffected, decisionTimeMs } = req.body;
    const gs = dbGet('SELECT * FROM game_state WHERE player_id = ?', [playerId]);
    if (!gs) return res.status(404).json({ error:'Player not found' });

    const roll = Math.floor(Math.random()*100)+1;
    let xpGained = 50, rewardType = 'xp', newBeast = null;
    if (roll===100) { rewardType='eclipse'; xpGained=200; }
    else if (roll>=96) { rewardType='legendary'; xpGained=150; }
    else if (roll>=89) { rewardType='beast'; xpGained=75; }
    else if (roll>=76) { rewardType='fragment'; xpGained=60; }
    else if (roll>=61) { rewardType='synergy'; xpGained=55; }
    else if (roll>=41) { rewardType='evolution'; xpGained=50; }

    const dimKey = ['vitality','stability','resilience','bond','legacy'].includes(dimensionAffected) ? dimensionAffected : 'vitality';
    const curHealth = gs[dimKey]||40;
    const newHealth = Math.max(0, Math.min(100, curHealth + (outcome==='success' ? 15 : -20)));
    const newXP = (gs.xp||0) + xpGained;
    const newLevel = Math.min(10, Math.floor(newXP/200)+1);

    const scenariosDone = JSON.parse(gs.scenarios_done||'[]');
    if (!scenariosDone.includes(scenarioId)) scenariosDone.push(scenarioId);
    const newTrials = (gs.trials_complete||0)+1;

    let newEvolution = gs.evolution_stage||1;
    if (newTrials>=3 && newEvolution<2) newEvolution=2;
    if (newTrials>=8 && newHealth>=50 && newEvolution<3) newEvolution=3;
    if (scenariosDone.length>=8 && newEvolution<4) newEvolution=4;

    const beastsUnlocked = JSON.parse(gs.beasts_unlocked||'[]');
    if (rewardType==='beast' || rewardType==='legendary') {
      const all = ['S01','S02','S03','S04','S05','S06','S07','S08','F01','F02','F03','F04','F05','F06'];
      const avail = all.filter(b=>!beastsUnlocked.includes(b));
      if (avail.length>0) { newBeast=avail[Math.floor(Math.random()*avail.length)]; beastsUnlocked.push(newBeast); }
    }

    const updatedGs = { ...gs, [dimKey]:newHealth, trials_complete:newTrials, xp:newXP };
    const profileType = classifyProfile(updatedGs);

    dbRun(`UPDATE game_state SET ${dimKey}=?,xp=?,guardian_level=?,trials_complete=?,scenarios_done=?,
           beasts_unlocked=?,evolution_stage=?,last_trial_at=?,profile_type=? WHERE player_id=?`,
      [newHealth,newXP,newLevel,newTrials,JSON.stringify(scenariosDone),JSON.stringify(beastsUnlocked),
       newEvolution,new Date().toISOString(),profileType,playerId]);
    dbRun(`INSERT INTO trial_results (player_id,scenario_id,beasts_used,outcome,dimension_affected,decision_time_ms,xp_gained,reward_roll)
           VALUES (?,?,?,?,?,?,?,?)`,
      [playerId,scenarioId,JSON.stringify(beastsUsed||[]),outcome,dimensionAffected,decisionTimeMs||0,xpGained,roll]);

    const player = dbGet('SELECT * FROM players WHERE id=?',[playerId]);
    if (newTrials===1) {
      await sendTelegramAlert(`⚔️ *AEGIS PET — First Trial!*\n👤 ${player?.name} | Pet: ${player?.pet_name}\n📊 Gap signal: *${(dimensionAffected||'vitality').toUpperCase()}*`);
    }
    if (scenariosDone.length>=8) {
      const gaps = getTopGaps(updatedGs);
      const opener = getConversationOpener(profileType, player?.name, player?.pet_name, gaps[0]?.name);
      await sendTelegramAlert(
        `🏆 *AEGIS PET — Full Profile!*\n👤 *${player?.name}* | ${player?.phone}\n🐾 ${player?.pet_name} | 🎭 ${player?.archetype}\n` +
        `🧠 *${PROFILE_LABELS[profileType]||profileType}*\n⚠️ Top gaps: ${gaps.map(g=>g.name).join(', ')}\n\n💬 _${opener}_`
      );
    }
    res.json({ ok:true, xpGained, rewardType, newBeast, newHealth, newLevel, newEvolution, roll });
  } catch(e) { console.error(e); res.status(500).json({ error:e.message }); }
});

app.get('/api/ref/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const p = dbGet('SELECT id,name,pet_name,archetype FROM players WHERE referral_code=?',[code]);
  if (!p) return res.status(404).json({ error:'Invalid code' });
  // Log click
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  dbRun('INSERT INTO referral_clicks (ref_code,visitor_ip) VALUES (?,?)', [code, ip]);
  res.json(p);
});

// Push notification endpoints
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', (req, res) => {
  try {
    const { playerId, subscription } = req.body;
    if (!playerId || !subscription) return res.status(400).json({ error: 'Missing fields' });
    // Remove existing subscription for player then insert new one
    dbRun('DELETE FROM push_subscriptions WHERE player_id = ?', [playerId]);
    dbRun('INSERT INTO push_subscriptions (player_id, subscription) VALUES (?,?)',
      [playerId, JSON.stringify(subscription)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/push/trigger-daily', advisorAuth, async (req, res) => {
  try {
    const subs = dbAll('SELECT * FROM push_subscriptions');
    let sent = 0, failed = 0;
    for (const row of subs) {
      try {
        const sub = JSON.parse(row.subscription);
        await webPush.sendNotification(sub, JSON.stringify({
          title: '⚔️ Your pet needs you!',
          body: 'Daily trial ready. Keep your guardian strong!',
          icon: '/icon-192.png',
          badge: '/icon-192.png'
        }));
        sent++;
      } catch(e) {
        failed++;
        // Remove invalid subscription
        if (e.statusCode === 410) {
          dbRun('DELETE FROM push_subscriptions WHERE player_id = ?', [row.player_id]);
        }
      }
    }
    res.json({ ok: true, sent, failed });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Referral stats endpoint
app.get('/api/referral-stats/:playerId', (req, res) => {
  try {
    const player = dbGet('SELECT * FROM players WHERE id=?', [req.params.playerId]);
    if (!player) return res.status(404).json({ error: 'Not found' });
    const clicks = dbGet('SELECT COUNT(*) as cnt FROM referral_clicks WHERE ref_code=?', [player.referral_code]);
    const friends = dbAll('SELECT p.name, p.pet_name, p.archetype, p.created_at, gs.profile_type, gs.vitality, gs.stability, gs.resilience, gs.bond, gs.legacy FROM players p LEFT JOIN game_state gs ON gs.player_id=p.id WHERE p.referred_by=?', [player.referral_code]);
    const conversions = friends.length;
    // Mark clicks as converted where we have actual conversions
    res.json({ clicks: clicks?.cnt || 0, conversions, friends });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Friend comparison endpoint
app.get('/api/friend-compare/:playerId/:friendId', (req, res) => {
  try {
    const me = dbGet('SELECT p.*,gs.vitality,gs.stability,gs.resilience,gs.bond,gs.legacy,gs.guardian_level,gs.trials_complete,gs.beasts_unlocked,gs.evolution_stage FROM players p LEFT JOIN game_state gs ON gs.player_id=p.id WHERE p.id=?', [req.params.playerId]);
    const friend = dbGet('SELECT p.*,gs.vitality,gs.stability,gs.resilience,gs.bond,gs.legacy,gs.guardian_level,gs.trials_complete,gs.beasts_unlocked,gs.evolution_stage FROM players p LEFT JOIN game_state gs ON gs.player_id=p.id WHERE p.id=?', [req.params.friendId]);
    if (!me || !friend) return res.status(404).json({ error: 'Not found' });
    res.json({ me, friend });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADVISOR API ───────────────────────────────────────────────────────────────
app.post('/api/advisor/auth', (req,res) => {
  if (req.body.password!==ADVISOR_PASSWORD) return res.status(401).json({ error:'Wrong password' });
  const token = uuidv4();
  dbRun('INSERT INTO advisor_sessions (token,created_at) VALUES (?,?)',[token,new Date().toISOString()]);
  res.json({ ok:true, token });
});

app.get('/api/advisor/clients', advisorAuth, (req,res) => {
  const clients = dbAll(`SELECT p.*,gs.evolution_stage,gs.guardian_level,gs.xp,gs.vitality,gs.stability,
    gs.resilience,gs.bond,gs.legacy,gs.login_streak,gs.trials_complete,gs.profile_type,
    gs.beasts_unlocked,gs.last_trial_at,gs.scenarios_done
    FROM players p LEFT JOIN game_state gs ON gs.player_id=p.id ORDER BY p.created_at DESC`);
  const stats = {
    total: clients.length,
    profilesComplete: clients.filter(c=>{ try{return JSON.parse(c.scenarios_done||'[]').length>=8}catch{return false} }).length,
    newToday: clients.filter(c=>new Date(c.created_at)>new Date(Date.now()-86400000)).length,
    highPriority: clients.filter(c=>Math.min(c.vitality||40,c.stability||40,c.resilience||40,c.bond||40,c.legacy||40)<30).length,
    stages: {
      started: clients.length,
      leadCaptured: clients.length,
      tutorialDone: clients.filter(c=>(c.trials_complete||0)>0).length,
      profileDone: clients.filter(c=>{ try{return JSON.parse(c.scenarios_done||'[]').length>=8}catch{return false} }).length
    }
  };
  res.json({ clients, stats });
});

app.get('/api/advisor/client/:id', advisorAuth, (req,res) => {
  const player  = dbGet('SELECT * FROM players WHERE id=?',[req.params.id]);
  if (!player) return res.status(404).json({ error:'Not found' });
  const gs      = dbGet('SELECT * FROM game_state WHERE player_id=?',[req.params.id]);
  const trials  = dbAll('SELECT * FROM trial_results WHERE player_id=? ORDER BY created_at',[req.params.id]);

  const avgDecisionTime = trials.length ? Math.round(trials.reduce((s,t)=>s+(t.decision_time_ms||0),0)/trials.length) : 0;
  const beastCounts = {};
  trials.forEach(t => { JSON.parse(t.beasts_used||'[]').forEach(b=>{ beastCounts[b]=(beastCounts[b]||0)+1; }); });
  const topBeasts = Object.entries(beastCounts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([b])=>b);
  const allShields = ['S01','S02','S03','S04','S05','S06','S07','S08'];
  const ignoredBeasts = allShields.filter(b=>!beastCounts[b]);
  const beasts = JSON.parse(gs?.beasts_unlocked||'[]');
  const forgeRatio = beasts.length ? Math.round(beasts.filter(b=>b.startsWith('F')).length/beasts.length*100) : 0;

  const profileType = gs?.profile_type||'UNENGAGED';
  const gaps = getTopGaps(gs);
  const opener = getConversationOpener(profileType, player.name, player.pet_name, gaps[0]?.name||'protection');

  const objectionMap = {
    BLIND_BUILDER:["I'll think about it","I have investments already"],
    ANXIOUS_PROTECTOR:["I already have a lot of insurance","Is this really necessary?"],
    PROCRASTINATOR:["Not now","Let me check my schedule"],
    YOUNG_RISK_TAKER:["It's too expensive","I'm young, I don't need this yet"],
    BALANCED_STRATEGIST:["Show me the numbers","What's the best structure?"],
    FAMILY_GUARDIAN:["I'm already paying for family policies","My spouse handles this"],
    LEGACY_PLANNER:["I want to compare options first","What's the long-term commitment?"],
    SURVIVOR_TYPE:["I've already been through this","Will I qualify?"],
    UNENGAGED:["Not interested right now","Maybe later"]
  };
  const strategyMap = {
    BLIND_BUILDER:'Lead with loss story. Short options. Quick close.',
    ANXIOUS_PROTECTOR:'Lead with efficiency review. Show cost-benefit. Reassure, not scare.',
    BALANCED_STRATEGIST:'Lead with data. Provide pre-read. Full planning session.',
    PROCRASTINATOR:'Lead with social proof. Start with smallest gap. Create urgency.',
    FAMILY_GUARDIAN:'Lead with dependant scenario. Use AEGIS pet metaphor.',
    YOUNG_RISK_TAKER:'Lead with real stories. Make it tangible and affordable.',
    LEGACY_PLANNER:'Lead with long-term vision. Show compounding. Investment angle.',
    SURVIVOR_TYPE:'Lead with ECI/CI story. Empathise. Show specific coverage.',
    UNENGAGED:'Re-engage with pet story. Low-commitment entry point.'
  };

  res.json({ player, gameState:gs, trials, gaps,
    behavioral:{ avgDecisionTime, topBeasts, ignoredBeasts, forgeRatio },
    intelligence:{ profileType: PROFILE_LABELS[profileType]||profileType,
      appointmentOpener:opener, topGaps:gaps,
      strategy:strategyMap[profileType]||strategyMap.UNENGAGED,
      objections:objectionMap[profileType]||objectionMap.UNENGAGED }
  });
});

// ── PAGES ─────────────────────────────────────────────────────────────────────
app.get('/advisor', (req,res) => res.sendFile(path.join(__dirname,'public','advisor.html')));
app.get('/advisor.html', (req,res) => res.sendFile(path.join(__dirname,'public','advisor.html')));
app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`🐾 AEGIS PET running on port ${PORT}`));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
