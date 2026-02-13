"""
Security Hooks for Autonomous Coding Agent
==========================================

Pre-tool-use hooks that validate bash commands for security.
Uses an allowlist approach - only explicitly permitted commands can run.
"""

import os
import shlex
from pathlib import Path

# Allowed commands for development tasks
# Set needed for the autonomous coding
ALLOWED_COMMANDS = {
    # File inspection
    "ls",
    "cat",
    "find",
    "head",
    "tail",
    "wc",
    "grep",
    "awk",
    "tee",
    "stat",
    "tree",
    # File operations (agent uses SDK tools for most file ops, but cp/mkdir needed occasionally)
    "touch",
    "cp",
    "mkdir",
    "chmod",  # For making scripts executable; validated separately
    "rm", # BE AWARE, allow after some experience and trust!
    "rmdir", # BE AWARE, allow after some experience and trust!
    "mv", # Be aware, allow after some experience and trust!
    # Directory
    "pwd",
    # "cd", # Be really aware, do not let the agent freely traverse the entire OS if not necessary!
    # Node.js development
    "npm",
    "node",
    "pnpm",
    "sort",
    "npx",
    "vite",
    "next",
    "tsc",
    "eslint",
    "jest",
    "vitest",
    # Java development
    "gradle",
    "gradlew",
    "java",
    "mvn",
    "mvnw",
    # Python development
    "python",
    "pip",
    "uv",
    "uvx",
    "ruff",
    "mypy",
    "uvicorn",
    "pylint",
    "flake8",
    "pytest",
    # Image development
    "docker",
    "kubectl",
    # Rust development
    "cargo",
    "rustc",
    # Go development
    "go",
    # Swift development
    "swift",
    "xcodebuild",
    # Static analysis
    "sonar-scanner",
    "swiftlint",
    "clippy",
    "golangci-lint",
    # Databases
    "psql",
    "mysql",
    # Web calls
    "curl",
    # Version control
    "git",
    # Process management
    "ps",
    "lsof",
    "sleep",
    "nohup",
    "pkill", # For killing dev servers; validated separately
    "kill", # Be aware, allow after some experience and trust! But very useful for terminating locally developed applications and in case of troubles.
    "systemctl",
    "source",
    "tr", # translate or delete characters in a string
    "journalctl", # query the systemd journal for logs of services. Be aware, allow according your data!
    "netstat",
    # Internal git-based task and messages management
    "ac",
    "ac-msg",
    # Manipulate/validate JSON data
    "jq",
    # Bash builtins (used in shell constructs, no side effects)
    "read",       # while read ... loops (sets shell variables in subprocess only)
    "test",       # conditional expressions (also [)
    "true",       # return 0
    "false",      # return 1
    "printf",     # formatted output
    # Safe utility commands (read-only / no security impact)
    "date",       # display date/time
    "basename",   # strip directory from path
    "dirname",    # strip filename from path
    "cut",        # extract fields from lines
    "sed",        # stream editor (same risk level as awk, already allowed)
    "diff",       # compare files
    "realpath",   # resolve path
    "readlink",   # resolve symlinks
    "mktemp",     # create temp files in /tmp
    "id",         # show user/group info
    "seq",        # print sequence of numbers
    # Others
    "echo",
    "which",
    "jar", # General purpose archive tool
    "unzip",
    # Script execution
    "start.sh",
    "stop.sh",
    "restart.sh",
    "shutdown.sh",
    "startup.sh",
    "build.sh",
    "kcadm.sh",
    "kc.sh",
}

# Commands that need additional validation even when in the allowlist
COMMANDS_NEEDING_EXTRA_VALIDATION = {"pkill", "chmod", "start.sh", "restart.sh", "stop.sh", "docker", "systemctl", "rm", "rmdir", "kill"}

# Sensitive system directories that should not be accessed for reading
# These directories contain sensitive configuration, credentials, or system data
SENSITIVE_SYSTEM_DIRECTORIES = {
    "/etc/passwd", "/etc/shadow", "/etc/sudoers", "/etc/ssh",
    "/etc/ssl", "/etc/pki", "/etc/security",
    "/root", "/home",  # User home directories
    "/var/log", "/var/run", "/var/spool",  # System logs and state
    "/proc", "/sys", "/dev",  # Kernel interfaces
    "/boot", "/lib/firmware",  # Boot configuration
    "~/.ssh", "~/.gnupg", "~/.aws", "~/.config",  # User credentials
    ".env", ".git/config", "credentials", "secrets",  # Common sensitive files
}

