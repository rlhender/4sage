# Putting Hexmarch on a server

These steps assume a Linux VPS running Debian or Ubuntu, with root or sudo
access. They take about fifteen minutes.

**Tested so far:** a clean install and start from a fresh clone on Linux,
and the systemd unit's syntax. **Not yet tested:** these steps end to end on
a real VPS behind a domain. If a step is wrong for your setup, fix it here.

Hexmarch is one Node.js process with one dependency. It needs no database
and no build step.

## 1. Try it first, without a domain

```
# Node.js 20 or newer
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs git

sudo git clone --branch BRANCH https://github.com/rlhender/4sage.git /opt/hexmarch
cd /opt/hexmarch/games/hexmarch
sudo npm ci --omit=dev

HOST=0.0.0.0 PORT=3000 node server/server.js
```

Use `claude/happy-tesla-0dt81j` for `BRANCH` until the work is merged, then
`main`.

Open `http://YOUR_SERVER_IP:3000` in a browser. If your VPS has a firewall,
allow the port first (`sudo ufw allow 3000`). This is enough to play with
friends and to point AI players at `http://YOUR_SERVER_IP:3000`. Stop it
with Ctrl+C before going on.

## 2. Run it as a service

So it starts on boot, restarts if it fails, and keeps games across restarts.

```
sudo useradd --system --home /var/lib/hexmarch --create-home --shell /usr/sbin/nologin hexmarch
sudo cp deploy/hexmarch.env /etc/hexmarch.env
sudo cp deploy/hexmarch.service /etc/systemd/system/hexmarch.service
sudo systemctl daemon-reload
sudo systemctl enable --now hexmarch

systemctl status hexmarch          # should say "active (running)"
curl http://127.0.0.1:3000/healthz # should print "ok"
```

Settings live in `/etc/hexmarch.env`; restart the service after changing
them. As shipped, the service listens only on the machine itself
(`HOST=127.0.0.1`) and expects a reverse proxy in front, which is step 3.
To skip the proxy, set `HOST=0.0.0.0` there.

Rooms and finished-game records are kept in `/var/lib/hexmarch`.

## 3. Give it a domain and HTTPS

Point a domain (or subdomain) at the server's IP address, then put a
reverse proxy in front. Caddy is the least work, because it gets and renews
the certificate for you:

```
sudo apt-get install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile     # then edit the domain name in it
sudo systemctl reload caddy
sudo ufw allow 80 && sudo ufw allow 443
```

The game is now at `https://your-domain`. If you already run nginx, use
`deploy/nginx.conf` instead; it has the WebSocket and long-request settings
the game needs.

## 4. Connect players

- **People:** open the site, create a room, share the four-letter code or
  the invite link.
- **AI players:** give them the address. `https://your-domain/api/guide`
  tells an AI everything it needs to play; the MCP endpoint is
  `https://your-domain/mcp`. See `AGENTS.md`.
- **A quick AI opponent from your own machine:**
  `node examples/http-agent.js --server https://your-domain --room CODE`

## Updating

```
cd /opt/hexmarch && sudo git pull
cd games/hexmarch && sudo npm ci --omit=dev
sudo systemctl restart hexmarch
```

Games in progress are saved and resume after the restart. A saved game from
an incompatible older version is skipped rather than loaded.

## Looking after it

- Logs: `journalctl -u hexmarch -f`
- Health check for a monitor: `GET /healthz` returns `ok`
- The server is open to anyone who has the address: anyone can create a
  room. That is fine for trying it out with friends; an access key is on
  the list in `PLAN.md` if it needs locking down.
- It runs as a single process and keeps rooms in memory, so run one copy.
