const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'budget.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    parent_id INTEGER,
    code TEXT,
    name TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (parent_id) REFERENCES lines(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS disbursements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    note TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_id INTEGER NOT NULL,
    disbursement_id INTEGER,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (line_id) REFERENCES lines(id) ON DELETE CASCADE,
    FOREIGN KEY (disbursement_id) REFERENCES disbursements(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    link_id INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (line_id) REFERENCES lines(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    disbursement_id INTEGER NOT NULL,
    line_id INTEGER NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (disbursement_id) REFERENCES disbursements(id) ON DELETE CASCADE,
    FOREIGN KEY (line_id) REFERENCES lines(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS allocation_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    disbursement_id INTEGER NOT NULL,
    from_line_id INTEGER NOT NULL,
    to_line_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (disbursement_id) REFERENCES disbursements(id) ON DELETE CASCADE,
    FOREIGN KEY (from_line_id) REFERENCES lines(id) ON DELETE CASCADE,
    FOREIGN KEY (to_line_id) REFERENCES lines(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reserve_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    disbursement_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (disbursement_id) REFERENCES disbursements(id) ON DELETE CASCADE
  );
`);

try { db.exec('ALTER TABLE lines ADD COLUMN code TEXT'); } catch (e) {}
// Migración para bases creadas antes de existir los desembolsos.
try { db.exec('ALTER TABLE executions ADD COLUMN disbursement_id INTEGER'); } catch (e) {}
// Meta de ejecución por desembolso (porcentaje), por defecto 80%.
try { db.exec('ALTER TABLE disbursements ADD COLUMN target_pct REAL DEFAULT 80'); } catch (e) {}
// Enlaza el ajuste de una línea con su ajuste espejo en la otra línea cuando es
// una transferencia, para poder anular los dos juntos.
try { db.exec('ALTER TABLE adjustments ADD COLUMN link_id INTEGER'); } catch (e) {}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SESSION_COOKIE = 'budget_session';
const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function currentUser(req) {
  const token = readCookie(req);
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.username
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.created_at > ?
  `).get(token, Date.now() - SESSION_DAYS * 24 * 60 * 60 * 1000) || null;
}

function setSession(res, userId) {
  db.prepare('DELETE FROM sessions WHERE created_at < ?')
    .run(Date.now() - SESSION_DAYS * 24 * 60 * 60 * 1000);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now());
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  req.user = user;
  next();
}

function parseAmount(value) {
  if (typeof value === 'string') value = value.replace(',', '.');
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Meta de ejecución en porcentaje (0-1000). Por defecto 80.
function parseTargetPct(value, fallback = 80) {
  if (value == null || value === '') return fallback;
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(1000, n);
}

function getOwnedLine(userId, lineId) {
  return db.prepare('SELECT id, name, code FROM lines WHERE id = ? AND user_id = ?').get(lineId, userId);
}

function getOwnedDisbursement(userId, disbursementId) {
  return db.prepare('SELECT * FROM disbursements WHERE id = ? AND user_id = ?').get(disbursementId, userId);
}

function verifyPasswordFor(userId, password) {
  const user = db.prepare('SELECT password FROM users WHERE id = ?').get(userId);
  return !!user && verifyPassword(String(password || ''), user.password);
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  res.json({ user: user ? { id: user.id, username: user.username } : null });
});

app.post('/api/register', (req, res) => {
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  if (username.length < 3) return res.status(400).json({ error: 'El usuario debe tener al menos 3 caracteres' });
  if (password.length < 4) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'El usuario ya existe' });
  }
  const info = db.prepare('INSERT INTO users (username, password, created_at) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), Date.now());
  setSession(res, info.lastInsertRowid);
  res.json({ user: { id: info.lastInsertRowid, username } });
});

app.post('/api/login', (req, res) => {
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  setSession(res, user.id);
  res.json({ user: { id: user.id, username: user.username } });
});

