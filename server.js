const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5173;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

app.use(express.json({ limit: '1mb' }));

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

// API: Load state
app.get('/api/state', (req, res) => {
  try {
    if (!fs.existsSync(DATA_FILE)) return res.status(204).end();
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    return res.json(data);
  } catch (err) {
    console.error('Failed to read state:', err);
    return res.status(500).json({ error: 'Failed to read state' });
  }
});

// API: Save state
app.post('/api/state', (req, res) => {
  const state = req.body;
  try {
    if (!state || typeof state !== 'object') {
      return res.status(400).json({ error: 'Invalid state' });
    }
    // Basic validation to avoid writing junk
    if (!('version' in state)) state.version = 1;
    if (!Array.isArray(state.events)) state.events = [];
    if (!Array.isArray(state.todos)) state.todos = [];
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
    return res.status(204).end();
  } catch (err) {
    console.error('Failed to write state:', err);
    return res.status(500).json({ error: 'Failed to write state' });
  }
});

// Serve static files
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

