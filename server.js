require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const bcrypt = require('bcryptjs');
const { Client: SSHClient } = require('ssh2');

const {
  ensureAdminUser,
  findUser,
  listServers,
  createServer,
  updateServer,
  deleteServer,
  getServerWithSecret,
} = require('./db');

ensureAdminUser();

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 }, // 8 hours
});
app.use(sessionMiddleware);

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// ---------- Auth routes ----------

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const user = findUser(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ ok: true, username: user.username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({ authenticated: true, username: req.session.username });
  }
  res.json({ authenticated: false });
});

// ---------- VPS server management ----------

app.get('/api/servers', requireAuth, (req, res) => {
  res.json(listServers());
});

app.post('/api/servers', requireAuth, (req, res) => {
  const { name, host, port, username, auth_type, password, privateKey, passphrase } = req.body || {};
  if (!name || !host || !username) {
    return res.status(400).json({ error: 'name, host, and username are required' });
  }
  const secretPayload =
    auth_type === 'key' ? { privateKey, passphrase } : { password };

  try {
    const id = createServer({ name, host, port, username, auth_type, secretPayload });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/servers/:id', requireAuth, (req, res) => {
  const { name, host, port, username, auth_type, password, privateKey, passphrase } = req.body || {};
  let secretPayload = null;
  if (password || privateKey) {
    secretPayload = auth_type === 'key' ? { privateKey, passphrase } : { password };
  }
  try {
    updateServer(req.params.id, { name, host, port, username, auth_type, secretPayload });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/servers/:id', requireAuth, (req, res) => {
  deleteServer(req.params.id);
  res.json({ ok: true });
});

// ---------- SFTP file management ----------
// Helper: open an SFTP session for a given server id, run a callback, then close it.

function withSftp(serverId, callback) {
  const conf = getServerWithSecret(serverId);
  if (!conf) return callback(new Error('Server not found'));

  const conn = new SSHClient();
  conn
    .on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          return callback(err);
        }
        callback(null, sftp, () => conn.end());
      });
    })
    .on('error', (err) => callback(err))
    .connect(buildConnectConfig(conf));
}

function buildConnectConfig(conf) {
  const base = {
    host: conf.host,
    port: conf.port || 22,
    username: conf.username,
    readyTimeout: 15000,
  };
  if (conf.auth_type === 'key') {
    return { ...base, privateKey: conf.secret.privateKey, passphrase: conf.secret.passphrase || undefined };
  }
  return { ...base, password: conf.secret.password };
}

app.get('/api/servers/:id/files', requireAuth, (req, res) => {
  const dirPath = req.query.path || '.';
  withSftp(req.params.id, (err, sftp, close) => {
    if (err) return res.status(500).json({ error: err.message });
    sftp.readdir(dirPath, (err2, list) => {
      close();
      if (err2) return res.status(500).json({ error: err2.message });
      const entries = list.map((item) => ({
        name: item.filename,
        isDirectory: (item.attrs.mode & 0o170000) === 0o040000,
        size: item.attrs.size,
        modifyTime: item.attrs.mtime * 1000,
      }));
      res.json({ path: dirPath, entries });
    });
  });
});

app.get('/api/servers/:id/file-content', requireAuth, (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path is required' });
  withSftp(req.params.id, (err, sftp, close) => {
    if (err) return res.status(500).json({ error: err.message });
    const chunks = [];
    const stream = sftp.createReadStream(filePath);
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      close();
      res.json({ path: filePath, content: Buffer.concat(chunks).toString('utf8') });
    });
    stream.on('error', (e) => {
      close();
      res.status(500).json({ error: e.message });
    });
  });
});

app.put('/api/servers/:id/file-content', requireAuth, (req, res) => {
  const { path: filePath, content } = req.body || {};
  if (!filePath) return res.status(400).json({ error: 'path is required' });
  withSftp(req.params.id, (err, sftp, close) => {
    if (err) return res.status(500).json({ error: err.message });
    const stream = sftp.createWriteStream(filePath);
    stream.on('close', () => {
      close();
      res.json({ ok: true });
    });
    stream.on('error', (e) => {
      close();
      res.status(500).json({ error: e.message });
    });
    stream.end(content || '');
  });
});

app.post('/api/servers/:id/mkdir', requireAuth, (req, res) => {
  const { path: dirPath } = req.body || {};
  withSftp(req.params.id, (err, sftp, close) => {
    if (err) return res.status(500).json({ error: err.message });
    sftp.mkdir(dirPath, (e) => {
      close();
      if (e) return res.status(500).json({ error: e.message });
      res.json({ ok: true });
    });
  });
});

app.post('/api/servers/:id/rename', requireAuth, (req, res) => {
  const { from, to } = req.body || {};
  withSftp(req.params.id, (err, sftp, close) => {
    if (err) return res.status(500).json({ error: err.message });
    sftp.rename(from, to, (e) => {
      close();
      if (e) return res.status(500).json({ error: e.message });
      res.json({ ok: true });
    });
  });
});

app.delete('/api/servers/:id/file', requireAuth, (req, res) => {
  const filePath = req.query.path;
  const isDir = req.query.isDirectory === 'true';
  withSftp(req.params.id, (err, sftp, close) => {
    if (err) return res.status(500).json({ error: err.message });
    const done = (e) => {
      close();
      if (e) return res.status(500).json({ error: e.message });
      res.json({ ok: true });
    };
    if (isDir) sftp.rmdir(filePath, done);
    else sftp.unlink(filePath, done);
  });
});

// ---------- Socket.io: live SSH terminal ----------
// Share the express session with socket.io so only logged-in users can open a shell.

io.engine.use(sessionMiddleware);

io.on('connection', (socket) => {
  const session = socket.request.session;
  if (!session || !session.userId) {
    socket.emit('term-error', 'Not authenticated');
    socket.disconnect(true);
    return;
  }

  let sshConn = null;
  let sshStream = null;

  socket.on('ssh-connect', ({ serverId, cols, rows }) => {
    const conf = getServerWithSecret(serverId);
    if (!conf) {
      socket.emit('term-error', 'Server not found');
      return;
    }

    sshConn = new SSHClient();
    sshConn
      .on('ready', () => {
        sshConn.shell({ cols: cols || 80, rows: rows || 24 }, (err, stream) => {
          if (err) {
            socket.emit('term-error', err.message);
            return;
          }
          sshStream = stream;
          socket.emit('term-ready');

          stream.on('data', (data) => socket.emit('term-data', data.toString('utf8')));
          stream.stderr.on('data', (data) => socket.emit('term-data', data.toString('utf8')));
          stream.on('close', () => {
            socket.emit('term-closed');
            sshConn.end();
          });
        });
      })
      .on('error', (err) => socket.emit('term-error', err.message))
      .connect(buildConnectConfig(conf));
  });

  socket.on('term-input', (data) => {
    if (sshStream) sshStream.write(data);
  });

  socket.on('term-resize', ({ cols, rows }) => {
    if (sshStream) sshStream.setWindow(rows, cols, 0, 0);
  });

  socket.on('disconnect', () => {
    if (sshConn) sshConn.end();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`VPS Monitor running at http://localhost:${PORT}`);
});
