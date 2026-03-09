# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium and native Node.js modules (better-sqlite3)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Chromium sandbox is unnecessary inside Docker and causes dbus/shmem crashes
ENV AGENT_BROWSER_ARGS="--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage"

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser@latest @anthropic-ai/claude-code

# Wrap agent-browser with lightweight self-healing:
# - state load must run on a closed browser daemon
# - recover once from stale/crashed daemon errors
RUN mv /usr/local/bin/agent-browser /usr/local/bin/agent-browser-real && \
    printf '#!/bin/bash\nset -euo pipefail\nREAL_BIN="/usr/local/bin/agent-browser-real"\n\ncleanup_stale_daemon_files() {\n  local dirs=()\n  if [ -n "${AGENT_BROWSER_SOCKET_DIR:-}" ]; then\n    dirs+=("${AGENT_BROWSER_SOCKET_DIR}")\n  fi\n  if [ -n "${XDG_RUNTIME_DIR:-}" ]; then\n    dirs+=("${XDG_RUNTIME_DIR}/agent-browser")\n  fi\n  if [ -n "${HOME:-}" ]; then\n    dirs+=("${HOME}/.agent-browser")\n  fi\n  dirs+=("/tmp/agent-browser")\n\n  for d in "${dirs[@]}"; do\n    [ -d "${d}" ] || continue\n    rm -f "${d}"/*.pid "${d}"/*.sock "${d}"/*.port 2>/dev/null || true\n  done\n}\n\nforce_close() {\n  # Close can be asynchronous; run a few times to flush stale daemon state.\n  for _ in 1 2 3; do\n    "${REAL_BIN}" close >/dev/null 2>&1 || true\n    sleep 1\n  done\n  cleanup_stale_daemon_files\n}\n\n# state load is only valid when the daemon browser is closed\nif [ "${1:-}" = "state" ] && [ "${2:-}" = "load" ]; then\n  force_close\nfi\n\nOUT_FILE="$(mktemp)"\nset +e\n"${REAL_BIN}" "$@" >"${OUT_FILE}" 2>&1\nEXIT_CODE=$?\nset -e\n\nif [ "${EXIT_CODE}" -ne 0 ] && grep -Eq "Target page, context or browser has been closed|Cannot load state while browser is running" "${OUT_FILE}"; then\n  force_close\n  set +e\n  "${REAL_BIN}" "$@" >"${OUT_FILE}" 2>&1\n  EXIT_CODE=$?\n  set -e\nfi\n\ncat "${OUT_FILE}"\nrm -f "${OUT_FILE}"\nexit "${EXIT_CODE}"\n' > /usr/local/bin/agent-browser && chmod +x /usr/local/bin/agent-browser

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Secrets are passed via stdin JSON — temp file is deleted immediately after Node reads it
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace /home/node && mkdir -p /home/node/.claude

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
