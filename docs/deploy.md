# Live deployment (Mac mini, next to castle-defense)

HUSH deploys the same way as castle-defense: GitHub releases go to the Mac mini through Docker Compose and a Cloudflare tunnel. It runs as its **own compose project** (`hush-live`) with its own MongoDB, volumes, port and update timer, so the two games never touch each other.

```
 you: GitHub release vX.Y.Z
   │
   ▼
 GitHub Actions (.github/workflows/release.yml)
   tests → image for arm64 + amd64 → ghcr.io/tanglemesh/hide-n-seek:vX.Y.Z
   │
   ▼
 Mac mini, every 5 min: systemd timer hush-update → deploy/update.sh
   new release? image ready? → waits until no game with humans is running → restarts on vX.Y.Z
   │
   ▼
 docker compose (deploy/docker-compose.yml, project "hush-live")
   server (127.0.0.1:8081) ── mongo (volume mongo-data) ── backup → AWS S3 (weekly)
   │
   ▼
 cloudflared (already running for castle-defense) → https://hush.your-domain → http://localhost:8081
```

| | castle-defense | HUSH |
|---|---|---|
| Compose project | `castle-defense-live` | `hush-live` |
| Local port | 8080 | **8081** |
| Image | `ghcr.io/tanglemesh/castle-defense` | `ghcr.io/tanglemesh/hide-n-seek` |
| Database | `bastion_clash` | `hush` (in its own Mongo container) |
| Update timer | `castle-defense-update.timer` | `hush-update.timer` |
| Version setting in `.env` | `CASTLE_VERSION` | `HUSH_VERSION` |
| S3 prefix | `castle-defense` | `hush` (the same bucket and IAM user work) |

The dev setup in the repository root (`docker compose up -d mongo` + `npm start` in the sbx container) stays as it is.

## 1. First release on GitHub

**Activate the release workflow (once).** The workflow lives in `.github/workflows/release.yml` (with a copy in `deploy/github/release.yml`). If it is not on GitHub yet, because the sbx container's token may not change workflow files, push it from your own machine:

```bash
mkdir -p .github/workflows && cp deploy/github/release.yml .github/workflows/release.yml
git add .github/workflows/release.yml && git commit -m "Release workflow" && git push
```

Or in the browser: GitHub → **Add file → Create new file**, path `.github/workflows/release.yml`, paste the content, then commit.

**Create the release.** `package.json` `"version"` should match the tag, since the game shows it in the lower-right corner:

```bash
gh release create v0.1.0 --title "v0.1.0" --generate-notes
```

The workflow runs the tests and builds the image. This takes about 5–10 minutes; there is no build step, so arm64 under emulation is quick.

**Make the image public (once):** go to GitHub → your profile → **Packages** → **hide-n-seek** → **Package settings** → **Change visibility** → **Public**. You can also keep it private: then set `GITHUB_TOKEN` in `deploy/.env` and run `docker login ghcr.io` once on the Mac mini.

## 2. Install on the Mac mini

Docker and the compose plugin are already there for castle-defense.

```bash
git clone https://github.com/tangleMesh/hide-n-seek.git ~/hide-n-seek
cd ~/hide-n-seek
./deploy/install.sh          # first run: creates deploy/.env and stops
nano deploy/.env             # ADMIN_USERS, S3_BUCKET, AWS_* (you can copy the values from ~/castle-defense/deploy/.env)
./deploy/install.sh          # second run: installs the update timer, pulls the latest release, starts everything
```

The second run ends with the health check, e.g. `{"ok":true,"version":"0.1.0","liveMatches":0,"sessions":0}`, and the container list (mongo, server, backup).

Then register the account named in `ADMIN_USERS` (e.g. `jay`) in the game. `/admin` shows the bot training dashboard to that account only.

Settings in `deploy/.env` (see `deploy/.env.example`):

| Setting | Default | |
|---|---|---|
| `HOST_PORT` | `8081` | Local port for the tunnel, bound to 127.0.0.1 only |
| `HUSH_VERSION` | set by the updater | The release that runs |
| `AUTO_UPDATE` | `1` | `0` pins `HUSH_VERSION` (no automatic updates) |
| `UPDATE_MAX_WAIT_MIN` | `30` | How long an update waits for running games to end |
| `ADMIN_USERS` | `jay` | Accounts allowed to see `/admin` |
| `TRAINING` | `on` | Idle-time bot training (`off` disables it) |
| `TRAINING_MAX_MB` | `256` | Heap cap for the training worker (it restarts if it needs more; the game server never does) |
| `MIN_PERSONAS` | `24` | Starting persona population |
| `BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP` | `168` / `12` | Weekly backups, keep the newest 12 |