# Commands that are particularly dangerous and should have strict path validation
HIGH_RISK_PATH_COMMANDS = {
    "cp", "mv",  # Can copy/move files in/out of project
    "ln",  # Can create symlinks to sensitive files
    "curl", "wget",  # Can download to arbitrary locations
    "git",  # Can clone/operate on arbitrary directories
    "docker",  # Can mount arbitrary volumes
    "unzip", "jar",  # Can extract to arbitrary locations
    "tee",  # Can write to arbitrary files
    "python", "python3", "node", "java", "bash", "sh",  # Can execute scripts from anywhere
}


def extract_substitution_commands(command_string: str) -> list[str]:
    """
    Extract command names hidden inside shell substitutions.

    Detects $(...), `...`, and <(...) / >(...) process substitutions,
    then recursively calls extract_commands on their contents so that
    nested commands are also validated against the allowlist.

    Args:
        command_string: The full shell command

    Returns:
        List of command names found inside substitutions
    """
    import re

    commands: list[str] = []

    # --- $(...) substitutions (handles nesting via manual brace matching) ---
    i = 0
    while i < len(command_string):
        # Look for $( that is not inside single quotes
        if command_string[i:i + 2] == "$(" :
            # Find the matching closing paren, respecting nesting
            depth = 1
            start = i + 2
            j = start
            in_single_quote = False
            in_double_quote = False
            while j < len(command_string) and depth > 0:
                ch = command_string[j]
                if ch == "'" and not in_double_quote:
                    in_single_quote = not in_single_quote
                elif ch == '"' and not in_single_quote:
                    in_double_quote = not in_double_quote
                elif not in_single_quote and not in_double_quote:
                    if ch == "(" and command_string[j - 1:j + 1] != "$(":
                        depth += 1
                    elif command_string[j:j + 2] == "$(":
                        depth += 1
                        j += 1  # skip the '(' so we don't double-count
                    elif ch == ")":
                        depth -= 1
                j += 1
            if depth == 0:
                inner = command_string[start:j - 1]
                commands.extend(extract_commands(inner))
                # Also recurse for nested substitutions
                commands.extend(extract_substitution_commands(inner))
            i = j
        else:
            i += 1

    # --- Backtick substitutions ---
    backtick_pattern = re.compile(r"`([^`]*)`")
    for match in backtick_pattern.finditer(command_string):
        inner = match.group(1)
        commands.extend(extract_commands(inner))
        commands.extend(extract_substitution_commands(inner))

    # --- Process substitutions <(...) and >(...) ---
    proc_sub_pattern = re.compile(r"[<>]\(")
    for match in proc_sub_pattern.finditer(command_string):
        start = match.end()
        depth = 1
        j = start
        while j < len(command_string) and depth > 0:
            if command_string[j] == "(":
                depth += 1
            elif command_string[j] == ")":
                depth -= 1
            j += 1
        if depth == 0:
            inner = command_string[start:j - 1]
            commands.extend(extract_commands(inner))
            commands.extend(extract_substitution_commands(inner))

    return commands


def split_command_segments(command_string: str) -> list[str]:
    """
    Split a compound command into individual command segments.

    Handles command chaining (&&, ||, ;) but not pipes (those are single commands).

    Args:
        command_string: The full shell command

    Returns:
        List of individual command segments
    """
    import re

    # Split on && and || while preserving the ability to handle each segment
    # This regex splits on && or || that aren't inside quotes
    segments = re.split(r"\s*(?:&&|\|\|)\s*", command_string)

    # Further split on semicolons
    result = []
    for segment in segments:
        sub_segments = re.split(r'(?<!["\'])\s*;\s*(?!["\'])', segment)
        for sub in sub_segments:
            sub = sub.strip()
            if sub:
                result.append(sub)

    return result


