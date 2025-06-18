const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(session({
  secret: 'cricket_secret_123',
  resave: false,
  saveUninitialized: true,
}));

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'password123';

// In-memory DB
let teams = {}; // { teamName: [{playerName, runs, wickets}] }
let matches = []; // [{matchId, teamA, teamB, matchDateTime, played, winner, scores: {playerName: {runs, wickets}}] }
let pointsTable = {}; // { teamName: { played, won, lost, points } }

// History stacks for undo/redo (simple approach)
let adminHistory = [];
let adminRedo = [];

function pushHistory(action, payload) {
  adminHistory.push({ action, payload: JSON.parse(JSON.stringify(payload)) });
  if (adminHistory.length > 50) adminHistory.shift();
  adminRedo = [];
}

app.post('/api/admin-undo', requireAdmin, (req, res) => {
  if (adminHistory.length === 0) return res.status(400).json({ error: 'No actions to undo.' });
  const { action, payload } = adminHistory.pop();
  adminRedo.push({ action, payload: JSON.parse(JSON.stringify(payload)) });
  applyUndo(action, payload);
  res.json({ success: true });
});

app.post('/api/admin-redo', requireAdmin, (req, res) => {
  if (adminRedo.length === 0) return res.status(400).json({ error: 'No actions to redo.' });
  const { action, payload } = adminRedo.pop();
  adminHistory.push({ action, payload: JSON.parse(JSON.stringify(payload)) });
  applyRedo(action, payload);
  res.json({ success: true });
});

function applyUndo(action, payload) {
  switch (action) {
    case 'addPlayer':
      teams[payload.teamName] = teams[payload.teamName].filter(p => p.playerName !== payload.playerName);
      break;
    case 'removePlayer':
      if (!teams[payload.teamName]) teams[payload.teamName] = [];
      teams[payload.teamName].push(payload.playerObj);
      break;
    case 'addMatch':
      matches = matches.filter(m => m.matchId !== payload.matchId);
      break;
    case 'removeMatch':
      matches.push(payload.matchObj);
      break;
    case 'updateMatchScore':
      {
        const match = matches.find(m => m.matchId === payload.matchId);
        if (match && match.scores[payload.playerName]) {
          match.scores[payload.playerName].runs -= payload.runs;
          match.scores[payload.playerName].wickets -= payload.wickets;
        }
        for (const team of [payload.teamA, payload.teamB]) {
          if (teams[team]) {
            const player = teams[team].find(p => p.playerName === payload.playerName);
            if (player) {
              player.runs -= payload.runs;
              player.wickets -= payload.wickets;
            }
          }
        }
      }
      break;
    case 'setMatchResult':
      {
        const match = matches.find(m => m.matchId === payload.matchId);
        if (match) {
          match.played = false;
          match.winner = null;
          if (pointsTable[payload.winner]) {
            pointsTable[payload.winner].won -= 1;
            pointsTable[payload.winner].points -= 2;
            pointsTable[payload.winner].played -= 1;
          }
          const loser = match.teamA === payload.winner ? match.teamB : match.teamA;
          if (pointsTable[loser]) {
            pointsTable[loser].lost -= 1;
            pointsTable[loser].played -= 1;
          }
        }
      }
      break;
  }
}
function applyRedo(action, payload) {
  switch (action) {
    case 'addPlayer':
      if (!teams[payload.teamName]) teams[payload.teamName] = [];
      teams[payload.teamName].push({ playerName: payload.playerName, runs: 0, wickets: 0 });
      break;
    case 'removePlayer':
      teams[payload.teamName] = teams[payload.teamName].filter(p => p.playerName !== payload.playerObj.playerName);
      break;
    case 'addMatch':
      matches.push(payload.matchObj);
      break;
    case 'removeMatch':
      matches = matches.filter(m => m.matchId !== payload.matchObj.matchId);
      break;
    case 'updateMatchScore':
      {
        const match = matches.find(m => m.matchId === payload.matchId);
        if (!match.scores[payload.playerName]) match.scores[payload.playerName] = { runs: 0, wickets: 0 };
        match.scores[payload.playerName].runs += payload.runs;
        match.scores[payload.playerName].wickets += payload.wickets;
        for (const team of [payload.teamA, payload.teamB]) {
          if (teams[team]) {
            const player = teams[team].find(p => p.playerName === payload.playerName);
            if (player) {
              player.runs += payload.runs;
              player.wickets += payload.wickets;
            }
          }
        }
      }
      break;
    case 'setMatchResult':
      {
        const match = matches.find(m => m.matchId === payload.matchId);
        if (match) {
          match.played = true;
          match.winner = payload.winner;
          for (const team of [match.teamA, match.teamB]) {
            if (!pointsTable[team]) pointsTable[team] = { played: 0, won: 0, lost: 0, points: 0 };
            pointsTable[team].played += 1;
          }
          pointsTable[payload.winner].won += 1;
          pointsTable[payload.winner].points += 2;
          const loser = match.teamA === payload.winner ? match.teamB : match.teamA;
          pointsTable[loser].lost += 1;
        }
      }
      break;
  }
}

