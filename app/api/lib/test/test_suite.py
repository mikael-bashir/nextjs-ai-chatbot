# import asyncio
# import httpx
# import json
# import uuid

# # --- CONFIGURATION ---
# BASE_URL = "http://localhost:5328"
# CHAT_ENDPOINT = f"{BASE_URL}/api/chat/canary"
# AUTH_ENDPOINT = f"{BASE_URL}/api/mcp/start-auth"

# # Adjust the model to match what you are using (e.g., "claude-3-5-sonnet-20241022", "gpt-4o", etc.)
# # MODEL = "xai/grok-3-mini" 

# # Put all your independent test queries here
# TEST_QUERIES = [
#     "Prove that 1 + 1 = 2 using rfl.",
#     "Write a Lean 4 proof that addition is commutative for natural numbers.",
#     "Attempt to prove 1 = 2 in Lean 4 and tell me what the error is.",
#     "Prove that for any integer n, n * 0 = 0."
# ]

# # (Optional) Provide your MCP Server details to auto-connect before testing
# MCP_SERVER_URL = "http://localhost:7860/sse" 
# MCP_SERVER_NAME = "Leak-II-Daemon"

# async def authenticate_mcp(client: httpx.AsyncClient):
#     """Hits your /start-auth endpoint to ensure tools are loaded before testing."""
#     print(f"🔌 Authenticating MCP Server: {MCP_SERVER_NAME}...")
#     try:
#         payload = {
#             "url": MCP_SERVER_URL,
#             "name": MCP_SERVER_NAME,
#             "authType": "none",
#             "credentials": {}
#         }
#         response = await client.post(AUTH_ENDPOINT, json=payload, timeout=60.0)
#         response.raise_for_status()
#         data = response.json()
#         if data.get("success"):
#             print(f"✅ MCP Authenticated! Loaded {len(data.get('tools', []))} tools.\n")
#         else:
#             print(f"⚠️ MCP Auth returned false: {data.get('message')}\n")
#     except Exception as e:
#         print(f"⚠️ Could not auto-authenticate MCP (is the backend running?): {e}\n")


# async def run_single_test(client: httpx.AsyncClient, query: str) -> str:
#     """Runs a single query in complete isolation."""
#     # A fresh UUID guarantees Mem0 and the conversational tree treat this as a blank slate
#     chat_id = str(uuid.uuid4())
    
#     payload = {
#         "id": chat_id,
#         "model": MODEL,
#         "messages": [{"role": "user", "content": query}]
#     }
    
#     final_answer = ""
    
#     try:
#         print(f"🧪 [Chat ID: {chat_id[:8]}] Testing: '{query}'")
        
#         # We use stream() to read the SSE events exactly as the React frontend would
#         async with client.stream("POST", CHAT_ENDPOINT, json=payload, timeout=300.0) as response:
#             response.raise_for_status()
            
#             async for line in response.aiter_lines():
#                 if line.startswith("data: "):
#                     data_str = line[6:]
#                     try:
#                         data = json.loads(data_str)
#                         event_type = data.get("type")
                        
#                         # Print live progress to the console
#                         if event_type == "status":
#                             print(f"  ⏳ {data.get('message')}")
#                         elif event_type == "tool_intent":
#                             print(f"  🔧 Tool Call: {data.get('tool')}")
#                         elif event_type == "error":
#                             print(f"  ❌ Backend Error: {data.get('message')}")
#                             return f"ERROR: {data.get('message')}"
#                         elif event_type == "text_response":
#                             # The agent has finalized a text response block
#                             final_answer = data.get("text", "")
#                         elif event_type == "done":
#                             print(f"  🏁 Agent finished processing.")
#                             break
#                     except json.JSONDecodeError:
#                         pass # Ignore malformed JSON or invisible padding strings
                        
#         return final_answer

#     except httpx.HTTPStatusError as e:
#         print(f"  💥 HTTP Error: {e.response.status_code} - {e.response.text}")
#         return f"HTTP EXCEPTION: {e.response.status_code}"
#     except Exception as e:
#         print(f"  💥 Unexpected Exception: {e}")
#         return f"EXCEPTION: {str(e)}"


# async def run_all_tests():
#     print(f"🚀 Starting Automated Testing Suite ({len(TEST_QUERIES)} queries)...\n")
    
#     # We use a single httpx client to manage connection pooling efficiently
#     timeout = httpx.Timeout(300.0)
#     async with httpx.AsyncClient(timeout=timeout) as client:
        
#         # Step 1: Ensure the MCP server is connected so tools are available
#         await authenticate_mcp(client)
        
#         # Step 2: Loop through each test sequentially
#         for idx, query in enumerate(TEST_QUERIES, 1):
#             print(f"==================================================")
#             print(f"📝 TEST {idx}/{len(TEST_QUERIES)}")
#             print(f"==================================================")
            
#             # The test is executed. Any crashes are caught inside run_single_test,
#             # ensuring the loop moves on to the next one safely.
#             result = await run_single_test(client, query)
            
#             print(f"\n📊 FINAL ANSWER FOR TEST {idx}:")
#             print(f"{result}")
#             print(f"\n")

# if __name__ == "__main__":
#     asyncio.run(run_all_tests())