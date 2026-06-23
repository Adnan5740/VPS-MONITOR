# VPS Monitor

A self-hosted dashboard (similar in spirit to Pterodactyl) for managing your own VPS servers:
add a server's IP, username, and password (or SSH key), then get a live browser-based terminal
and an SFTP file manager.

## What it does

- Dashboard login (separate from your VPS credentials) protects the whole app.
- Add/edit/delete VPS entries: host, port, username, password OR private key.
- Credentials are encrypted at rest (AES-256-GCM) in a local SQLite file, never sent back to the browser.
- Full interactive terminal per server via SSH, streamed over WebSockets into an `xterm.js` terminal in the browser.
- File manager: browse directories, open/edit/save text files, create folders, rename, delete.

## 1. Install

Requires Node.js 18+.

```bash
cd vps-monitor
npm install
```

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

- `SESSION_SECRET` — any long random string.
- `ENCRYPTION_KEY` — generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
  Paste the output in as `ENCRYPTION_KEY`. **If you lose this key you cannot decrypt stored VPS passwords/keys** — back it up somewhere safe (a password manager, not git).
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — login for the dashboard itself. These are only read once, the first time the app starts, to create the admin account in the database. Change the password afterward by deleting `data.sqlite` and restarting with a new value (this resets all stored servers), or by updating the `users` table directly.

## 3. Run

```bash
npm start
```

Visit `http://localhost:3000` (or whatever `PORT` you set) and log in with your admin credentials.

## Security notes — please read

- This app is meant to run **on a machine you control** (your own server or computer), not on a shared/public host without additional hardening.
- Put it behind HTTPS (e.g. a reverse proxy like Caddy/Nginx with a TLS cert) before exposing it to the internet — right now cookies and credentials would otherwise travel in plaintext.
- Consider restricting access further (VPN, firewall allow-list, or a reverse-proxy basic-auth layer) since this app gives terminal access to your servers.
- The encryption key in `.env` must stay private. Treat `data.sqlite` and `.env` as highly sensitive — never commit them to git (a `.gitignore` is included).
- There's currently a single admin account. If you need multiple users with separate permissions, that's a natural next step to build on top of this.

## Project structure

```
vps-monitor/
├── server.js        # Express app, auth, REST API, Socket.io SSH terminal bridge
├── db.js            # SQLite storage + AES-256-GCM encryption of credentials
├── package.json
├── .env.example
└── public/
    ├── index.html
    ├── app.js       # All frontend logic: login, server list, terminal, file manager
    └── style.css
```

## Extending it

Ideas if you want to keep building:
- Server resource stats (CPU/RAM/disk) via a lightweight agent or periodic SSH commands.
- Drag-and-drop file upload/download (currently file manager handles text editing; binary upload/download can be added with SFTP `fastPut`/`fastGet`).
- Multiple dashboard users with roles.
- Audit log of commands run per server.