// --- AUTHENTICATION ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    req.session.isAdmin = false;
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.status(403).json({ error: 'Admin authentication required.' });
}

// --- TEAM & PLAYER MANAGEMENT ---
app.post('/api/addPlayer', requireAdmin, (req, res, next) => {
  const { teamName, playerName } = req.body;
  pushHistory('addPlayer', { teamName, playerName });
  next();
}, (req, res) => {
  const { teamName, playerName } = req.body;
  if (!teamName || !playerName) return res.status(400).json({ error: 'Missing data.' });
  if (!teams[teamName]) teams[teamName] = [];
  if (teams[teamName].some(p => p.playerName === playerName)) {
    return res.status(400).json({ error: 'Player already exists in this team.' });
  }
  teams[teamName].push({ playerName, runs: 0, wickets: 0 });
  res.json({ success: true, players: teams[teamName] });
});

app.post('/api/removePlayer', requireAdmin, (req, res, next) => {
  const { teamName, playerName } = req.body;
  const playerObj = teams[teamName]?.find(p => p.playerName === playerName);
  pushHistory('removePlayer', { teamName, playerObj });
  next();
}, (req, res) => {
  const { teamName, playerName } = req.body;
  if (!teamName || !playerName) return res.status(400).json({ error: 'Missing data.' });
  if (!teams[teamName]) return res.status(400).json({ error: 'Team does not exist.' });
  const idx = teams[teamName].findIndex(p => p.playerName === playerName);
  if (idx === -1) return res.status(400).json({ error: 'Player not found in this team.' });
  teams[teamName].splice(idx, 1);
  res.json({ success: true, players: teams[teamName] });
});

app.get('/api/players/:teamName', requireAdmin, (req, res) => {
  const { teamName } = req.params;
  if (!teams[teamName]) return res.json({ players: [] });
  res.json({ players: teams[teamName] });
});

// --- MATCH MANAGEMENT ---
app.post('/api/createMatch', requireAdmin, (req, res, next) => {
  next();
}, (req, res) => {
  const { teamA, teamB, matchDateTime } = req.body;
  if (!teamA || !teamB || !matchDateTime) return res.status(400).json({ error: 'Missing team names or schedule.' });
  const matchId = `match_${matches.length + 1}`;
  const matchObj = {
    matchId,
    teamA,
    teamB,
    matchDateTime,
    played: false,
    winner: null,
    scores: {},
  };
  matches.push(matchObj);
  pushHistory('addMatch', { matchId, matchObj });
  res.json({ matchId });
});

app.post('/api/removeMatch', requireAdmin, (req, res, next) => {
  const { matchId, matchObj } = req.body;
  pushHistory('removeMatch', { matchObj });
  next();
}, (req, res) => {
  const { matchId } = req.body;
  matches = matches.filter(m => m.matchId !== matchId);
  res.json({ success: true });
});

