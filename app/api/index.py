# run command: hypercorn app.api.index:app --bind 0.0.0.0:5328 --reload

from dotenv import load_dotenv
load_dotenv()

import nest_asyncio
nest_asyncio.apply()

from quart import Quart, request, jsonify #, redirect
from quart_session import Session
from quart_cors import cors
import logging
import uuid
import redis # <-- NEW: Import the redis library
import os # <-- NEW: Import os to read the environment variable
from typing import Dict, Any
from app.api.lib.leak.main import prompt_leak_agent
import httpx
from fastmcp import Client
from fastmcp.client.transports import SSETransport
from contextlib import AsyncExitStack


app = Quart(__name__)
app = cors(app, allow_origin=["http://localhost:3000"], allow_credentials=True)

app.config["SECRET_KEY"] = "super-secret-key-change-in-production"
app.config["SESSION_TYPE"] = "redis"
app.config["SESSION_REDIS"] = redis.from_url(os.getenv("REDIS_URL"))
app.config["RESPONSE_TIMEOUT"] = 100000000
Session(app)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - [MCP Backend] %(message)s'
)

logger = logging.getLogger(__name__)

# ==========================================
# 1. THE AUTH & CONNECTION MANAGER
# ==========================================

class MCPConnectionManager:
    """Centralized manager for all MCP server connections, auth states, and tool caching."""
    def __init__(self):
        self.active_servers: Dict[str, Any] = {}
        logger.info("MCP Connection Manager Initialized.")

    async def authenticate_and_connect(self, server_url: str, server_name: str, auth_type: str, credentials: Any):

        for existing_id, server_data in self.active_servers.items():
            if server_data["server_url"] == server_url and server_data["server_name"] == server_name:
                logger.info(f"Server '{server_name}' is already connected. Reusing existing session to prevent duplicate tools.")
                return existing_id, server_data["tools"]
            
        # 1. Build the HTTP Headers conditionally
        logger.info(f"Attempting to connect to MCP Server: '{server_name}' at {server_url} (Auth: {auth_type})")
        headers = {}
        
        # Only extract tokens and build headers if auth is explicitly requested
        if auth_type == "bearer":
            token = credentials if isinstance(credentials, str) else credentials.get("token", "")
            if token:
                logger.info("Injected Bearer Token into headers.")
                headers["Authorization"] = f"Bearer {token}"
        elif auth_type == "apikey":
            api_key = credentials if isinstance(credentials, str) else credentials.get("apiKey", "")
            if api_key:
                logger.info("Injected API Key into headers.")
                headers["Authorization"] = f"Bearer {api_key}"

        # 2. Inject headers into the SSETransport
        try:
            if auth_type == "oauth":
                logger.info("Initializing OAuth client...")
                client = Client(server_url, auth="oauth")
            else:
                logger.info(f"Initializing SSE Transport. Attached headers: {list(headers.keys())}")
                # Pass the dynamically built `headers` dictionary. 
                # If auth_type is "none", this is just {}, which httpx handles perfectly.
                def custom_timeout_factory(
                    headers: dict[str, str] | None = None,
                    timeout: httpx.Timeout | None = None,
                    auth: httpx.Auth | None = None,
                ) -> httpx.AsyncClient:
                    """A factory that perfectly matches McpHttpClientFactory but forces a 5-minute timeout."""
                    # We ignore the default 30s timeout passed in and enforce our 300s one
                    forced_timeout = httpx.Timeout(300.0)
                    
                    return httpx.AsyncClient(
                        headers=headers,
                        timeout=forced_timeout,
                        auth=auth,
                        follow_redirects=True # Matches standard MCP behavior
                    )
                

                transport = SSETransport(
                    url=server_url,
                    headers=headers,
                    httpx_client_factory=custom_timeout_factory
                )
                client = Client(transport)

        except Exception as e:
            logger.error(f"Failed to initialize client wrapper: {str(e)}")
            raise ValueError(f"Failed to initialize client wrapper: {str(e)}")

        # 3. Connect, Verify, and Pre-Fetch Tools
        try:
            logger.info("Executing initial connection...")
            stack = AsyncExitStack()
            await stack.enter_async_context(client)
            
            logger.info("Executing initial ping...")
            await client.ping()
            
            logger.info("Ping successful. Fetching tools...")
            raw_tools = await client.list_tools()

            # Format tools immediately for the frontend
            formatted_tools = []
            for tool in raw_tools:
                formatted_tools.append({
                    "name": getattr(tool, 'name', str(tool)),
                    "description": getattr(tool, 'description', ""),
                    "inputSchema": getattr(tool, 'inputSchema', {})
                })

            logger.info(f"Successfully fetched {len(formatted_tools)} tools from '{server_name}'.")
            
            server_id = str(uuid.uuid4())
            self.active_servers[server_id] = {
                "client": client,
                "stack": stack,
                "server_url": server_url,
                "server_name": server_name,
                "auth_type": auth_type,
                "tools": formatted_tools,
                "credentials": credentials,
                "authenticated_at": "now"
            }

            return server_id, formatted_tools

        except Exception as e:
            logger.error(f"Connection/Ping failed for '{server_name}': {str(e)}")
            raise ConnectionError(f"Failed to connect to MCP server: {str(e)}")

    async def call_tool(self, server_id: str, tool_name: str, arguments: dict):
        """Ensures the correct client session and auth state is used at execution time."""
        server = self.active_servers.get(server_id)
        if not server:
            logger.error(f"Call Tool Failed: Server ID {server_id} not found in active memory.")
            raise ValueError("Server not found or disconnected.")
        
        client = server["client"]
        logger.info(f"Executing tool '{tool_name}' on server '{server['server_name']}'...")
        result = await client.call_tool(tool_name, arguments)
        logger.info(f"Tool '{tool_name}' executed successfully.")
        return result.dict() if hasattr(result, 'dict') else str(result)
    
