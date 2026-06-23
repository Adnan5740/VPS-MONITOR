const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'data.sqlite');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'password',
  secret_enc TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- Encryption helpers (AES-256-GCM) ----------

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY must be set in .env as a 64-character hex string (32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

function encryptSecret(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store iv + authTag + ciphertext together, base64 encoded
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decryptSecret(blobBase64) {
  const key = getKey();
  const buf = Buffer.from(blobBase64, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

// ---------- Users ----------

function ensureAdminUser() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  console.log(`Created initial admin user "${username}". Change the password after logging in by editing the database, or recreate the user.`);
}

function findUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

// ---------- Servers ----------

function listServers() {
  const rows = db.prepare('SELECT id, name, host, port, username, auth_type, created_at FROM servers ORDER BY id DESC').all();
  return rows; // never expose secret_enc to the client
}

function getServerRaw(id) {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
}

// secretPayload is an object like { password: '...' } or { privateKey: '...', passphrase: '...' }
function createServer({ name, host, port, username, auth_type, secretPayload }) {
  const secret_enc = encryptSecret(JSON.stringify(secretPayload));
  const stmt = db.prepare(`
    INSERT INTO servers (name, host, port, username, auth_type, secret_enc)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(name, host, port || 22, username, auth_type || 'password', secret_enc);
  return info.lastInsertRowid;
}

function updateServer(id, { name, host, port, username, auth_type, secretPayload }) {
  if (secretPayload) {
    const secret_enc = encryptSecret(JSON.stringify(secretPayload));
    db.prepare(`
      UPDATE servers SET name = ?, host = ?, port = ?, username = ?, auth_type = ?, secret_enc = ?
      WHERE id = ?
    `).run(name, host, port || 22, username, auth_type || 'password', secret_enc, id);
  } else {
    db.prepare(`
      UPDATE servers SET name = ?, host = ?, port = ?, username = ?, auth_type = ?
      WHERE id = ?
    `).run(name, host, port || 22, username, auth_type || 'password', id);
  }
}

function deleteServer(id) {
  db.prepare('DELETE FROM servers WHERE id = ?').run(id);
}

// Returns connection details with decrypted secret, for internal use only (SSH/SFTP connect)
function getServerWithSecret(id) {
  const row = getServerRaw(id);
  if (!row) return null;
  const secret = JSON.parse(decryptSecret(row.secret_enc));
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    auth_type: row.auth_type,
    secret, // { password } or { privateKey, passphrase }
  };
}

module.exports = {
  db,
  ensureAdminUser,
  findUser,
  listServers,
  createServer,
  updateServer,
  deleteServer,
  getServerWithSecret,
};