app.post('/api/logout', (req, res) => {
  const token = readCookie(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  clearSession(res);
  res.json({ ok: true });
});

app.get('/api/data', requireAuth, (req, res) => {
  const lines = db.prepare('SELECT * FROM lines WHERE user_id = ? ORDER BY id').all(req.user.id);
  const executions = db.prepare(`
    SELECT e.* FROM executions e JOIN lines l ON l.id = e.line_id
    WHERE l.user_id = ? ORDER BY e.date DESC, e.id DESC
  `).all(req.user.id);
  const adjustments = db.prepare(`
    SELECT a.* FROM adjustments a JOIN lines l ON l.id = a.line_id
    WHERE l.user_id = ? ORDER BY a.date DESC, a.id DESC
  `).all(req.user.id);
  const disbursements = db.prepare(`
    SELECT * FROM disbursements WHERE user_id = ? ORDER BY date, id
  `).all(req.user.id);
  const allocations = db.prepare(`
    SELECT * FROM allocations WHERE user_id = ? ORDER BY id
  `).all(req.user.id);
  const transfers = db.prepare(`
    SELECT * FROM allocation_transfers WHERE user_id = ? ORDER BY created_at DESC, id DESC
  `).all(req.user.id);
  const reserveMoves = db.prepare(`
    SELECT * FROM reserve_moves WHERE user_id = ? ORDER BY created_at DESC, id DESC
  `).all(req.user.id);
  res.json({ lines, executions, adjustments, disbursements, allocations, transfers, reserveMoves });
});

app.post('/api/lines', requireAuth, (req, res) => {
  const { name, amount, parent_id, code } = req.body || {};
  const lineName = String(name || '').trim();
  if (!lineName) return res.status(400).json({ error: 'El nombre de la línea es obligatorio' });
  const amt = parseAmount(amount);
  if (amt === null) return res.status(400).json({ error: 'Monto inválido' });
  if (parent_id != null && parent_id !== '') {
    const parent = getOwnedLine(req.user.id, parent_id);
    if (!parent) return res.status(400).json({ error: 'La línea padre no existe' });
  }
  const lineCode = code ? String(code).trim().toUpperCase() : null;
  const info = db.prepare('INSERT INTO lines (user_id, parent_id, code, name, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, parent_id || null, lineCode, lineName, amt, Date.now());
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/lines/:id', requireAuth, (req, res) => {
  const line = getOwnedLine(req.user.id, req.params.id);
  if (!line) return res.status(404).json({ error: 'Línea no encontrada' });
  const { name, amount, code, parent_id } = req.body || {};
  const lineName = String(name || '').trim();
  if (!lineName) return res.status(400).json({ error: 'El nombre de la línea es obligatorio' });
  const amt = parseAmount(amount);
  if (amt === null) return res.status(400).json({ error: 'Monto inválido' });
  const lineCode = code ? String(code).trim().toUpperCase() : null;
  if (parent_id === line.id) return res.status(400).json({ error: 'Una línea no puede ser padre de sí misma' });
  const newParent = parent_id != null && parent_id !== '' ? Number(parent_id) : null;
  if (newParent) {
    const parent = getOwnedLine(req.user.id, newParent);
    if (!parent) return res.status(400).json({ error: 'La línea padre no existe' });
  }
  db.prepare('UPDATE lines SET name = ?, amount = ?, code = ?, parent_id = ? WHERE id = ? AND user_id = ?')
    .run(lineName, amt, lineCode, newParent, req.params.id, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/lines/:id', requireAuth, (req, res) => {
  if (!verifyPasswordFor(req.user.id, (req.body || {}).password)) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const info = db.prepare('DELETE FROM lines WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Línea no encontrada' });
  res.json({ ok: true });
});

app.delete('/api/data', requireAuth, (req, res) => {
  if (!verifyPasswordFor(req.user.id, (req.body || {}).password)) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const lineIds = db.prepare('SELECT id FROM lines WHERE user_id = ?').all(req.user.id).map(l => l.id);
  db.prepare('DELETE FROM allocations WHERE user_id = ?').run(req.user.id);
  db.prepare('DELETE FROM allocation_transfers WHERE user_id = ?').run(req.user.id);
  db.prepare('DELETE FROM reserve_moves WHERE user_id = ?').run(req.user.id);
  if (lineIds.length) {
    const placeholders = lineIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM executions WHERE line_id IN (${placeholders})`).run(...lineIds);
    db.prepare(`DELETE FROM adjustments WHERE line_id IN (${placeholders})`).run(...lineIds);
    db.prepare('DELETE FROM lines WHERE user_id = ?').run(req.user.id);
  }
  db.prepare('DELETE FROM disbursements WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

app.post('/api/disbursements', requireAuth, (req, res) => {
  const { name, date, amount, note, target_pct } = req.body || {};
  const dName = String(name || '').trim();
  if (!dName) return res.status(400).json({ error: 'El nombre del desembolso es obligatorio' });
  const d = String(date || '').trim();
  if (!d) return res.status(400).json({ error: 'La fecha del desembolso es obligatoria' });
  const amt = parseAmount(amount);
  if (amt === null) return res.status(400).json({ error: 'Monto inválido' });
  const target = parseTargetPct(target_pct);
  const info = db.prepare('INSERT INTO disbursements (user_id, name, date, amount, note, target_pct, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, dName, d, amt, String(note || '').trim() || null, target, Date.now());
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/disbursements/:id', requireAuth, (req, res) => {
  const disb = getOwnedDisbursement(req.user.id, req.params.id);
  if (!disb) return res.status(404).json({ error: 'Desembolso no encontrado' });
  const { name, date, amount, note, target_pct } = req.body || {};
  const dName = String(name || '').trim();
  if (!dName) return res.status(400).json({ error: 'El nombre del desembolso es obligatorio' });
  const d = String(date || '').trim();
  if (!d) return res.status(400).json({ error: 'La fecha del desembolso es obligatoria' });
  const amt = parseAmount(amount);
  if (amt === null) return res.status(400).json({ error: 'Monto inválido' });
  const target = parseTargetPct(target_pct, disb.target_pct != null ? disb.target_pct : 80);
  db.prepare('UPDATE disbursements SET name = ?, date = ?, amount = ?, note = ?, target_pct = ? WHERE id = ? AND user_id = ?')
    .run(dName, d, amt, String(note || '').trim() || null, target, req.params.id, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/disbursements/:id', requireAuth, (req, res) => {
  if (!verifyPasswordFor(req.user.id, (req.body || {}).password)) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const disb = getOwnedDisbursement(req.user.id, req.params.id);
  if (!disb) return res.status(404).json({ error: 'Desembolso no encontrado' });
  // Las ejecuciones y asignaciones de este desembolso pertenecen al propio usuario.
  db.prepare('DELETE FROM allocations WHERE disbursement_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  db.prepare(`
    DELETE FROM executions WHERE disbursement_id = ?
    AND line_id IN (SELECT id FROM lines WHERE user_id = ?)
  `).run(req.params.id, req.user.id);
  db.prepare('DELETE FROM disbursements WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// Libera el saldo no gastado de un desembolso: deja cada asignación en lo
// realmente ejecutado. Lo liberado queda como reserva y se arrastra solo al
// siguiente desembolso. Deja registro en reserve_moves.
app.post('/api/disbursements/:id/release-balance', requireAuth, (req, res) => {
  const disb = getOwnedDisbursement(req.user.id, req.params.id);
  if (!disb) return res.status(404).json({ error: 'Desembolso no encontrado' });

  const allocRows = db.prepare('SELECT line_id, amount FROM allocations WHERE user_id = ? AND disbursement_id = ?')
    .all(req.user.id, disb.id);
  const byLine = new Map();
  for (const r of allocRows) byLine.set(r.line_id, (byLine.get(r.line_id) || 0) + r.amount);
  const execStmt = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM executions WHERE line_id = ? AND disbursement_id = ?');

  const delAllocs = db.prepare('DELETE FROM allocations WHERE user_id = ? AND disbursement_id = ? AND line_id = ?');
  const insAlloc = db.prepare('INSERT INTO allocations (user_id, disbursement_id, line_id, amount, created_at) VALUES (?, ?, ?, ?, ?)');
  const insMove = db.prepare('INSERT INTO reserve_moves (user_id, disbursement_id, amount, note, created_at) VALUES (?, ?, ?, ?, ?)');

  let released = 0;
  const tx = db.transaction(() => {
    for (const [lineId, total] of byLine) {
      const exec = execStmt.get(lineId, disb.id).s;
      const keep = Math.min(total, exec);
      const free = total - keep;
      if (free <= 1e-9) continue;
      released += free;
      delAllocs.run(req.user.id, disb.id, lineId);
      if (keep > 0) insAlloc.run(req.user.id, disb.id, lineId, keep, Date.now());
    }
    if (released > 1e-9) {
      insMove.run(req.user.id, disb.id, released, String((req.body || {}).note || '').trim() || null, Date.now());
    }
  });
  tx();
  res.json({ released });
});

app.post('/api/allocations', requireAuth, (req, res) => {
  const { disbursement_id, line_id, amount } = req.body || {};
  const disb = getOwnedDisbursement(req.user.id, disbursement_id);
  if (!disb) return res.status(400).json({ error: 'El desembolso no existe' });
  const line = getOwnedLine(req.user.id, line_id);
  if (!line) return res.status(400).json({ error: 'La línea no existe' });
  const amt = parseAmount(amount);
  if (amt === null) return res.status(400).json({ error: 'Monto inválido' });
  const info = db.prepare('INSERT INTO allocations (user_id, disbursement_id, line_id, amount, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, disb.id, line.id, amt, Date.now());
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/allocations/:id', requireAuth, (req, res) => {
  const alloc = db.prepare('SELECT id FROM allocations WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!alloc) return res.status(404).json({ error: 'Asignación no encontrada' });
  const amt = parseAmount((req.body || {}).amount);
  if (amt === null) return res.status(400).json({ error: 'Monto inválido' });
  db.prepare('UPDATE allocations SET amount = ? WHERE id = ? AND user_id = ?').run(amt, req.params.id, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/allocations/:id', requireAuth, (req, res) => {
  if (!verifyPasswordFor(req.user.id, (req.body || {}).password)) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const info = db.prepare('DELETE FROM allocations WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Asignación no encontrada' });
  res.json({ ok: true });
});

// Mover dinero ya asignado de una línea a otra dentro del mismo desembolso.
// No borra gastos: solo reajusta el reparto, por eso no pide contraseña.
app.post('/api/allocations/transfer', requireAuth, (req, res) => {
  const { disbursement_id, from_line_id, to_line_id, amount, note } = req.body || {};
  const disb = getOwnedDisbursement(req.user.id, disbursement_id);
  if (!disb) return res.status(400).json({ error: 'El desembolso no existe' });
  const fromLine = getOwnedLine(req.user.id, from_line_id);
  const toLine = getOwnedLine(req.user.id, to_line_id);
  if (!fromLine || !toLine) return res.status(400).json({ error: 'La línea no existe' });
  if (fromLine.id === toLine.id) return res.status(400).json({ error: 'Elige dos líneas distintas' });
  const amt = parseAmount(amount);
  if (amt === null || amt <= 0) return res.status(400).json({ error: 'Monto inválido' });

  const readAllocs = db.prepare('SELECT amount FROM allocations WHERE user_id = ? AND disbursement_id = ? AND line_id = ?');
  const fromTotal = readAllocs.all(req.user.id, disb.id, fromLine.id).reduce((s, r) => s + r.amount, 0);
  const toTotal = readAllocs.all(req.user.id, disb.id, toLine.id).reduce((s, r) => s + r.amount, 0);
  const exec = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM executions WHERE line_id = ? AND disbursement_id = ?')
    .get(fromLine.id, disb.id).s;
  const available = fromTotal - exec;
  if (amt > available + 1e-9) {
    return res.status(400).json({ error: `En esa línea solo tienes ${available.toFixed(2)} sin gastar para mover` });
  }

  const delAllocs = db.prepare('DELETE FROM allocations WHERE user_id = ? AND disbursement_id = ? AND line_id = ?');
  const insAlloc = db.prepare('INSERT INTO allocations (user_id, disbursement_id, line_id, amount, created_at) VALUES (?, ?, ?, ?, ?)');
  const insTransfer = db.prepare('INSERT INTO allocation_transfers (user_id, disbursement_id, from_line_id, to_line_id, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const tx = db.transaction(() => {
    // Origen: dejar una sola fila con lo que queda sin mover.
    const rest = fromTotal - amt;
    delAllocs.run(req.user.id, disb.id, fromLine.id);
    if (rest > 0) insAlloc.run(req.user.id, disb.id, fromLine.id, rest, Date.now());
    // Destino: consolidar en una sola fila el total anterior más lo recibido.
    delAllocs.run(req.user.id, disb.id, toLine.id);
    insAlloc.run(req.user.id, disb.id, toLine.id, toTotal + amt, Date.now());
    // Deja registro del ajuste para poder explicarlo después.
    insTransfer.run(req.user.id, disb.id, fromLine.id, toLine.id, amt, String(note || '').trim() || null, Date.now());
  });
  tx();
  res.json({ ok: true });
});

// Deshace un ajuste de reparto (traslado entre líneas): devuelve el monto a la
// línea de origen y se lo quita a la de destino. No toca los gastos ya registrados.
app.delete('/api/allocations/transfers/:id', requireAuth, (req, res) => {
  if (!verifyPasswordFor(req.user.id, (req.body || {}).password)) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const t = db.prepare('SELECT * FROM allocation_transfers WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ error: 'Ajuste de reparto no encontrado' });
  const fromLine = getOwnedLine(req.user.id, t.from_line_id);
  const toLine = getOwnedLine(req.user.id, t.to_line_id);
  if (!fromLine || !toLine) return res.status(400).json({ error: 'La línea ya no existe' });

  const readAllocs = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM allocations WHERE user_id = ? AND disbursement_id = ? AND line_id = ?');
  const fromTotal = readAllocs.get(req.user.id, t.disbursement_id, t.from_line_id).s;
  const toTotal = readAllocs.get(req.user.id, t.disbursement_id, t.to_line_id).s;
  const newFrom = fromTotal + t.amount;
  const newTo = toTotal - t.amount;
  if (newTo < -1e-9) {
    return res.status(400).json({ error: `No se puede deshacer: «${toLine.name}» ya no tiene ese saldo asignado.` });
  }

  const delAllocs = db.prepare('DELETE FROM allocations WHERE user_id = ? AND disbursement_id = ? AND line_id = ?');
  const insAlloc = db.prepare('INSERT INTO allocations (user_id, disbursement_id, line_id, amount, created_at) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    delAllocs.run(req.user.id, t.disbursement_id, t.from_line_id);
    if (newFrom > 0) insAlloc.run(req.user.id, t.disbursement_id, t.from_line_id, newFrom, Date.now());
    delAllocs.run(req.user.id, t.disbursement_id, t.to_line_id);
    if (newTo > 0) insAlloc.run(req.user.id, t.disbursement_id, t.to_line_id, newTo, Date.now());
    db.prepare('DELETE FROM allocation_transfers WHERE id = ? AND user_id = ?').run(t.id, req.user.id);
  })();
  res.json({ ok: true, reverted: t.amount });
});

app.post('/api/executions', requireAuth, (req, res) => {
  const { line_id, date, amount, note, disbursement_id } = req.body || {};
  const line = getOwnedLine(req.user.id, line_id);
  if (!line) return res.status(400).json({ error: 'La línea no existe' });
  const amt = parseAmount(amount);
  if (amt === null) return res.status(400).json({ error: 'Monto inválido' });
  const d = String(date || '').trim();
  if (!d) return res.status(400).json({ error: 'La fecha es obligatoria' });
  let disbId = null;
  if (disbursement_id != null && disbursement_id !== '') {
    const disb = getOwnedDisbursement(req.user.id, disbursement_id);
    if (!disb) return res.status(400).json({ error: 'El desembolso no existe' });
    disbId = disb.id;
  }
  const info = db.prepare('INSERT INTO executions (line_id, disbursement_id, date, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(line_id, disbId, d, amt, String(note || '').trim() || null, Date.now());
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/executions/:id', requireAuth, (req, res) => {
  if (!verifyPasswordFor(req.user.id, (req.body || {}).password)) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const info = db.prepare(`
    DELETE FROM executions WHERE id = ?
    AND line_id IN (SELECT id FROM lines WHERE user_id = ?)
  `).run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Movimiento no encontrado' });
  res.json({ ok: true });
});

app.post('/api/adjustments', requireAuth, (req, res) => {
  const { line_id, date, amount, note, dest_line_id } = req.body || {};
  const line = getOwnedLine(req.user.id, line_id);
  if (!line) return res.status(400).json({ error: 'La línea no existe' });
  const amt = parseAmount(amount);
  if (amt === null) return res.status(400).json({ error: 'Monto inválido' });
  const d = String(date || '').trim();
  if (!d) return res.status(400).json({ error: 'El ajuste requiere una fecha obligatoria' });
  const baseNote = String(note || '').trim() || null;

  // Si viene una línea destino, el ajuste es una transferencia: se crean dos
  // ajustes enlazados (origen +monto y destino −monto) que se anulan juntos.
  let dest = null;
  if (dest_line_id != null && dest_line_id !== '') {
    dest = getOwnedLine(req.user.id, dest_line_id);
    if (!dest) return res.status(400).json({ error: 'La línea destino no existe' });
    if (Number(dest.id) === Number(line.id)) {
      return res.status(400).json({ error: 'Elige dos líneas distintas para la transferencia' });
    }
  }

  const insSingle = db.prepare('INSERT INTO adjustments (line_id, date, amount, note, link_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)');
  const insLinked = db.prepare('INSERT INTO adjustments (line_id, date, amount, note, link_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const info = db.transaction(() => {
    if (!dest) return insSingle.run(line.id, d, amt, baseNote, Date.now());
    const link = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    const srcName = line.code || line.name;
    const destNote = (baseNote ? baseNote + ' → ' : '') + 'Transferido desde ' + srcName;
    insLinked.run(line.id, d, amt, baseNote, link, Date.now());
    return insLinked.run(dest.id, d, -amt, destNote, link, Date.now());
  })();
  res.json({ id: info.lastInsertRowid, linked: !!dest });
});

app.delete('/api/adjustments/:id', requireAuth, (req, res) => {
  if (!verifyPasswordFor(req.user.id, (req.body || {}).password)) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const adj = db.prepare(`
    SELECT a.id, a.link_id FROM adjustments a
    JOIN lines l ON l.id = a.line_id
    WHERE a.id = ? AND l.user_id = ?
  `).get(req.params.id, req.user.id);
  if (!adj) return res.status(404).json({ error: 'Movimiento no encontrado' });
  let changes;
  if (adj.link_id != null) {
    // Ajuste de transferencia: se borra también el ajuste espejo de la otra línea.
    changes = db.prepare(`
      DELETE FROM adjustments WHERE link_id = ?
      AND line_id IN (SELECT id FROM lines WHERE user_id = ?)
    `).run(adj.link_id, req.user.id).changes;
  } else {
    changes = db.prepare(`
      DELETE FROM adjustments WHERE id = ?
      AND line_id IN (SELECT id FROM lines WHERE user_id = ?)
    `).run(adj.id, req.user.id).changes;
  }
  res.json({ ok: true, deleted: changes });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Budget dashboard en http://localhost:${PORT}`));
