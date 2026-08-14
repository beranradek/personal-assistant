#!/bin/bash
# Reaps codex turns and MCP server children that outlive the daemon's own
# in-process safety net (config.codex.turnTimeoutMs, src/backends/codex.ts).
#
# Why this exists as a separate OS-level script instead of just relying on
# turnTimeoutMs: turnTimeoutMs is a setTimeout/AbortController living inside
# pa-daemon's own Node event loop. Under the exact failure mode it's meant to
# guard against (runaway sandboxed subprocesses exhausting host RAM), that
# event loop itself can stall long enough to delay or skip the timer, so the
# supposed safety net can fail silently right when it's needed most. This
# script never touches the Node process; it only reads /proc and sends
# signals, so it works even if pa-daemon is completely wedged.
#
# Scope of what it touches: only PIDs inside pa-daemon.service's own cgroup
# (orphaned children keep their ancestor's cgroup membership even after being
# reparented on parent death - see the comment in src/backends/codex.ts on
# the chrome-devtools-mcp/context7-mcp orphan gap this closes). It never
# matches on a bare process name/cmdline pattern against the whole system, so
# it cannot touch a codex/claude session the user runs manually in their own
# terminal.
#
# Two independent triggers:
#   1. Stale codex turn: a "codex exec" process (and its full descendant
#      tree - sandboxes, bwrap, any MCP servers it spawned) older than
#      $STALE_SECONDS. Default STALE_SECONDS is derived from this
#      deployment's own config.codex.turnTimeoutMs (settings.json) plus
#      $GRACE_SECONDS, so raising turnTimeoutMs (for legitimately longer
#      turns) automatically raises this backstop's threshold too - see
#      resolve_stale_seconds(). This only fires once the in-process timeout
#      should already have fired and clearly didn't.
#   2. Orphaned MCP server: a process tree matching one of this deployment's
#      configured `mcpServers` (settings.json - read dynamically, see
#      mcp_patterns()) whose codex exec parent is already gone, and which is
#      older than $ORPHAN_MIN_AGE_SECONDS (default 120s). This does NOT
#      cover PA's own stdio `pa mcp-server` orphan case (mitigated
#      separately via httpMcpPort, see src/backends/codex.ts) since that one
#      isn't declared in `mcpServers`.
#
#      Caveat this can't fully close: each mcpServers entry is launched via
#      an intermediate `npx` process (settings.json: command="npx"), not
#      spawned directly by codex exec. If that intermediate npx process
#      exits early - e.g. after exec-replacing itself vs. staying resident,
#      which isn't guaranteed across npm/npx versions - the actual MCP
#      server process gets reparented away from codex exec while the turn
#      is still using it, and has_live_codex_ancestor() can no longer trace
#      it back: the OS itself has dropped that relationship, not just this
#      script's bookkeeping. $ORPHAN_MIN_AGE_SECONDS only guards against the
#      common case of a reparent happening moments before this script runs;
#      it does not prove the server is actually unused. This mirrors the
#      residual, bounded risk already documented for `pa mcp-server` in
#      src/backends/codex.ts.
#
# All ppid/etimes lookups come from a single `ps` snapshot taken once per
# run (see snapshot()) rather than one `ps` fork per candidate PID, so tree
# discovery stays cheap even on a host already under the memory/CPU pressure
# this watchdog exists to react to. All targets found across the whole run
# are signaled together (one SIGTERM batch, one sleep, one SIGKILL batch for
# survivors) instead of per-tree, for the same reason.
#
# PID-reuse safety: PIDs are recycled by the kernel, so a pid number captured
# in the initial snapshot could in principle belong to a different process by
# the time a signal is actually sent. Every PID is re-verified via its
# /proc/pid/stat start-time (immune to reuse, unlike the pid number itself)
# immediately before each signal is sent, inline in reap_targets() via
# starttime_of().
#
# Install this script from a stable path (not the mutable dev git checkout -
# see docs/settings/openai_codex_agent.md) so a rebase/branch-switch/move of
# the dev checkout can't silently break the timer-triggered oneshot unit.
#
# Usage: codex-watchdog.sh [--dry-run]
#   Env overrides: STALE_SECONDS (skips the turnTimeoutMs-derived default
#   entirely), GRACE_SECONDS (default 900 = 15min, added on top of
#   turnTimeoutMs when deriving the default), ORPHAN_MIN_AGE_SECONDS
#   (default 120, minimum age before an apparently-orphaned MCP server is
#   killed), SERVICE_NAME (default pa-daemon.service), PA_CONFIG (default
#   ~/.personal-assistant/settings.json).

set -uo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