def extract_commands(command_string: str) -> list[str]:
    """
    Extract command names from a shell command string.

    Handles pipes, command chaining (&&, ||, ;), and subshells.
    Returns the base command names (without paths).

    Args:
        command_string: The full shell command

    Returns:
        List of command names found in the string
    """
    commands = []

    # shlex doesn't treat ; as a separator, so we need to pre-process
    import re

    # Split on semicolons that aren't inside quotes (simple heuristic)
    # This handles common cases like "echo hello; ls"
    segments = re.split(r'(?<!["\'])\s*;\s*(?!["\'])', command_string)

    for segment in segments:
        segment = segment.strip()
        if not segment:
            continue

        try:
            tokens = shlex.split(segment)
        except ValueError:
            # Malformed command (unclosed quotes, etc.)
            # Return empty to trigger block (fail-safe)
            return []

        if not tokens:
            continue

        # Track when we expect a command vs arguments
        expect_command = True
        # After 'for'/'select', the next token is a variable name, not a command
        skip_next_as_variable = False

        for token in tokens:
            # Handle trailing semicolons (shlex keeps them attached to tokens)
            has_trailing_semicolon = token.endswith(";")
            if has_trailing_semicolon:
                token = token[:-1]
                if not token:
                    expect_command = True
                    continue

            # Skip variable names after 'for'/'select' keywords
            # Also disable command extraction for remaining word list tokens
            if skip_next_as_variable:
                skip_next_as_variable = False
                expect_command = False
                if has_trailing_semicolon:
                    expect_command = True
                continue

            # Shell operators and semicolons indicate a new command follows
            if token in ("|", "||", "&&", "&", ";"):
                expect_command = True
                continue

            # 'for' and 'select' — next token is a variable name, not a command
            if token in ("for", "select"):
                skip_next_as_variable = True
                continue

            # Skip shell keywords that precede commands
            if token in (
                "if",
                "then",
                "else",
                "elif",
                "fi",
                "while",
                "until",
                "do",
                "done",
                "case",
                "esac",
                "in",
                "!",
                "{",
                "}",
            ):
                if has_trailing_semicolon:
                    expect_command = True
                continue

            # Skip flags/options
            if token.startswith("-"):
                if has_trailing_semicolon:
                    expect_command = True
                continue

            # Skip variable assignments (VAR=value)
            if "=" in token and not token.startswith("="):
                if has_trailing_semicolon:
                    expect_command = True
                continue

            if expect_command:
                # Extract the base command name (handle paths like /usr/bin/python)
                cmd = os.path.basename(token)
                commands.append(cmd)
                expect_command = False

            # Trailing semicolons indicate a new command follows
            if has_trailing_semicolon:
                expect_command = True

    return commands


def validate_pkill_command(command_string: str) -> tuple[bool, str]:
    """
    Validate pkill commands - only allow killing dev-related processes.

    Uses shlex to parse the command, avoiding regex bypass vulnerabilities.

    Returns:
        Tuple of (is_allowed, reason_if_blocked)
    """
    # Allowed process names for pkill
    # NOTE: 'python' is intentionally EXCLUDED to prevent the agent from killing itself
    allowed_process_names = {
        "node",
        "npm",
        "npx",
        "vite",
        "next",
        "pnpm",
        "uvicorn",
        "java",
    }

    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return False, "Could not parse pkill command"

    if not tokens:
        return False, "Empty pkill command"

    # Separate flags from arguments
    args = []
    for token in tokens[1:]:
        if not token.startswith("-"):
            args.append(token)

    if not args:
        return False, "pkill requires a process name"

    # The target is typically the last non-flag argument
    target = args[-1]

    # For -f flag (full command line match), extract the first word as process name
    # e.g., "pkill -f 'node server.js'" -> target is "node server.js", process is "node"
    if " " in target:
        target = target.split()[0]

    if target in allowed_process_names:
        return True, ""
    return False, f"pkill only allowed for dev processes: {allowed_process_names}"


