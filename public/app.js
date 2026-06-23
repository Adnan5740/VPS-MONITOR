// ---------- State ----------
let servers = [];
let activeServerId = null;
let term = null;
let fitAddon = null;
let socket = null;
let currentFilePath = '.';
let editingFilePath = null;

// ---------- Helpers ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

// ---------- Auth ----------
async function checkAuth() {
  const me = await api('GET', '/api/me');
  if (me.authenticated) {
    document.getElementById('current-user').textContent = me.username;
    hide(document.getElementById('login-screen'));
    show(document.getElementById('app-screen'));
    await loadServers();
  } else {
    show(document.getElementById('login-screen'));
    hide(document.getElementById('app-screen'));
  }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  try {
    await api('POST', '/api/login', { username, password });
    await checkAuth();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  activeServerId = null;
  if (socket) socket.disconnect();
  location.reload();
});

// ---------- Server list ----------
async function loadServers() {
  servers = await api('GET', '/api/servers');
  renderServerList();
}

function renderServerList() {
  const list = document.getElementById('server-list');
  list.innerHTML = '';
  servers.forEach((s) => {
    const div = document.createElement('div');
    div.className = 'server-item' + (s.id === activeServerId ? ' active' : '');
    div.innerHTML = `${escapeHtml(s.name)}<span class="host">${escapeHtml(s.username)}@${escapeHtml(s.host)}:${s.port}</span>`;
    div.addEventListener('click', () => selectServer(s.id));
    list.appendChild(div);
  });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

function getServer(id) {
  return servers.find((s) => s.id === id);
}

async function selectServer(id) {
  activeServerId = id;
  renderServerList();
  hide(document.getElementById('empty-state'));
  show(document.getElementById('server-view'));

  const s = getServer(id);
  document.getElementById('server-view-title').textContent = `${s.username}@${s.host}:${s.port}`;

  // Default to terminal tab
  switchTab('terminal');
  connectTerminal(id);
  currentFilePath = '.';
}

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('tab-terminal').classList.toggle('hidden', tab !== 'terminal');
  document.getElementById('tab-files').classList.toggle('hidden', tab !== 'files');
  if (tab === 'files') loadFiles(currentFilePath);
  if (tab === 'terminal' && fitAddon) setTimeout(() => fitAddon.fit(), 50);
}

// ---------- Terminal ----------
function ensureTerminal() {
  if (term) return;
  term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    theme: { background: '#0f1117' },
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('terminal-container'));
  fitAddon.fit();
  window.addEventListener('resize', () => {
    if (fitAddon) fitAddon.fit();
    if (socket && term) socket.emit('term-resize', { cols: term.cols, rows: term.rows });
  });
  term.onData((data) => {
    if (socket) socket.emit('term-input', data);
  });
}

function connectTerminal(serverId) {
  ensureTerminal();
  term.reset();
  term.writeln('Connecting...');

  if (socket) socket.disconnect();
  socket = io();

  socket.on('connect', () => {
    socket.emit('ssh-connect', { serverId, cols: term.cols, rows: term.rows });
  });
  socket.on('term-ready', () => {
    term.reset();
  });
  socket.on('term-data', (data) => term.write(data));
  socket.on('term-error', (msg) => term.writeln(`\r\n[error] ${msg}`));
  socket.on('term-closed', () => term.writeln('\r\n[connection closed]'));
}

