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
  res.json({ success: true, players: teams[teamName] });
});

app.post('/api/removePlayer', requireAdmin, (req, res) => {
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
app.post('/api/createMatch', requireAdmin, (req, res) => {
  const { teamA, teamB, matchDateTime } = req.body;
  if (!teamA || !teamB || !matchDateTime) return res.status(400).json({ error: 'Missing team names or schedule.' });
  const matchId = `match_${matches.length + 1}`;
  matches.push({
    matchId,
    teamA,
    teamB,
    matchDateTime,
    played: false,
    winner: null,
    scores: {}, // { playerName: { runs, wickets } }
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

// Set winner and mark match as played (admin)
app.post('/api/setMatchResult', requireAdmin, (req, res) => {
  const { matchId, winner } = req.body;
  const match = matches.find(m => m.matchId === matchId);
  if (!match) return res.status(404).json({ error: 'Match not found.' });
  if (![match.teamA, match.teamB].includes(winner)) return res.status(400).json({ error: 'Invalid team winner.' });
  match.played = true;
  match.winner = winner;
  // Update points table
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
  // Calculate all players with team info
  let allPlayers = [];
  Object.entries(teams).forEach(([team, players]) => {
    players.forEach(p => allPlayers.push({ ...p, team }));
  });
  // Top 5 batters (by runs)
  const topBatters = [...allPlayers]
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 5);
  // Top 5 bowlers (by wickets)
  const topBowlers = [...allPlayers]
    .sort((a, b) => b.wickets - a.wickets)
    .slice(0, 5);

  // Points table sorted by points desc
  const pointsArr = Object.entries(pointsTable).map(([team, stats]) => ({ team, ...stats }));
  pointsArr.sort((a, b) => b.points - a.points || b.won - a.won);

  // Matches split
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