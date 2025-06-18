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

// Simple admin credentials
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'password123';

// In-memory DB
let teams = {}; // { teamName: [{playerName, runs, wickets}] }
let matches = []; // [{matchId, teamA, teamB, scores: {playerName: {runs, wickets}}, manOfMatch}]

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
app.post('/api/addPlayer', requireAdmin, (req, res) => {
  const { teamName, playerName } = req.body;
  if (!teamName || !playerName) return res.status(400).json({ error: 'Missing data.' });
  if (!teams[teamName]) teams[teamName] = [];
  if (teams[teamName].some(p => p.playerName === playerName)) {
    return res.status(400).json({ error: 'Player already exists in this team.' });
  }
  teams[teamName].push({ playerName, runs: 0, wickets: 0 });
  res.json({ success: true });
});

// --- MATCH MANAGEMENT ---
app.post('/api/createMatch', requireAdmin, (req, res) => {
  const { teamA, teamB } = req.body;
  if (!teamA || !teamB) return res.status(400).json({ error: 'Missing team names.' });
  const matchId = `match_${matches.length + 1}`;
  matches.push({
    matchId,
    teamA,
    teamB,
    scores: {}, // { playerName: { runs, wickets } }
    manOfMatch: null,
  });
  res.json({ matchId });
});

app.post('/api/updateMatchScore', requireAdmin, (req, res) => {
  const { matchId, playerName, runs, wickets } = req.body;
  const match = matches.find(m => m.matchId === matchId);
  if (!match) return res.status(404).json({ error: 'Match not found.' });
  if (!playerName) return res.status(400).json({ error: 'Missing player name.' });
  if (!match.scores[playerName]) match.scores[playerName] = { runs: 0, wickets: 0 };
  match.scores[playerName].runs += Number(runs) || 0;
  match.scores[playerName].wickets += Number(wickets) || 0;

  // Update global stats
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

app.post('/api/setManOfMatch', requireAdmin, (req, res) => {
  const { matchId, playerName } = req.body;
  const match = matches.find(m => m.matchId === matchId);
  if (!match) return res.status(404).json({ error: 'Match not found.' });
  match.manOfMatch = playerName;
  res.json({ success: true });
});

// --- STATS & VIEWER ENDPOINTS ---
app.get('/api/stats', (req, res) => {
  // Calculate best batsman/bowler overall
  let allPlayers = [];
  Object.values(teams).forEach(players => allPlayers.push(...players));
  const bestBatsman = allPlayers.reduce((a, b) => (a.runs > b.runs ? a : b), { runs: -1 });
  const bestBowler = allPlayers.reduce((a, b) => (a.wickets > b.wickets ? a : b), { wickets: -1 });
  res.json({
    teams,
    bestBatsman,
    bestBowler,
    matches,
  });
});

app.get('/api/manOfTheMatch/:matchId', (req, res) => {
  const match = matches.find(m => m.matchId === req.params.matchId);
  if (!match) return res.status(404).json({ error: 'Match not found.' });
  if (!match.manOfMatch) return res.json({ message: 'Man of the Match not set yet.' });
  res.json({ manOfMatch: match.manOfMatch });
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));