SERVICE_NAME="${SERVICE_NAME:-pa-daemon.service}"
# PA_CONFIG is a directory (the daemon's own contract - see
# resolveConfigDir() in src/core/config.ts and `pa --help`), not a file path;
# settings.json always lives directly inside it.
CONFIG_PATH="${PA_CONFIG:-$HOME/.personal-assistant}/settings.json"
GRACE_SECONDS="${GRACE_SECONDS:-900}"
ORPHAN_MIN_AGE_SECONDS="${ORPHAN_MIN_AGE_SECONDS:-120}"
LOG_FILE="${LOG_FILE:-$HOME/.personal-assistant/data/logs/codex-watchdog.log}"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  local line
  line="$(date -Is) $*"
  echo "$line" >>"$LOG_FILE"
  logger -t codex-watchdog "$*" 2>/dev/null || true
  [[ "$DRY_RUN" == "1" ]] && echo "$line"
}

# --- config.codex.turnTimeoutMs / mcpServers, read once from settings.json ---
#
# One `node -e` call (Node is already a hard dependency of this project)
# emits `KEY=value` lines: TURN_TIMEOUT_MS (a number in ms, or "disabled")
# and zero or more MCP_PATTERN (one per configured mcpServers entry, version
# suffix stripped so it matches the process's actual cmdline substring, e.g.
# "@upstash/context7-mcp@latest" -> "@upstash/context7-mcp"). Falls back to
# safe defaults if node/config is unavailable, rather than failing the run.

TURN_TIMEOUT_MS="1800000"
declare -a MCP_PATTERNS=()

read_config() {
  node -e '
    const fs = require("fs");
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) {}

    const ttm = cfg && cfg.codex && cfg.codex.turnTimeoutMs;
    if (ttm === null) process.stdout.write("TURN_TIMEOUT_MS=disabled\n");
    else if (typeof ttm === "number") process.stdout.write(`TURN_TIMEOUT_MS=${ttm}\n`);
    else process.stdout.write("TURN_TIMEOUT_MS=1800000\n");

    function stripVersion(pkg) {
      const lastSlash = pkg.lastIndexOf("/");
      const atIdx = pkg.indexOf("@", lastSlash + 1);
      return atIdx > 0 ? pkg.slice(0, atIdx) : pkg;
    }
    // Launchers generic enough that using them as a fallback pattern would
    // match nearly every process on the box - never match on these alone.
    const GENERIC_COMMANDS = new Set(["npx", "npm", "node", "python", "python3", "sh", "bash"]);
    const servers = (cfg && cfg.mcpServers) || {};
    for (const name of Object.keys(servers)) {
      const entry = servers[name] || {};
      const args = entry.args || [];
      const pkgArg = args.find((a) => typeof a === "string" && !a.startsWith("-"));
      let pattern = pkgArg ? stripVersion(pkgArg) : null;
      // Fallback for an entry with no usable package-name arg (e.g. a
      // directly-invoked binary with only flag args) - skip generic
      // launchers rather than emitting a pattern that would match almost
      // any process.
      if (!pattern && typeof entry.command === "string" && !GENERIC_COMMANDS.has(entry.command)) {
        pattern = entry.command;
      }
      if (pattern) process.stdout.write(`MCP_PATTERN=${pattern}\n`);
    }
  ' "$CONFIG_PATH" 2>/dev/null
}