// ---------- File manager ----------
async function loadFiles(dirPath) {
  currentFilePath = dirPath;
  document.getElementById('file-path').textContent = dirPath;
  const body = document.getElementById('file-table-body');
  body.innerHTML = '<tr><td colspan="4">Loading...</td></tr>';
  try {
    const data = await api('GET', `/api/servers/${activeServerId}/files?path=${encodeURIComponent(dirPath)}`);
    renderFileTable(data.entries);
  } catch (err) {
    body.innerHTML = `<tr><td colspan="4">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderFileTable(entries) {
  const body = document.getElementById('file-table-body');
  body.innerHTML = '';
  entries
    .slice()
    .sort((a, b) => (b.isDirectory - a.isDirectory) || a.name.localeCompare(b.name))
    .forEach((entry) => {
      const tr = document.createElement('tr');
      const sizeText = entry.isDirectory ? '-' : formatBytes(entry.size);
      const modText = entry.modifyTime ? new Date(entry.modifyTime).toLocaleString() : '-';
      tr.innerHTML = `
        <td><span class="file-name ${entry.isDirectory ? 'dir' : ''}">${entry.isDirectory ? '📁' : '📄'} ${escapeHtml(entry.name)}</span></td>
        <td>${sizeText}</td>
        <td>${modText}</td>
        <td class="file-actions">
          <button data-action="rename">Rename</button>
          <button data-action="delete">Delete</button>
        </td>
      `;
      tr.querySelector('.file-name').addEventListener('click', () => {
        const fullPath = joinPath(currentFilePath, entry.name);
        if (entry.isDirectory) loadFiles(fullPath);
        else openFileEditor(fullPath);
      });
      tr.querySelector('[data-action="rename"]').addEventListener('click', () => renameEntry(entry));
      tr.querySelector('[data-action="delete"]').addEventListener('click', () => deleteEntry(entry));
      body.appendChild(tr);
    });
}

function joinPath(base, name) {
  if (base === '.' || base === '') return name;
  return base.endsWith('/') ? base + name : base + '/' + name;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

document.getElementById('file-up-btn').addEventListener('click', () => {
  if (currentFilePath === '.' || currentFilePath === '/') return;
  const parts = currentFilePath.split('/').filter(Boolean);
  parts.pop();
  loadFiles(parts.length ? '/' + parts.join('/') : '.');
});
document.getElementById('file-refresh-btn').addEventListener('click', () => loadFiles(currentFilePath));
document.getElementById('file-new-folder-btn').addEventListener('click', async () => {
  const name = prompt('New folder name:');
  if (!name) return;
  try {
    await api('POST', `/api/servers/${activeServerId}/mkdir`, { path: joinPath(currentFilePath, name) });
    loadFiles(currentFilePath);
  } catch (err) {
    alert(err.message);
  }
});

async function renameEntry(entry) {
  const newName = prompt('Rename to:', entry.name);
  if (!newName || newName === entry.name) return;
  try {
    await api('POST', `/api/servers/${activeServerId}/rename`, {
      from: joinPath(currentFilePath, entry.name),
      to: joinPath(currentFilePath, newName),
    });
    loadFiles(currentFilePath);
  } catch (err) {
    alert(err.message);
  }
}

async function deleteEntry(entry) {
  if (!confirm(`Delete "${entry.name}"? This cannot be undone.`)) return;
  try {
    const fullPath = joinPath(currentFilePath, entry.name);
    await api('DELETE', `/api/servers/${activeServerId}/file?path=${encodeURIComponent(fullPath)}&isDirectory=${entry.isDirectory}`);
    loadFiles(currentFilePath);
  } catch (err) {
    alert(err.message);
  }
}

// ---------- File editor modal ----------
async function openFileEditor(filePath) {
  const modal = document.getElementById('editor-modal');
  const errorEl = document.getElementById('editor-error');
  errorEl.textContent = '';
  document.getElementById('editor-title').textContent = filePath;
  document.getElementById('editor-textarea').value = 'Loading...';
  show(modal);
  try {
    const data = await api('GET', `/api/servers/${activeServerId}/file-content?path=${encodeURIComponent(filePath)}`);
    document.getElementById('editor-textarea').value = data.content;
    editingFilePath = filePath;
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

document.getElementById('editor-cancel-btn').addEventListener('click', () => hide(document.getElementById('editor-modal')));
document.getElementById('editor-save-btn').addEventListener('click', async () => {
  const errorEl = document.getElementById('editor-error');
  try {
    await api('PUT', `/api/servers/${activeServerId}/file-content`, {
      path: editingFilePath,
      content: document.getElementById('editor-textarea').value,
    });
    hide(document.getElementById('editor-modal'));
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// ---------- Add/Edit server modal ----------
document.getElementById('add-server-btn').addEventListener('click', () => openServerModal());
document.getElementById('edit-server-btn').addEventListener('click', () => {
  if (activeServerId) openServerModal(getServer(activeServerId));
});
document.getElementById('delete-server-btn').addEventListener('click', async () => {
  if (!activeServerId) return;
  if (!confirm('Delete this server entry? This only removes it from the dashboard.')) return;
  await api('DELETE', `/api/servers/${activeServerId}`);
  activeServerId = null;
  hide(document.getElementById('server-view'));
  show(document.getElementById('empty-state'));
  await loadServers();
});

document.getElementById('server-auth-type').addEventListener('change', (e) => {
  const isKey = e.target.value === 'key';
  document.getElementById('password-field').classList.toggle('hidden', isKey);
  document.getElementById('key-field').classList.toggle('hidden', !isKey);
  document.getElementById('passphrase-field').classList.toggle('hidden', !isKey);
});

function openServerModal(existing) {
  document.getElementById('server-modal-title').textContent = existing ? 'Edit Server' : 'Add Server';
  document.getElementById('server-id').value = existing ? existing.id : '';
  document.getElementById('server-name').value = existing ? existing.name : '';
  document.getElementById('server-host').value = existing ? existing.host : '';
  document.getElementById('server-port').value = existing ? existing.port : 22;
  document.getElementById('server-username').value = existing ? existing.username : '';
  document.getElementById('server-auth-type').value = existing ? existing.auth_type : 'password';
  document.getElementById('server-password').value = '';
  document.getElementById('server-private-key').value = '';
  document.getElementById('server-passphrase').value = '';
  document.getElementById('server-form-error').textContent = '';

  const isKey = (existing ? existing.auth_type : 'password') === 'key';
  document.getElementById('password-field').classList.toggle('hidden', isKey);
  document.getElementById('key-field').classList.toggle('hidden', !isKey);
  document.getElementById('passphrase-field').classList.toggle('hidden', !isKey);

  show(document.getElementById('server-modal'));
}

document.getElementById('server-cancel-btn').addEventListener('click', () => hide(document.getElementById('server-modal')));

document.getElementById('server-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('server-form-error');
  errorEl.textContent = '';

  const id = document.getElementById('server-id').value;
  const payload = {
    name: document.getElementById('server-name').value,
    host: document.getElementById('server-host').value,
    port: parseInt(document.getElementById('server-port').value, 10) || 22,
    username: document.getElementById('server-username').value,
    auth_type: document.getElementById('server-auth-type').value,
    password: document.getElementById('server-password').value || undefined,
    privateKey: document.getElementById('server-private-key').value || undefined,
    passphrase: document.getElementById('server-passphrase').value || undefined,
  };

  try {
    if (id) {
      await api('PUT', `/api/servers/${id}`, payload);
    } else {
      await api('POST', '/api/servers', payload);
    }
    hide(document.getElementById('server-modal'));
    await loadServers();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// ---------- Init ----------
checkAuth();
