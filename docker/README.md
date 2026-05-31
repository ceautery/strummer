# Claude Code dev container (greenfield)

Hosts Claude Code alongside your project, with auth/skills/memories and `gh`
credentials persisted across rebuilds, plus HTTP access to the host and internet.

## Layout

```
.
├── docker-compose.yml
└── docker/
    ├── Dockerfile
    └── entrypoint.sh
```

Mount your project at the compose root (the `.:/workspace` bind mount).

## First run

```bash
chmod +x docker/entrypoint.sh
docker volume create greenfield-claude-auth   # one-time; external so rebuilds never drop it
docker compose up -d --build
docker exec -it greenfield-claude claude         # authenticate once; persists from here on
docker exec -it greenfield-claude gh auth login  # authenticate gh once; persists too
```

After `gh auth login`, the entrypoint wires git→https and derives your git
identity from the gh user on the next container start.

## What persists (and how)

The `greenfield-claude-auth` named volume mounts at `~/.claude` and carries:

- settings and installed skills
- your private memories (`~/.claude/projects/<dir>/memory/`)
- `gh` config (`GH_CONFIG_DIR` points onto the volume)
- global git config (`GIT_CONFIG_GLOBAL` points onto the volume)

`~/.claude.json` (the OAuth credentials) lives at the home-dir root, *outside*
the volume, and the CLI rewrites it in place. The entrypoint copy-restores it
on start and copy-saves it on stop, stashing it as `.claude.json.persist` inside
the volume. The volume is declared `external`, so even `docker compose down -v`
leaves it intact.

The CLI itself installs into `~/.npm-global` (not under `~/.claude`) so the
volume mount can't mask the `claude` binary.

## Networking

- **Internet** — works out of the box.
- **Host** — reach host services at `http://host.docker.internal:<port>`; the
  `extra_hosts: host-gateway` line makes that name resolve on Linux.

```bash
docker exec -it greenfield-claude bash -lc 'curl -sI https://api.anthropic.com | head -1'
docker exec -it greenfield-claude bash -lc 'curl -s http://host.docker.internal:PORT/...'
```

## Verify persistence

```bash
docker compose down && docker compose up -d --build
docker exec -it greenfield-claude claude   # should NOT prompt for re-auth
docker exec -it greenfield-claude gh auth status
```