load_config() {
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      TURN_TIMEOUT_MS) TURN_TIMEOUT_MS="$value" ;;
      MCP_PATTERN) MCP_PATTERNS+=("$value") ;;
    esac
  done < <(read_config)
  # Fail-safe: if config couldn't be read/parsed (node missing, bad JSON),
  # fall back to this deployment's known mcpServers rather than matching
  # nothing and silently never reaping orphans.
  if [[ ${#MCP_PATTERNS[@]} -eq 0 ]]; then
    MCP_PATTERNS=("chrome-devtools-mcp" "context7-mcp")
  fi
  # read_config() does a bare JSON.parse, not the app's own Zod schema
  # (z.number().int().positive().nullable() in src/core/types.ts) - a
  # hand-edited or stale-on-disk non-integer value must not reach the bash
  # integer arithmetic in resolve_stale_seconds() below, which would abort
  # the whole run under `set -u` and silently stop reaping on every tick.
  if [[ "$TURN_TIMEOUT_MS" != "disabled" && ! "$TURN_TIMEOUT_MS" =~ ^[0-9]+$ ]]; then
    log "WARN settings.json codex.turnTimeoutMs is not a plain positive integer (got \"$TURN_TIMEOUT_MS\"), falling back to 1800000"
    TURN_TIMEOUT_MS="1800000"
  fi
}

resolve_stale_seconds() {
  if [[ -n "${STALE_SECONDS:-}" ]]; then
    return
  fi
  if [[ "$TURN_TIMEOUT_MS" == "disabled" ]]; then
    STALE_SECONDS=5400
  else
    STALE_SECONDS=$(( (TURN_TIMEOUT_MS + 999) / 1000 + GRACE_SECONDS ))
  fi
}

# Assumes the cgroup v2 unified hierarchy (verified in place on this host:
# /sys/fs/cgroup/<service-relative-path>/cgroup.procs). On a legacy/hybrid
# cgroup host this path wouldn't resolve; cgroup_pids() fails closed in that
# case (logs an error and does nothing), it never falls back to an unscoped
# system-wide scan.
cgroup_path() {
  local rel
  rel="$(systemctl --user show "$SERVICE_NAME" -p ControlGroup --value 2>/dev/null)"
  [[ -z "$rel" ]] && return 1
  echo "/sys/fs/cgroup${rel}/cgroup.procs"
}

cgroup_pids() {
  local procs_file
  procs_file="$(cgroup_path)" || return 1
  [[ -r "$procs_file" ]] || return 1
  cat "$procs_file" 2>/dev/null
}

# --- one-time process snapshot, used for all ppid/etimes/children lookups ---

declare -A PPID_OF=()
declare -A ETIMES_OF=()
declare -A CHILDREN_OF=()   # ppid -> space-separated child pids

snapshot() {
  local pid ppid etimes
  while read -r pid ppid etimes; do
    [[ -z "$pid" ]] && continue
    PPID_OF["$pid"]="$ppid"
    ETIMES_OF["$pid"]="$etimes"
    CHILDREN_OF["$ppid"]+=" $pid"
  done < <(ps -eo pid=,ppid=,etimes= 2>/dev/null)
}

ppid_of() { echo "${PPID_OF[$1]:-}"; }
etimes_of() { echo "${ETIMES_OF[$1]:-}"; }

# Process identity token immune to PID reuse: the start-time field from
# /proc/pid/stat (field 22; comm can itself contain spaces/parens, so split
# on the *last* ") " rather than by fixed field position).
starttime_of() {
  local stat rest
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  [[ -z "$stat" ]] && return 1
  rest="${stat##*) }"
  local -a fields=()
  read -r -a fields <<<"$rest"
  [[ ${#fields[@]} -ge 20 ]] || return 1
  echo "${fields[19]}"
}

# cmdline of $1 with NUL args joined by spaces, or empty if the pid is gone.
# Uses mapfile (a bash builtin) rather than forking `tr` - this runs once per
# candidate pid on every timer tick, and forking is the one thing to avoid on
# a host already under the memory/CPU pressure this script exists to react to.
cmdline_of() {
  [[ -r "/proc/$1/cmdline" ]] || return 0
  local -a args=()
  mapfile -d '' -t args <"/proc/$1/cmdline" 2>/dev/null
  local IFS=' '
  echo "${args[*]}"
}

# True if $1 is a top-level "codex exec" process, checked via the actual
# argv0/argv1 fields (not a substring match on the joined cmdline) - the
# joined cmdline of such a process also contains the literal text of every
# mcpServers pattern it configures for itself (e.g. "chrome-devtools-mcp"),
# so substring matching here would misfire on live sessions. argv[0] is
# matched by basename, not a "*/codex" glob: codex.codexPath is a
# user-settable config field that may be a bare "codex" resolved via PATH
# (see docs/settings/openai_codex_agent.md), with no path separator at all.
is_codex_exec() {
  [[ -r "/proc/$1/cmdline" ]] || return 1
  local -a args=()
  mapfile -d '' -t args <"/proc/$1/cmdline" 2>/dev/null
  [[ ${#args[@]} -ge 2 ]] || return 1
  [[ "$(basename -- "${args[0]}")" == "codex" && "${args[1]}" == "exec" ]]
}

# All descendant PIDs of $1 (not including $1), via the CHILDREN_OF snapshot.
descendants_of() {
  local root="$1"
  local -a frontier=("$root")
  local -a all=()
  while [[ ${#frontier[@]} -gt 0 ]]; do
    local -a next=()
    local f child
    for f in "${frontier[@]}"; do
      for child in ${CHILDREN_OF[$f]:-}; do
        all+=("$child")
        next+=("$child")
      done
    done
    frontier=("${next[@]}")
  done
  printf '%s\n' "${all[@]}"
}

# Does the ancestor chain of $1 (walking up via ppid) still contain a live
# "codex exec" process before falling off the cgroup / hitting pid 1?
has_live_codex_ancestor() {
  local pid="$1" seen=0 cur
  cur="$(ppid_of "$pid")"
  while [[ -n "$cur" && "$cur" != "0" && "$cur" != "1" && $seen -lt 30 ]]; do
    is_codex_exec "$cur" && return 0
    cur="$(ppid_of "$cur")"
    seen=$((seen + 1))
  done
  return 1
}

# --- target collection (phase 1: decide what to kill, kill nothing yet) ---

declare -a TARGET_PIDS=()
declare -A SEEN_PIDS=()      # dedup: the same pid can surface via two overlapping
                             # trees (e.g. an orphan tree nested under a separately
                             # stale codex-exec tree)
declare -A DISCOVERY_START=() # pid -> /proc/pid/stat start-time captured at the
                             # moment each pid was identified as a target (phase
                             # 1). reap_targets() re-reads this at signal time and
                             # only acts on pids whose start-time still matches -
                             # the baseline has to come from discovery time, not
                             # from a read taken immediately before signaling
                             # (that would just match whatever process currently
                             # holds the pid, catching nothing).

add_target_tree() {
  local root="$1" reason="$2"
  local -a pids=("$root")
  while IFS= read -r d; do [[ -n "$d" ]] && pids+=("$d"); done < <(descendants_of "$root")
  log "TARGET reason=\"$reason\" root=$root cmd=\"$(cmdline_of "$root")\" tree_size=${#pids[@]}"
  local p st
  for p in "${pids[@]}"; do
    [[ -n "${SEEN_PIDS[$p]:-}" ]] && continue
    st="$(starttime_of "$p")" || continue   # already gone - nothing to track
    SEEN_PIDS["$p"]=1
    DISCOVERY_START["$p"]="$st"
    TARGET_PIDS+=("$p")
  done
}

# --- phase 2: signal everything collected in phase 1, together ---

reap_targets() {
  [[ ${#TARGET_PIDS[@]} -eq 0 ]] && return
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY-RUN: would signal ${#TARGET_PIDS[@]} pid(s): ${TARGET_PIDS[*]}"
    return
  fi

  # Re-verify identity against the discovery-time start-time, immune to PID
  # reuse in the gap between add_target_tree() (phase 1) and this point.
  local -a to_term=()
  local p st
  for p in "${TARGET_PIDS[@]}"; do
    st="$(starttime_of "$p")" || continue
    [[ "$st" == "${DISCOVERY_START[$p]:-}" ]] && to_term+=("$p")
  done
  [[ ${#to_term[@]} -eq 0 ]] && return

  kill -TERM "${to_term[@]}" 2>/dev/null
  sleep 3

  local -a survivors=()
  for p in "${to_term[@]}"; do
    st="$(starttime_of "$p")" || continue
    [[ "$st" == "${DISCOVERY_START[$p]}" ]] && survivors+=("$p")
  done
  if [[ ${#survivors[@]} -gt 0 ]]; then
    log "KILL survivors after SIGTERM, sending SIGKILL: ${survivors[*]}"
    kill -KILL "${survivors[@]}" 2>/dev/null
  fi
}

main() {
  load_config
  resolve_stale_seconds

  local pids
  pids="$(cgroup_pids)" || { log "ERROR could not resolve cgroup for $SERVICE_NAME, skipping run"; exit 0; }
  [[ -z "$pids" ]] && exit 0

  snapshot

  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    local cmd age
    cmd="$(cmdline_of "$pid")"
    [[ -z "$cmd" ]] && continue

    if is_codex_exec "$pid"; then
      age="$(etimes_of "$pid")"
      [[ -z "$age" ]] && continue
      if (( age > STALE_SECONDS )); then
        add_target_tree "$pid" "codex turn exceeded ${STALE_SECONDS}s (age=${age}s), in-process turnTimeoutMs backstop"
      fi
      continue
    fi

    local pattern matched=0
    for pattern in "${MCP_PATTERNS[@]}"; do
      if [[ "$cmd" == *"$pattern"* ]]; then
        matched=1
        break
      fi
    done
    if [[ "$matched" == "1" ]]; then
      age="$(etimes_of "$pid")"
      if [[ -n "$age" ]] && (( age >= ORPHAN_MIN_AGE_SECONDS )) && ! has_live_codex_ancestor "$pid"; then
        add_target_tree "$pid" "orphaned MCP server '$pattern' (parent codex exec no longer alive, age=${age}s)"
      fi
      continue
    fi
  done <<<"$pids"

  reap_targets
}

main
