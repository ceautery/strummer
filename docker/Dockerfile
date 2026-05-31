FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
    sudo git curl wget jq ca-certificates gnupg \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) — official apt repo
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

ARG USERNAME=claude
# node:22 already ships a `node` user/group at uid/gid 1000, so creating a
# second uid-1000 user fails ("GID 1000 already exists"). Rename the existing
# one instead — keeps uid/gid 1000 so bind-mounted project files stay writable.
RUN groupmod -n $USERNAME node \
    && usermod -l $USERNAME -d /home/$USERNAME -m node \
    && echo "$USERNAME ALL=(root) NOPASSWD:ALL" > /etc/sudoers.d/$USERNAME \
    && chmod 0440 /etc/sudoers.d/$USERNAME

# Pre-create ~/.claude so the named volume inherits the right owner on first mount
RUN mkdir -p /home/$USERNAME/.claude \
    && chown -R $USERNAME:$USERNAME /home/$USERNAME/.claude

USER $USERNAME

# Persist gh auth + global git config onto the same auth volume (mounted at ~/.claude)
ENV GH_CONFIG_DIR=/home/$USERNAME/.claude/gh
ENV GIT_CONFIG_GLOBAL=/home/$USERNAME/.claude/.gitconfig

# GOTCHA: install the CLI OUTSIDE ~/.claude, or the volume mount masks the binary
ENV NPM_CONFIG_PREFIX=/home/$USERNAME/.npm-global
ENV PATH=/home/$USERNAME/.npm-global/bin:$PATH
RUN mkdir -p $NPM_CONFIG_PREFIX \
    && npm install -g @anthropic-ai/claude-code

WORKDIR /workspace