def validate_chmod_command(command_string: str) -> tuple[bool, str]:
    """
    Validate chmod commands - only allow making files executable with +x.

    Returns:
        Tuple of (is_allowed, reason_if_blocked)
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return False, "Could not parse chmod command"

    if not tokens or tokens[0] != "chmod":
        return False, "Not a chmod command"

    # Look for the mode argument
    # Valid modes: +x, u+x, a+x, etc. (anything ending with +x for execute permission)
    mode = None
    files = []

    for token in tokens[1:]:
        if token.startswith("-"):
            # Skip flags like -R (we don't allow recursive chmod anyway)
            return False, "chmod flags are not allowed"
        elif mode is None:
            mode = token
        else:
            files.append(token)

    if mode is None:
        return False, "chmod requires a mode"

    if not files:
        return False, "chmod requires at least one file"

    # Only allow +x variants (making files executable)
    # This matches: +x, u+x, g+x, o+x, a+x, ug+x, etc.
    import re

    if not re.match(r"^[ugoa]*\+x$", mode):
        return False, f"chmod only allowed with +x mode, got: {mode}"

    return True, ""


def validate_rm_command(command_string: str) -> tuple[bool, str]:
    """
    Validate rm commands - restrict dangerous recursive operations.

    Security checks:
    1. Block -r/-R/--recursive without explicit target
    2. Block wildcard patterns like /* or ../*
    3. Block removal of hidden files/directories (.* patterns)
    4. Allow -f flag (force) only with specific targets

    Returns:
        Tuple of (is_allowed, reason_if_blocked)
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return False, "Could not parse rm command"

    if not tokens or tokens[0] != "rm":
        return False, "Not an rm command"

    # Extract flags and targets
    flags = []
    targets = []
    is_recursive = False

    for token in tokens[1:]:
        if token.startswith("-"):
            flags.append(token)
            if "r" in token or "R" in token or token == "--recursive":
                is_recursive = True
        else:
            targets.append(token)

    if not targets:
        return False, "rm requires at least one target"

    # Block dangerous patterns
    dangerous_patterns = [
        "/*", "../*", "/..", "/.", ".*", "**/", "~/*",
        "/home", "/etc", "/usr", "/var", "/bin", "/sbin", "/lib",
        "/boot", "/dev", "/proc", "/sys", "/root"
    ]

    for target in targets:
        for pattern in dangerous_patterns:
            if target == pattern or target.endswith(pattern) or target.startswith(pattern):
                return False, f"rm blocked: dangerous pattern '{target}'"

        # Block .* patterns (hidden files) with recursive flag
        if is_recursive and (target.startswith(".*") or "/.." in target):
            return False, f"rm blocked: recursive deletion of hidden files/directories not allowed: {target}"

    # Block recursive deletion with wildcards
    if is_recursive:
        for target in targets:
            if "*" in target:
                return False, f"rm blocked: recursive deletion with wildcard not allowed: {target}"

    return True, ""


def validate_rmdir_command(command_string: str) -> tuple[bool, str]:
    """
    Validate rmdir commands - only allow empty directory removal.

    Returns:
        Tuple of (is_allowed, reason_if_blocked)
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return False, "Could not parse rmdir command"

    if not tokens or tokens[0] != "rmdir":
        return False, "Not an rmdir command"

    # Extract targets (rmdir doesn't have many meaningful flags)
    targets = []

    for token in tokens[1:]:
        if token.startswith("-"):
            # Allow flags like -p, --parents, --ignore-fail-on-non-empty
            pass
        else:
            targets.append(token)

    if not targets:
        return False, "rmdir requires at least one target"

    # Block dangerous patterns
    dangerous_patterns = ["/", "/*", "../*", "~", "~/*", "."]

    for target in targets:
        if target in dangerous_patterns:
            return False, f"rmdir blocked: dangerous pattern '{target}'"

        # Block path traversal
        if ".." in target and not target.startswith("./"):
            return False, f"rmdir blocked: path traversal not allowed: {target}"

    return True, ""


def validate_kill_command(command_string: str) -> tuple[bool, str]:
    """
    Validate kill commands - only allow killing specific signals/processes.

    Security checks:
    1. Only allow common signals (TERM, KILL, INT, HUP, USR1, USR2)
    2. Block killing PID 1 (init) and negative PIDs (process groups)
    3. Require explicit PID or job spec

    Returns:
        Tuple of (is_allowed, reason_if_blocked)
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return False, "Could not parse kill command"

    if not tokens or tokens[0] != "kill":
        return False, "Not a kill command"

    # Allowed signals
    allowed_signals = {
        "TERM", "KILL", "INT", "HUP", "USR1", "USR2", "QUIT", "STOP", "CONT",
        "15", "9", "2", "1", "10", "12", "3", "19", "18",  # Signal numbers
        "SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGUSR1", "SIGUSR2"
    }

    signal = None
    pids = []

    i = 1
    while i < len(tokens):
        token = tokens[i]

        if token.startswith("-"):
            # Signal specification
            if token == "-l" or token == "--list":
                # kill -l just lists signals, harmless
                return True, ""
            elif token == "-s" and i + 1 < len(tokens):
                signal = tokens[i + 1].upper()
                i += 2
                continue
            else:
                # Extract signal from -SIG or -9 format
                sig = token[1:].upper()
                if sig:
                    signal = sig
        else:
            # PID or job spec
            pids.append(token)

        i += 1

    if not pids:
        return False, "kill requires at least one PID"

    # Validate signal if specified
    if signal and signal not in allowed_signals:
        return False, f"kill blocked: signal '{signal}' not in allowed signals: {allowed_signals}"

    # Validate PIDs
    for pid in pids:
        # Allow job specs like %1
        if pid.startswith("%"):
            continue

        try:
            pid_num = int(pid)
            # Block killing init (PID 1)
            if pid_num == 1:
                return False, "kill blocked: cannot kill PID 1 (init)"
            # Block negative PIDs (process groups)
            if pid_num < 0:
                return False, f"kill blocked: negative PID (process group) not allowed: {pid}"
            # Block very low PIDs (system processes)
            if pid_num < 100:
                return False, f"kill blocked: system process PID not allowed: {pid}"
        except ValueError:
            # Not a number, might be from a variable like $PID - allow with caution
            pass

    return True, ""


def validate_docker_command(command_string: str) -> tuple[bool, str]:
    """
    Validate docker commands - block volume mounts outside project directory.

    Returns:
        Tuple of (is_allowed, reason_if_blocked)
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return False, "Could not parse docker command"

    if not tokens or tokens[0] != "docker":
        return False, "Not a docker command"

    # Check for volume mounts (-v or --volume)
    for i, token in enumerate(tokens):
        if token in ("-v", "--volume") and i + 1 < len(tokens):
            volume_spec = tokens[i + 1]
            # Volume spec format: host_path:container_path or host_path:container_path:options
            if ":" in volume_spec:
                host_path = volume_spec.split(":")[0]
                # Block absolute paths outside project (project validation will happen later)
                # For now, just warn about dangerous patterns
                if host_path in ("/", "/home", "/etc", "/usr", "/var"):
                    return False, f"Docker volume mount of system directory not allowed: {host_path}"

    return True, ""


def validate_systemctl_command(command_string: str) -> tuple[bool, str]:
    """
    Validate systemctl commands - only allow status/show operations, block start/stop/enable.

    Returns:
        Tuple of (is_allowed, reason_if_blocked)
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return False, "Could not parse systemctl command"

    if not tokens or tokens[0] != "systemctl":
        return False, "Not a systemctl command"

    # Allowed systemctl operations (read-only)
    allowed_operations = {"status", "show", "list-units", "list-unit-files", "is-active", "is-enabled"}

    # Find the operation (first non-flag token after systemctl)
    operation = None
    for token in tokens[1:]:
        if not token.startswith("-"):
            operation = token
            break

    if operation not in allowed_operations:
        return False, f"systemctl operation '{operation}' not allowed (only {allowed_operations} permitted)"

    return True, ""


def validate_init_script(command_string: str) -> tuple[bool, str]:
    """
    Validate script execution - only allow ./<script-name>.sh.

    Returns:
        Tuple of (is_allowed, reason_if_blocked)
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return False, "Could not parse environment setup script command"

    if not tokens:
        return False, "Empty command"

    # The command should be exactly ./<script-name>.sh (possibly with arguments)
    script = tokens[0]

    # Allow ./<script-name>.sh or paths ending in /<script-name>.sh
    if script == "./start.sh" or script.endswith("/start.sh") or script == "./restart.sh" or script.endswith("/restart.sh") or script == "./stop.sh" or script.endswith("/stop.sh"):
        return True, ""

    return False, f"Only ./start.sh, ./restart.sh, ./stop.sh is allowed, got: {script}"


def validate_cp_source_path(source_path: str) -> tuple[bool, str]:
    """
    Validate cp source paths to prevent copying sensitive system files.

    Security checks:
    1. Block access to sensitive system directories
    2. Block access to user credential files
    3. Allow project-relative and /tmp paths

    Args:
        source_path: The source path to validate

    Returns:
        Tuple of (is_allowed, reason_if_blocked)
    """
    if not source_path:
        return False, "Empty source path"

    # Expand home directory
    expanded_path = os.path.expanduser(source_path)

    # Check against sensitive directories
    for sensitive in SENSITIVE_SYSTEM_DIRECTORIES:
        expanded_sensitive = os.path.expanduser(sensitive)

        # Check exact match
        if expanded_path == expanded_sensitive:
            return False, f"cp blocked: cannot copy from sensitive path '{source_path}'"

        # Check if source is under a sensitive directory
        if expanded_path.startswith(expanded_sensitive + "/"):
            return False, f"cp blocked: cannot copy from sensitive directory '{sensitive}'"

        # Check if path contains sensitive filename patterns
        if sensitive in ("credentials", "secrets", ".env"):
            path_lower = source_path.lower()
            if sensitive in path_lower and not path_lower.startswith("./"):
                # Only block if it looks like a system path, not a project-relative path
                if source_path.startswith("/") or source_path.startswith("~"):
                    return False, f"cp blocked: cannot copy sensitive file pattern '{source_path}'"

    return True, ""


def get_command_for_validation(cmd: str, segments: list[str]) -> str:
    """
    Find the specific command segment that contains the given command.

    Args:
        cmd: The command name to find
        segments: List of command segments

    Returns:
        The segment containing the command, or empty string if not found
    """
    for segment in segments:
        segment_commands = extract_commands(segment)
        if cmd in segment_commands:
            return segment
    return ""


def extract_file_paths_from_command(command_string: str) -> list[str]:
    """
    Extract file paths from a bash command.

    Handles special cases:
    - Source/dest commands (cp, mv): validates both paths
    - Output flags (curl -o, unzip -d, jar -C): validates output paths
    - Script execution (python, node, java): validates script paths
    - Archive extraction: validates target directories

    Args:
        command_string: The bash command string

    Returns:
        List of potential file paths found in the command
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        # If we can't parse, return empty (will be handled by caller)
        return []

    if not tokens:
        return []

    # Get the base command
    cmd = os.path.basename(tokens[0])

    # Commands that operate on file paths
    file_operation_commands = {
        "cat", "cp", "mv", "rm", "rmdir", "mkdir", "chmod",
        "touch", "ls", "find", "head", "tail", "tee", "stat",
        "grep", "awk", "wc", "ln"
    }

    # Commands that can write to arbitrary locations
    output_commands = {
        "curl": ["-o", "--output", "-O"],  # Download to file
        "wget": ["-O", "--output-document"],  # Download to file
        "unzip": ["-d"],  # Extract to directory
        "jar": ["-C"],  # Change to directory
        "git": ["clone", "--work-tree", "--git-dir"],  # Git operations with paths
    }

    # Script execution commands
    script_commands = {
        "python", "python3", "node", "java", "bash", "sh"
    }

    paths = []
    skip_next = False
    i = 1

    # Special handling for different command types
    if cmd in output_commands:
        # Extract paths following output flags
        output_flags = output_commands[cmd]
        while i < len(tokens):
            token = tokens[i]
            if token in output_flags:
                # Next token is the output path
                if i + 1 < len(tokens):
                    paths.append(tokens[i + 1])
                    i += 2
                    continue
            # For curl/wget, also check positional arguments after options
            if not token.startswith("-"):
                # Check if this looks like a path (for commands that might have path arguments)
                if cmd in {"unzip", "jar"} and ("/" in token or token.startswith(".")):
                    paths.append(token)
            i += 1

    elif cmd == "git":
        # Git has many subcommands, validate paths in clone, --work-tree, etc.
        j = 1
        while j < len(tokens):
            token = tokens[j]
            if token == "clone" and j + 2 < len(tokens):
                # git clone <url> <dest> - validate dest
                # Skip the URL (next token) and get the destination
                if not tokens[j + 2].startswith("-"):
                    paths.append(tokens[j + 2])
                j += 3
            elif token in {"--work-tree", "--git-dir"} and j + 1 < len(tokens):
                paths.append(tokens[j + 1])
                j += 2
            else:
                j += 1

    elif cmd in script_commands:
        # For script execution, validate the script path
        for j in range(1, len(tokens)):
            token = tokens[j]
            if not token.startswith("-"):
                # First non-flag argument is likely the script path
                if "/" in token or token.startswith(".") or token.startswith("~"):
                    paths.append(token)
                break  # Only check the script path, not args to the script

    elif cmd in file_operation_commands:
        # Standard file operation commands
        while i < len(tokens):
            token = tokens[i]

            if skip_next:
                skip_next = False
                i += 1
                continue

            # Skip flags
            if token.startswith("-"):
                i += 1
                continue

            # Skip redirections and pipes
            if token in (">", ">>", "<", "|", "2>", "&>", "2>&1"):
                skip_next = True  # Skip the next token (the redirect target)
                i += 1
                continue

            # Check if this looks like a file path
            is_path = (
                token.startswith("/") or  # Absolute path
                token.startswith("~/") or  # Home directory
                token.startswith("./") or  # Current directory
                token.startswith("../") or  # Parent directory
                "/" in token or  # Contains directory separator
                (not token.startswith("-") and cmd in {"rm", "rmdir", "mkdir", "chmod", "touch", "ln"})  # Likely a path for these commands
            )

            if is_path:
                paths.append(token)

            i += 1

    # Also check for output redirection in any command (>, >>)
    for j, token in enumerate(tokens):
        if token in (">", ">>") and j + 1 < len(tokens):
            paths.append(tokens[j + 1])

    return paths


def validate_path_within_project(
    path: str, project_dir: Path, operation: str = "access", allow_tmp: bool = False
) -> tuple[bool, str]:
    """
    Validate that a file path is within the project directory or /tmp.

    Security checks:
    1. Resolve symlinks and relative paths to absolute paths
    2. Ensure resolved path is within project directory tree
    3. Allow /tmp directory as exception if allow_tmp=True
    4. Block path traversal (../, ~, absolute paths outside project)

    Args:
        path: The file path to validate (can be relative or absolute)
        project_dir: The project directory to restrict operations to
        operation: Description of the operation for error messages
        allow_tmp: If True, allow /tmp directory as an exception

    Returns:
        Tuple of (is_valid, reason_if_invalid)
    """
    if not path or not isinstance(path, str):
        return False, f"Invalid path type: {type(path)}"

    try:
        # Resolve the project directory to absolute path
        project_resolved = project_dir.resolve()

        # Handle home directory expansion
        expanded_path = os.path.expanduser(path)

        # Resolve the target path to absolute path (follows symlinks)
        if os.path.isabs(expanded_path):
            path_resolved = Path(expanded_path).resolve()
        else:
            # Relative paths are resolved from project directory
            path_resolved = (project_dir / expanded_path).resolve()

        # Check if path is within /tmp (if allowed)
        if allow_tmp:
            tmp_dir = Path("/tmp").resolve()
            try:
                path_resolved.relative_to(tmp_dir)
                return True, ""  # Path is in /tmp - allowed
            except ValueError:
                pass  # Not in /tmp, continue checking project directory

        # Check if the resolved path is within the project directory
        # is_relative_to() returns True only if path is under project_resolved
        try:
            path_resolved.relative_to(project_resolved)
            return True, ""
        except ValueError:
            # Path is outside project directory
            return (
                False,
                f"Path escapes project directory: '{path}' resolves to '{path_resolved}' "
                f"which is outside '{project_resolved}'. {operation} denied for security."
            )

    except (ValueError, OSError) as e:
        # Fail-safe: if we can't validate the path, block it
        return False, f"Cannot validate path '{path}': {e}"


async def bash_security_hook(input_data, tool_use_id=None, context=None):
    """
    Pre-tool-use hook that validates bash commands using an allowlist.

    Only commands in ALLOWED_COMMANDS are permitted, and file paths
    must be within the project directory.

    Args:
        input_data: Dict containing tool_name and tool_input
        tool_use_id: Optional tool use ID
        context: Optional context (must contain project_dir)

    Returns:
        Empty dict to allow, or {"decision": "block", "reason": "..."} to block
    """
    if input_data.get("tool_name") != "Bash":
        return {}

    command = input_data.get("tool_input", {}).get("command", "")
    if not command:
        return {}

    # Extract all commands from the command string (top-level + inside substitutions)
    commands = extract_commands(command)
    substitution_commands = extract_substitution_commands(command)
    commands = commands + substitution_commands

    if not commands:
        # Could not parse - fail-safe by blocking
        return {
            "decision": "block",
            "reason": f"Could not parse command for security validation: {command}",
        }

    # Get project directory from context for path validation
    project_dir = None
    if context and "project_dir" in context:
        project_dir = context["project_dir"]
        if not isinstance(project_dir, Path):
            project_dir = Path(project_dir)

    # Split into segments for per-command validation
    segments = split_command_segments(command)

    # Check each command against the allowlist
    for cmd in commands:
        if cmd not in ALLOWED_COMMANDS:
            return {
                "decision": "block",
                "reason": f"Command '{cmd}' is not in the allowed commands list.",
            }

        # Additional validation for sensitive commands
        if cmd in COMMANDS_NEEDING_EXTRA_VALIDATION:
            # Find the specific segment containing this command
            cmd_segment = get_command_for_validation(cmd, segments)
            if not cmd_segment:
                cmd_segment = command  # Fallback to full command

            if cmd == "pkill":
                allowed, reason = validate_pkill_command(cmd_segment)
                if not allowed:
                    return {"decision": "block", "reason": reason}
            elif cmd == "chmod":
                allowed, reason = validate_chmod_command(cmd_segment)
                if not allowed:
                    return {"decision": "block", "reason": reason}
            elif cmd in ("start.sh", "restart.sh", "stop.sh"):
                allowed, reason = validate_init_script(cmd_segment)
                if not allowed:
                    return {"decision": "block", "reason": reason}
            elif cmd == "docker":
                allowed, reason = validate_docker_command(cmd_segment)
                if not allowed:
                    return {"decision": "block", "reason": reason}
            elif cmd == "systemctl":
                allowed, reason = validate_systemctl_command(cmd_segment)
                if not allowed:
                    return {"decision": "block", "reason": reason}
            elif cmd == "rm":
                allowed, reason = validate_rm_command(cmd_segment)
                if not allowed:
                    return {"decision": "block", "reason": reason}
            elif cmd == "rmdir":
                allowed, reason = validate_rmdir_command(cmd_segment)
                if not allowed:
                    return {"decision": "block", "reason": reason}
            elif cmd == "kill":
                allowed, reason = validate_kill_command(cmd_segment)
                if not allowed:
                    return {"decision": "block", "reason": reason}

    # CRITICAL: Validate file paths are within project directory
    if project_dir:
        file_paths = extract_file_paths_from_command(command)

        # Get the base command for special handling (reuse already-parsed commands)
        cmd_base = os.path.basename(commands[0]) if commands else None

        # Special handling for cp and mv - check which paths are source vs destination
        if cmd_base in {"cp", "mv"}:
            try:
                tokens = shlex.split(command)
                # For cp/mv, last argument is destination, everything else is source
                paths = [t for t in tokens[1:] if not t.startswith("-") and t not in (">", ">>", "<", "|")]

                if len(paths) >= 2:
                    dest = paths[-1]
                    sources = paths[:-1]

                    # Validate destination (must be in project or /tmp)
                    is_valid, reason = validate_path_within_project(dest, project_dir, "Destination path", allow_tmp=True)
                    if not is_valid:
                        return {
                            "decision": "block",
                            "reason": f"Bash command blocked: {reason}\nCommand: {command}"
                        }

                    # For mv, also validate sources (cannot move files from outside)
                    if cmd_base == "mv":
                        for src in sources:
                            is_valid, reason = validate_path_within_project(src, project_dir, "Source path (mv)", allow_tmp=True)
                            if not is_valid:
                                return {
                                    "decision": "block",
                                    "reason": f"Bash command blocked: mv source {reason}\nCommand: {command}"
                                }
                    # For cp, first validate sources are within project (or /tmp), then check sensitive dirs
                    elif cmd_base == "cp":
                        for src in sources:
                            # First check if source is within project or /tmp (allow)
                            is_valid, reason = validate_path_within_project(src, project_dir, "cp source path", allow_tmp=True)
                            if is_valid:
                                continue  # Path is within project/tmp, allow

                            # If not in project/tmp, check if it's trying to access sensitive system directories
                            is_valid, reason = validate_cp_source_path(src)
                            if not is_valid:
                                return {
                                    "decision": "block",
                                    "reason": f"Bash command blocked: {reason}\nCommand: {command}"
                                }

            except ValueError:
                pass  # Fall through to general validation

        # For all other commands, validate all paths (allow /tmp)
        else:
            for path in file_paths:
                is_valid, reason = validate_path_within_project(path, project_dir, "File operation", allow_tmp=True)
                if not is_valid:
                    return {
                        "decision": "block",
                        "reason": f"Bash command blocked: {reason}\nCommand: {command}"
                    }

    return {}
