"""
Claude SDK Client Implementation
=================================

Claude Agent SDK client wrapper implementing the BaseClient interface.
"""

import json
from datetime import datetime
from pathlib import Path
from typing import AsyncGenerator, Any
import logging

from clients.base_client import BaseClient
from clients.security import bash_security_hook
from shared.rate_limit import is_rate_limit_error, RateLimitExceeded
from agents.tools import BUILTIN_TOOLS
from agents.mcp_config import load_mcp_servers
from agents.mcp_tools import build_allowed_tools_from_servers
from agents.chrome_cleanup import cleanup_chrome_profile_lock

logger = logging.getLogger(__name__)


class ClaudeClientWrapper(BaseClient):
    """
    Wrapper for ClaudeSDKClient implementing the BaseClient interface.

    This allows the Claude SDK client to be used interchangeably with
    other AI client implementations through a common interface.
    """

    @property
    def is_sdk_based(self) -> bool:
        """Claude uses SDK (asyncio-native), not CLI subprocess.

        Returns:
            bool: True for Claude SDK client
        """
        return True

    def __init__(self, sdk_client, project_dir: Path):
        """
        Initialize the wrapper.

        Args:
            sdk_client: Configured ClaudeSDKClient instance
            project_dir: Project directory for this session
        """
        self._client = sdk_client
        self._project_dir = project_dir
    
    async def query(self, message: str) -> None:
        """Send a query to the Claude SDK client with rate limit handling."""
        try:
            await self._client.query(message)
        except Exception as e:
            if is_rate_limit_error(e):
                logger.warning(f"Rate limit detected in query: {e}")
                raise RateLimitExceeded(str(e)) from e
            raise
    
    async def receive_response(self) -> AsyncGenerator[Any, None]:
        """Stream responses from the Claude SDK client with rate limit handling."""
        try:
            async for msg in self._client.receive_response():
                yield msg
        except Exception as e:
            if is_rate_limit_error(e):
                logger.warning(f"Rate limit detected in receive_response: {e}")
                raise RateLimitExceeded(str(e)) from e
            raise
    
    async def __aenter__(self):
        """Enter async context manager."""
        await self._client.__aenter__()
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Exit async context manager with Chrome lock cleanup."""
        try:
            await self._client.__aexit__(exc_type, exc_val, exc_tb)
        finally:
            # Clean up Chrome profile locks to prevent conflicts in next session
            try:
                cleanup_chrome_profile_lock()
            except Exception as e:
                logger.warning(f"Failed to clean Chrome profile locks: {e}")


def create_client(project_dir: Path | str, agent_prompt: str, model: str | None = None, enable_mcp_tools: bool = True) -> ClaudeClientWrapper:
    """
    Create a Claude Agent SDK client with multi-layered security and MCP tool support.

    Args:
        project_dir: Directory for the project (Path or string)
        model: Claude model to use (optional - SDK will use its default if not specified)
        enable_mcp_tools: If True, generate MCP tool allowlist from patterns; if False, use built-in only
        agent_prompt: Agent-specific prompt to append to Claude Code's system prompt.
                     Uses preset pattern for optimal prompt caching (REQUIRED).

    Returns:
        ClaudeClientWrapper implementing BaseClient interface

    Security layers (defense in depth):
    1. Sandbox - OS-level bash command isolation prevents filesystem escape
    2. Permissions - File operations restricted to project_dir only
    3. Security hooks - Bash commands validated against an allowlist
       (see security.py for ALLOWED_COMMANDS)
    """

    # Convert to Path if string
    if isinstance(project_dir, str):
        project_dir = Path(project_dir)

    # Note: Authentication is handled by the Claude SDK itself.
    # Works with either: 1) claude login (subscription) or 2) ANTHROPIC_API_KEY env var
    # The SDK will throw an appropriate error if not authenticated.

    # Load MCP servers from JSON config (project-level > global > bundled template)
    mcp_servers = load_mcp_servers(project_dir) if enable_mcp_tools else {}

    # Generate MCP tools from server configuration
    if enable_mcp_tools and mcp_servers:
        try:
            logger.info("Generating MCP tool allowlist from server configuration...")
            allowed_tools = build_allowed_tools_from_servers(
                mcp_servers=mcp_servers,
                builtin_tools=BUILTIN_TOOLS
            )
        except Exception as e:
            logger.error(f"MCP tool generation failed: {e}, using built-in tools only")
            allowed_tools = list(BUILTIN_TOOLS)
    else:
        logger.info("MCP tool generation disabled, using built-in tools only")
        allowed_tools = list(BUILTIN_TOOLS)

    # Create comprehensive security settings
    # Note: Using relative paths ("./**") restricts access to project directory
    # since cwd is set to project_dir
    # Create a wrapper for bash_security_hook that injects project_dir into context
    async def bash_security_hook_with_context(input_data, tool_use_id=None, context=None):
        """Wrapper that adds project_dir to context before calling bash_security_hook."""
        if context is None:
            context = {}
        context["project_dir"] = project_dir
        return await bash_security_hook(input_data, tool_use_id, context)

    # Build security settings with discovered tools
    security_settings = {
        "sandbox": {"enabled": True, "autoAllowBashIfSandboxed": True},
        "permissions": {
            "defaultMode": "acceptEdits",  # Auto-approve edits within allowed directories
            "allow": [
                # Allow all file operations within the project directory
                "Read(./**)",
                "Write(./**)",
                "Edit(./**)",
                "Glob(./**)",
                "Grep(./**)",
                # Bash permission granted here, but actual commands are validated
                # by the bash_security_hook (see security.py for allowed commands)
                # Paths in bash commands are also validated (see security.py)
                "Bash(*)",
                "WebFetch(*)",
                "WebSearch",
                # MCP tools are added to allowed_tools, not here
                *allowed_tools,
            ],
        },
    }

    # Ensure project directory exists before creating settings file
    project_dir.mkdir(parents=True, exist_ok=True)

    # Clean up Chrome profile locks before starting (safe - just removes lock files)
    logger.info("Cleaning Chrome profile locks...")
    from agents.chrome_cleanup import cleanup_chrome_profile_lock
    try:
        cleanup_chrome_profile_lock()
    except Exception as e:
        logger.warning(f"Chrome lock cleanup failed (non-fatal): {e}")

    # Write settings to a file in the project directory
    settings_file = project_dir / ".claude_settings.json"
    with open(settings_file, "w") as f:
        json.dump(security_settings, f, indent=2)

    # Count MCP tools for reporting
    mcp_tool_count = len([t for t in allowed_tools if t.startswith('mcp__')])
    builtin_count = len([t for t in allowed_tools if not t.startswith('mcp__')])

    print(f"Created security settings at {settings_file}")
    print("   - Sandbox enabled (OS-level bash isolation)")
    print(f"   - Filesystem restricted to: {project_dir.resolve()}")
    print("   - Bash commands restricted to allowlist (see security.py)")
    print(f"   - Tools: {builtin_count} built-in, {mcp_tool_count} MCP tools")
    if enable_mcp_tools:
        # Count servers from allowed_tools
        mcp_servers_with_tools = len(set(
            t.split('__')[1] for t in allowed_tools if t.startswith('mcp__')
        ))
        print(f"   - MCP servers: {mcp_servers_with_tools}/{len(mcp_servers)} connected")
    print(f"Current time: {datetime.now().isoformat()}")
    print()

    # Build options dict with discovered tools
    #
    # PROMPT CACHING STRATEGY:
    # When agent_prompt is provided, use the preset pattern to enable Claude's prompt caching:
    # 1. system_prompt uses "claude_code" preset (includes tool instructions, cached automatically)
    # 2. agent_prompt is appended to the preset (static agent instructions, also cached)
    # 3. Only dynamic content (metrics, user messages, errors) sent via query()
    # 4. The SDK automatically adds cache_control markers to system prompts
    #
    # This enables significant cost savings and latency reduction through prompt caching.

    # Use preset + append pattern for optimal caching
    # agent_prompt is required and contains agent-specific instructions
    system_prompt_config = {
        "type": "preset",
        "preset": "claude_code",  # Claude Code's instructions (cached)
        "append": agent_prompt     # Agent-specific instructions (cached)
    }

    from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
    from claude_agent_sdk.types import HookMatcher

    options_dict = {
        "system_prompt": system_prompt_config,
        "allowed_tools": allowed_tools,  # Dynamically discovered tools
        "mcp_servers": mcp_servers,
        "hooks": {
            "PreToolUse": [
                HookMatcher(matcher="Bash", hooks=[bash_security_hook_with_context]),
            ],
        },
        "max_turns": 200,
        "cwd": str(project_dir.resolve()),
        "settings": str(settings_file.resolve()),  # Use absolute path
    }

    # Only add model if explicitly specified
    if model is not None:
        options_dict["model"] = model

    # Add max_buffer_size to handle large tool responses (e.g., screenshots)
    # Default is 1MB which is too small for many browser screenshots
    # Set to 10MB to accommodate large responses
    options_dict["max_buffer_size"] = 10 * 1024 * 1024  # 10MB

    sdk_client = ClaudeSDKClient(options=ClaudeAgentOptions(**options_dict))
    
    # Create and return wrapped client with project_dir for session tracking
    return ClaudeClientWrapper(sdk_client, project_dir)
