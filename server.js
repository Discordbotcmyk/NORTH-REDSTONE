require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// Pull environment variables with fallback defaults
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || process.env.CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-.env';

const ADMIN_USERNAMES = ['bblego4', 'llucasxxx', 'devin_920', 'itskingjackson'].map(u => u.toLowerCase());

// IMPORTANT: the app runs behind a reverse proxy (Render/Heroku/etc. — that's
// why getRedirectUri() reads x-forwarded-proto/x-forwarded-host). Without this,
// Express never sees the connection as HTTPS, so the "secure" session cookie
// below silently fails to be set/read after the Discord OAuth redirect. That
// was the cause of "login succeeds but the site still shows logged-out" —
// the session cookie just wasn't sticking.
app.set('trust proxy', 1);

function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    writeData({
      changelogs: [],
      guidelines: { game: [], discord: [] },
    });
  }
}

function readData() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// Helper function to build exact redirect_uri based on current request
function getRedirectUri(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}/auth/discord/callback`;
}

// Middleware
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

// Serve only a dedicated public/ folder for static assets (CSS/JS/images you
// add yourself later). Previously the whole project directory (__dirname) was
// served statically, which meant server.js and data.json were publicly
// downloadable at /server.js and /data.json. That's removed now.
app.use(express.static(path.join(__dirname, 'public')));

function isAdminUser(discordUser) {
  return ADMIN_USERNAMES.includes((discordUser.username || '').toLowerCase());
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// Explicit Root Route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// OAuth Routes
app.get('/auth/discord', (req, res) => {
  if (!DISCORD_CLIENT_ID) {
    return res.status(500).json({ error: 'DISCORD_CLIENT_ID is missing from server environment.' });
  }

  const redirectUri = getRedirectUri(req);

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?login=failed');

  const redirectUri = getRedirectUri(req);

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const errorDetails = await tokenRes.text();
      console.error('Discord Token Exchange Error Details:', errorDetails);
      throw new Error(`Token exchange failed with status ${tokenRes.status}`);
    }

    const tokenData = await tokenRes.json();

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userRes.ok) throw new Error('Failed to fetch Discord user');
    const discordUser = await userRes.json();

    req.session.user = {
      id: discordUser.id,
      username: discordUser.username,
      avatar: discordUser.avatar,
      isAdmin: isAdminUser(discordUser),
    };

    // Make sure the session is actually flushed to the store before we
    // redirect back — otherwise on some proxies/hosts the browser can land
    // back on '/' and hit /api/session before the write finishes.
    req.session.save(err => {
      if (err) console.error('Session save error:', err);
      res.redirect('/');
    });
  } catch (err) {
    console.error('Discord OAuth error:', err);
    res.redirect('/?login=failed');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// API Routes
app.get('/api/session', (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  const { username, isAdmin } = req.session.user;
  res.json({ loggedIn: true, username, isAdmin });
});

app.get('/api/changelogs', (req, res) => {
  const data = readData();
  res.json(data.changelogs);
});

app.post('/api/changelogs', requireAdmin, (req, res) => {
  const { title, date, bullets, note } = req.body;
  if (!title || !date || !Array.isArray(bullets) || bullets.length === 0) {
    return res.status(400).json({ error: 'title, date, and at least one bullet are required.' });
  }
  const data = readData();
  const entry = {
    id: 'log-' + Date.now(),
    title: String(title).slice(0, 120),
    date: String(date),
    bullets: bullets.map(b => String(b).slice(0, 300)).slice(0, 50),
    note: note ? String(note).slice(0, 500) : '',
  };
  data.changelogs.unshift(entry);
  writeData(data);
  res.json(data.changelogs);
});

app.patch('/api/changelogs/:id', requireAdmin, (req, res) => {
  const { note } = req.body;
  const data = readData();
  const entry = data.changelogs.find(c => c.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Change log entry not found.' });
  entry.note = note ? String(note).slice(0, 500) : '';
  writeData(data);
  res.json(data.changelogs);
});

app.delete('/api/changelogs/:id', requireAdmin, (req, res) => {
  const data = readData();
  data.changelogs = data.changelogs.filter(c => c.id !== req.params.id);
  writeData(data);
  res.json(data.changelogs);
});

app.get('/api/guidelines', (req, res) => {
  const data = readData();
  res.json(data.guidelines);
});

app.put('/api/guidelines', requireAdmin, (req, res) => {
  const { game, discord } = req.body;
  if (!Array.isArray(game) || !Array.isArray(discord)) {
    return res.status(400).json({ error: 'game and discord must be arrays of {title, description}.' });
  }
  const clean = arr =>
    arr
      .filter(r => r && r.title)
      .map(r => ({
        title: String(r.title).slice(0, 150),
        description: String(r.description || '').slice(0, 1000),
      }));
  const data = readData();
  data.guidelines = { game: clean(game), discord: clean(discord) };
  writeData(data);
  res.json(data.guidelines);
});

ensureDataFile();

app.listen(PORT, () => {
  console.log(`North Redstone Community server running on port ${PORT}`);
});