# Instantiate the Singleton Manager
mcp_manager = MCPConnectionManager() 

# ==========================================
# 2. THE API ROUTES
# ==========================================

@app.route("/api/mcp/start-auth", methods=["POST"])
async def authenticate_mcp_server():
    """Unified endpoint for all auth types."""
    data = await request.get_json()
    server_url = data.get("url")
    server_name = data.get("name", "Unnamed Server")
    auth_type = data.get("authType", "none")
    credentials = data.get("credentials", {})

    logger.info(f"Incoming /start-auth request for {server_name}")

    if not server_url:
        logger.warning("Auth rejected: URL is missing.")
        return jsonify({"success": False, "message": "url is required"}), 400

    try:
        logger.info(f"trying connect with data: {server_url}, {server_name}, {auth_type}, {credentials}")
        server_id, tools = await mcp_manager.authenticate_and_connect(server_url, server_name, auth_type, credentials)
        
        return jsonify({
            "success": True, 
            "server_id": server_id,
            "tools": tools,
            "message": "Connected and tools loaded."
        })

    except Exception as e:
        logger.error(f"Auth flow failed for {server_name}: {e}")
        return jsonify({"success": False, "message": str(e)}), 500


@app.route("/api/mcp/servers/<server_id>/tools", methods=["GET"])
async def get_mcp_tools(server_id):
    """Retrieve pre-fetched tools from the manager."""
    logger.info(f"Incoming request for tools on server ID: {server_id}")
    server = mcp_manager.active_servers.get(server_id)
    if not server:
        logger.warning(f"Tools rejected: Server ID {server_id} not found.")
        return jsonify({"error": "FastMCP server not authenticated"}), 401
    
    return jsonify({"tools": server["tools"]})


@app.route("/api/mcp/servers/<server_id>/call", methods=["POST"])
async def call_mcp_tool(server_id):
    """Execute a tool via the manager."""
    try:
        data = await request.get_json()
        tool_name = data.get("tool_name")
        arguments = data.get("arguments", {})

        if not tool_name:
            return jsonify({"success": False, "error": "tool_name is required"}), 400

        result = await mcp_manager.call_tool(server_id, tool_name, arguments)
        return jsonify({"success": True, "result": result})

    except Exception as e: 
        logger.error(f"Error calling tool: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/mcp/servers", methods=["GET"])
async def list_authenticated_servers():
    """List all authenticated servers from the manager."""
    logger.info("Fetching list of all active servers in memory.")
    try:
        servers = []
        for server_id, info in mcp_manager.active_servers.items():
            servers.append({
                "id": server_id,
                "server_id": server_id,
                "server_url": info["server_url"],
                "url": info["server_url"],
                "name": info["server_name"],
                "authType": info["auth_type"],
                "authenticated_at": info["authenticated_at"],
                "status": "connected",
                "isActive": True,
                "description": "", 
                "credentials": {} 
            })
        return jsonify(servers)

    except Exception as e:
        logger.error(f"Failed to list servers: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/mcp/servers/<server_id>/ping", methods=["GET"])
async def ping_mcp_server(server_id):
    logger.info(f"Ping requested for server ID: {server_id}")
    server = mcp_manager.active_servers.get(server_id)
    if not server:
        logger.warning(f"Ping failed: Server {server_id} is not in active memory.")
        return jsonify({"connected": False}), 404

    try:
        client = server["client"]
        await client.ping()
        logger.info(f"Ping successful for '{server['server_name']}'.")
        return jsonify({"connected": True})
    except Exception as e:
        logger.error(f"Ping execution failed for '{server['server_name']}': {str(e)}")
        return jsonify({"connected": False})


@app.route("/api/mcp/servers/<server_id>", methods=["DELETE"])
async def disconnect_mcp_server(server_id):
    logger.info(f"Disconnect requested for server ID: {server_id}")
    
    server = mcp_manager.active_servers.get(server_id)
    if not server:
        return jsonify({"error": "Server not found"}), 404

    try:
        # THE FIX: Grab the stack we used to open the connection
        stack = server.get("stack")
        
        # Cleanly collapse the stack, which gracefully closes the client and all background tasks
        if stack:
            logger.info(f"Eminent disconnect attempt for server ID: {server_id}")
            await stack.aclose()
            logger.info(f"Successful post disconnect attempt for server ID: {server_id}")
        else:
            # Fallback just in case
            # client = server["client"]
            # if hasattr(client, 'close'):
            #     await client.close()
            pass

        # Remove from memory
        del mcp_manager.active_servers[server_id]
        
        logger.info(f"Server {server_id} fully disconnected and removed from memory.")
        return jsonify({"status": "disconnected", "message": "Disconnected successfully"})
    except Exception as e:
        logger.error(f"Error disconnecting server: {e}")
        return jsonify({"error": str(e)}), 500

    
@app.route("/api/chat/agent", methods=["POST"])
async def chat_with_agent():
    """Route requests to the Burr + LiteLLM Agent."""
    return await prompt_leak_agent(mcp_manager.active_servers)

if __name__ == "__main__":
    app.run(debug=True, port=5328, threaded=True)