app.post('/api/updateMatchScore', requireAdmin, (req, res, next) => {
  const { matchId, playerName, runs, wickets } = req.body;
  const match = matches.find(m => m.matchId === matchId);
  pushHistory('updateMatchScore', { matchId, playerName, runs, wickets, teamA: match?.teamA, teamB: match?.teamB });
  next();
}, (req, res) => {
  const { matchId, playerName, runs, wickets } = req.body;
  const match = matches.find(m => m.matchId === matchId);
  if (!match) return res.status(404).json({ error: 'Match not found.' });
  if (!playerName) return res.status(400).json({ error: 'Missing player name.' });
  if (!match.scores[playerName]) match.scores[playerName] = { runs: 0, wickets: 0 };
  match.scores[playerName].runs += Number(runs) || 0;
  match.scores[playerName].wickets += Number(wickets) || 0;

  for (const team of [match.teamA, match.teamB]) {
    if (teams[team]) {
      const player = teams[team].find(p => p.playerName === playerName);
      if (player) {
        player.runs += Number(runs) || 0;
        player.wickets += Number(wickets) || 0;
      }
    }
  }
  res.json({ success: true });
});

app.post('/api/setMatchResult', requireAdmin, (req, res, next) => {
  const { matchId, winner } = req.body;
  pushHistory('setMatchResult', { matchId, winner });
  next();
}, (req, res) => {
  const { matchId, winner } = req.body;
  const match = matches.find(m => m.matchId === matchId);
  if (!match) return res.status(404).json({ error: 'Match not found.' });
  if (![match.teamA, match.teamB].includes(winner)) return res.status(400).json({ error: 'Invalid team winner.' });
  match.played = true;
  match.winner = winner;
  for (const team of [match.teamA, match.teamB]) {
    if (!pointsTable[team]) pointsTable[team] = { played: 0, won: 0, lost: 0, points: 0 };
    pointsTable[team].played += 1;
  }
  pointsTable[winner].won += 1;
  pointsTable[winner].points += 2;
  const loser = match.teamA === winner ? match.teamB : match.teamA;
  pointsTable[loser].lost += 1;
  res.json({ success: true });
});

// --- STATS & VIEWER ENDPOINTS ---
app.get('/api/stats', (req, res) => {
  let allPlayers = [];
  Object.entries(teams).forEach(([team, players]) => {
    players.forEach(p => allPlayers.push({ ...p, team }));
  });
  const topBatters = [...allPlayers]
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 5);
  const topBowlers = [...allPlayers]
    .sort((a, b) => b.wickets - a.wickets)
    .slice(0, 5);

  const pointsArr = Object.entries(pointsTable).map(([team, stats]) => ({ team, ...stats }));
  pointsArr.sort((a, b) => b.points - a.points || b.won - a.won);

  const upcoming = matches.filter(m => !m.played).sort((a, b) => new Date(a.matchDateTime) - new Date(b.matchDateTime));
  const finished = matches.filter(m => m.played).sort((a, b) => new Date(b.matchDateTime) - new Date(a.matchDateTime));

  res.json({
    teams,
    matches,
    topBatters,
    topBowlers,
    pointsTable: pointsArr,
    upcomingMatches: upcoming,
    finishedMatches: finished,
  });
});

app.get('/api/team/:teamName', (req, res) => {
  const { teamName } = req.params;
  if (!teams[teamName]) return res.status(404).json({ error: 'Team not found.' });
  res.json({ team: teamName, players: teams[teamName] });
});

app.get('/api/player/:teamName/:playerName', (req, res) => {
  const { teamName, playerName } = req.params;
  if (!teams[teamName]) return res.status(404).json({ error: 'Team not found.' });
  const player = teams[teamName].find(p => p.playerName === playerName);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  res.json(player);
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));