Memory: MongoDB's cache is capped at 256 MB. The server uses about 150 MB, plus up to `TRAINING_MAX_MB` for training.

## 3. Cloudflare tunnel

Add a second public hostname to the tunnel castle-defense already uses.

**Tunnel managed in the dashboard:** go to Zero Trust → Networks → **Tunnels** → your tunnel → **Public Hostname** → **Add a public hostname**. Choose a subdomain (e.g. `hush`) and set the service to **HTTP** `localhost:8081`. WebSockets work through the tunnel by default.

**Tunnel with a local config file** (`/etc/cloudflared/config.yml`): add the rule *before* the final 404 rule:

```yaml
ingress:
  - hostname: castle.example.com
    service: http://localhost:8080
  - hostname: hush.example.com
    service: http://localhost:8081
  - service: http_status:404
```

```bash
cloudflared tunnel route dns <your-tunnel-name> hush.example.com
sudo systemctl restart cloudflared
```

## 4. Move the players from the dev server (optional, once)

This keeps accounts, ratings, personas and what the bots learned. In the sbx container:

```bash
docker exec hush-mongo mongodump --db hush --archive --gzip > hush-dev.archive.gz
```

Copy the archive to the Mac mini, then:

```bash
cd ~/hide-n-seek/deploy
docker compose exec -T mongo mongorestore --archive --gzip --drop < ~/hush-dev.archive.gz
docker compose restart server
```

## 5. Releasing an update

1. Bump `"version"` in `package.json`, add a CHANGELOG entry, commit and push to `main`.
2. Run `gh release create vX.Y.Z --generate-notes`.
3. Once the image is built, the Mac mini picks it up within 5 minutes. If people are playing, it waits up to `UPDATE_MAX_WAIT_MIN` for those games to end.
4. If it has to restart mid-game anyway, every running game is snapshotted first. Ranked games resume right away (players reconnect automatically), and custom games show up under *Saved games*.

Only published releases are installed. Drafts and plain tags are ignored.

## 6. Everyday operations (on the Mac mini, in `~/hide-n-seek/deploy`)

```bash
docker compose ps                                  # status
docker compose logs -f server                      # server log (also: mongo, backup)
journalctl -u hush-update -n 50                    # what the updater did
systemctl list-timers hush-update.timer            # next update check
curl -s localhost:8081/api/health                  # version + running games

./update.sh --force                                # install the latest release now
docker compose run --rm backup now                 # back up now
docker compose run --rm backup list                # backups in S3
```

**Restore a backup from S3:**

```bash
docker compose run --rm --entrypoint bash backup -c \
  'aws s3 cp s3://$S3_BUCKET/$S3_PREFIX/<file>.archive.gz - | mongorestore --uri mongodb://mongo:27017 --archive --gzip --drop'
docker compose restart server
```

**Roll back:** set `HUSH_VERSION=v0.1.0` and `AUTO_UPDATE=0` in `.env`, then run `docker compose up -d`. Set `AUTO_UPDATE=1` again once a fixed release is out.

**Stop or start:** `docker compose down` / `docker compose up -d`. The data stays in the volume. Never run `down -v` on the live server, because it deletes the database.

## Troubleshooting

| Symptom | Check |
|---|---|
| The updater keeps saying "image … not available yet" | Is the release workflow green? Is the package public? |
| "no published release yet" | Create a GitHub release (a tag alone isn't enough). |
| The site doesn't load through the tunnel | Run `curl localhost:8081/api/health` on the Mac mini. If that works, the tunnel hostname or service is wrong. |
| Port 8081 is already taken | Change `HOST_PORT` in `.env`, run `docker compose up -d`, and update the tunnel. |
| The backup log says "disabled" | `S3_BUCKET` or the AWS keys are missing in `.env`. Run `docker compose up -d backup` after fixing them. |
| `/admin` shows a growing `restarts` count for training | Look at `docker compose logs server \| grep train`. Raise `TRAINING_MAX_MB` or set `TRAINING=off`. |
