/**
 * Disclosure Defenders: shared high-score board (Cloudflare Worker + KV)
 *
 * Needs one KV namespace bound to this Worker under the variable name  SCORES
 *
 *   GET  /?board=<key>&player=<id>                      -> top scores for that board, as JSON (your own row flagged mine:true)
 *   POST /   {board, name, score, difficulty, player}   -> saves a score, returns the updated top scores
 *
 * One entry per player per board: a player's best score is kept, and their name updates to the latest one they used.
 * <id> is a random string the game generates in the player's browser. It is never returned to other players.
 *
 * Stored per entry: made-up name, score, difficulty, date and the random player ID. Nothing else. No IP addresses are stored.
 * To remove an entry by hand: Cloudflare dashboard > KV > your namespace > key "board:<key>" > edit the JSON.
 */

const BOARDS = ['all', 'compliance', 'risk', 'double-materiality', 'carbon-accounting', 'stakeholders'];
const MAX_SCORE = { single: 40000, all: 150000 };   // anything above this is not reachable in normal play
const KEEP = 100;                                    // entries stored per board
const SHOW = 50;                                     // entries returned to the game
const MIN_SECONDS_BETWEEN_POSTS = 8;                 // per visitor, best effort, held in memory only
const FALLBACK_NAME = 'Anonymous Analyst';
const NAME_MAX = 24;
// The game's built-in rivals: nobody else can take these names
const RESERVED = ['The Assurance Provider', 'CFO (Skeptical)', 'Scope 3 Sleuth', 'Audit Intern, Day 2', 'Materiality Maverick', 'Head of Spreadsheets',
  'Baseline Year Bandit', 'Omnibus Survivor', 'Supplier (Still Chasing)', 'Reply-All Rita'].map(n => n.toLowerCase());
const BLOCKED = ['fuck', 'shit', 'cunt', 'bitch', 'nigg', 'fag', 'rape', 'nazi', 'hitler', 'porn', 'dick', 'cock', 'pussy', 'whore', 'slut', 'twat', 'wank', 'kike', 'spic', 'retard'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};
const recent = new Map();   // visitor -> last post time (memory only; resets whenever the Worker restarts)

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS)
  });
}

function cleanPlayer(raw) { const p = String(raw || ''); return /^[a-z0-9]{12,40}$/.test(p) ? p : ''; }

// What other players see: no player IDs, just a flag on your own row
function publicRows(rows, player) {
  return rows.slice(0, SHOW).map(r => ({ name: r.name, score: r.score, difficulty: r.difficulty, date: r.date, mine: !!player && r.player === player }));
}

function cleanName(raw) {
  let n = String(raw || '').replace(/[<>&"'\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  const squashed = n.toLowerCase().replace(/[^a-z]/g, '');
  if (n.length < 2 || BLOCKED.some(w => squashed.includes(w))) n = FALLBACK_NAME;
  return n;
}

// Names are unique across every board: a name belongs to the first player who used it. Anyone else asking for it gets a number added.
async function uniqueName(env, wanted, player, rows) {
  let names = {};
  try { names = JSON.parse((await env.SCORES.get('names')) || '{}') || {}; } catch (e) { names = {}; }
  const owner = n => names[n.toLowerCase()];
  const takenByOther = n => RESERVED.includes(n.toLowerCase()) || (owner(n) && owner(n) !== player) ||
    rows.some(r => r.name.toLowerCase() === n.toLowerCase() && r.player !== player);   // also covers older entries saved before this rule
  let name = wanted;
  if (takenByOther(name)) { const base = wanted.slice(0, NAME_MAX - 3); let i = 2; while (takenByOther(base + ' ' + i)) i++; name = base + ' ' + i; }
  if (player && owner(name) !== player) { names[name.toLowerCase()] = player; await env.SCORES.put('names', JSON.stringify(names)); }
  return name;
}

async function readBoard(env, board) {
  try { return JSON.parse((await env.SCORES.get('board:' + board)) || '[]') || []; } catch (e) { return []; }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.SCORES) return json({ error: 'KV namespace is not bound. Add a KV binding named SCORES.' }, 500);

    const url = new URL(request.url);

    if (request.method === 'GET') {
      const board = url.searchParams.get('board') || 'all';
      if (!BOARDS.includes(board)) return json({ error: 'Unknown board' }, 400);
      return json(publicRows(await readBoard(env, board), cleanPlayer(url.searchParams.get('player'))));
    }

    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
      const board = String(body.board || '');
      const score = Number(body.score);
      const difficulty = ['low', 'med', 'high'].includes(body.difficulty) ? body.difficulty : 'med';
      if (!BOARDS.includes(board)) return json({ error: 'Unknown board' }, 400);
      const cap = board === 'all' ? MAX_SCORE.all : MAX_SCORE.single;
      if (!Number.isInteger(score) || score <= 0 || score > cap) return json({ error: 'Score not accepted' }, 400);

      const who = request.headers.get('CF-Connecting-IP') || 'unknown', now = Date.now();
      if (now - (recent.get(who) || 0) < MIN_SECONDS_BETWEEN_POSTS * 1000) return json({ error: 'Too many scores, slow down' }, 429);
      recent.set(who, now);
      if (recent.size > 5000) recent.clear();

      const player = cleanPlayer(body.player);
      const rows = await readBoard(env, board);
      const entry = { name: await uniqueName(env, cleanName(body.name), player, rows), score: score, difficulty: difficulty, date: new Date(now).toISOString().slice(0, 10), player: player || undefined };
      const mine = player ? rows.find(r => r.player === player) : null;
      let changed = false;
      if (mine) {                                   // one entry per player: keep the best score, use the latest name
        if (mine.name !== entry.name) { mine.name = entry.name; changed = true; }
        if (score > mine.score) { Object.assign(mine, entry); changed = true; }
      } else if (rows.length < KEEP || score > rows[rows.length - 1].score) {
        rows.push(entry); changed = true;
      }
      if (changed) {
        rows.sort((a, b) => b.score - a.score);
        rows.length = Math.min(rows.length, KEEP);
        await env.SCORES.put('board:' + board, JSON.stringify(rows));
      }
      return json(publicRows(rows, player));
    }

    return json({ error: 'Method not allowed' }, 405);
  }
};
