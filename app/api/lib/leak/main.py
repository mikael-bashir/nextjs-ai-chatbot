from dotenv import load_dotenv
import os
load_dotenv()

import logging
import time
import json
from typing import Dict, Any
import hashlib
from litellm.exceptions import RateLimitError
import asyncio
from quart import request, jsonify, Response
from litellm import acompletion, supports_function_calling
from litellm.router import Router
from burr.core import action, State, ApplicationBuilder, default, expr

from mem0 import MemoryClient
import threading

logger = logging.getLogger(__name__)

mem0_client = MemoryClient(api_key=os.getenv("MEM0_API_KEY"))

free_key_pool = [
    {
        "model_name": "grok-free-pool",
        "litellm_params": {"model": "xai/grok-3-mini", "api_key": os.environ.get("XAI_FREE_KEY_1")}
    },
    # {
    #     "model_name": "grok-free-pool",
    #     "litellm_params": {"model": "xai/grok-3-mini", "api_key": os.environ.get("XAI_FREE_KEY_2")}
    # },
    # {
    #     "model_name": "grok-free-pool",
    #     "litellm_params": {"model": "xai/grok-3-mini", "api_key": os.environ.get("XAI_FREE_KEY_3")}
    # }
]

# 2. Initialize the Router with a Round-Robin strategy
llm_router = Router(
    model_list=free_key_pool,
    routing_strategy="simple-shuffle",
    num_retries=3,
    timeout=600
)

pool_semaphore = asyncio.Semaphore(10*len(free_key_pool))

def get_key_hash(api_key: str) -> str:
    """Never store or log raw API keys in memory. Hash them to use as dictionary keys."""
    if not api_key:
        return "default_system_key" # Fallback for your free tier
    return hashlib.sha256(api_key.encode()).hexdigest()

@action(reads=["messages", "tools", "model", "stream_queue"], writes=["messages"])
async def chat_model(state: State) -> tuple[dict, State]:
    messages = state["messages"]
    tools = state.get("tools", [])
    model = state["model"]
    stream_queue = state.get("stream_queue")

    logger.info(f"Invoking {model} with {len(tools)} tools.")

    response = None

    try :
        async with pool_semaphore:
            if supports_function_calling(model):
                response = await llm_router.acompletion(
                    model=model,
                    messages=messages,
                    # Only pass tools to LiteLLM if the array actually has items
                    tools=tools if len(tools) > 0 else None,
                    temperature=0.3,
                    stream=True
                )
            else:
                response = await llm_router.acompletion(
                    model=model,
                    messages=messages,
                    temperature=0.3,
                    stream=True,
                )    
        
        full_content = ""
        tool_calls_dict = {}

        ''' 
        # implementation for no streaming     
        msg = response.choices[0].message # type: ignore
        
        msg_dict : Dict[str, Any] = {"role": msg.role, "content": msg.content or ""}
        if hasattr(msg, "tool_calls") and msg.tool_calls:
            msg_dict["tool_calls"] = [tc.model_dump() for tc in msg.tool_calls]
            
        return {"response": msg_dict}, state.append(messages=msg_dict)
        '''

        async for chunk in response:
            delta = chunk.choices[0].delta

            # A. Stream Text Thoughts directly to the UI
            if hasattr(delta, "content") and delta.content:
                full_content += delta.content
                if stream_queue:
                    # Note: We send the accumulated string because your React frontend 
                    # replaces the whole content block rather than appending raw deltas.
                    await stream_queue.put(("text_delta", full_content, None, None))

            # B. Reconstruct fragmented tool calls
            if hasattr(delta, "tool_calls") and delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index
                    if idx not in tool_calls_dict:
                        tool_calls_dict[idx] = {
                            "id": tc.id, 
                            "type": "function", 
                            "function": {"name": tc.function.name, "arguments": ""}
                        }
                    if tc.function and tc.function.arguments:
                        tool_calls_dict[idx]["function"]["arguments"] += tc.function.arguments

        # 🚨 3. Format the final message for Burr's state tracking
        msg_dict : Dict[str, Any] = {"role": "assistant", "content": full_content}
        if tool_calls_dict:
            msg_dict["tool_calls"] = list(tool_calls_dict.values())

        return {"response": msg_dict}, state.append(messages=msg_dict)

    except Exception as e:
        logger.error(f"LLM Invocation Failure: {str(e)}")
        error_msg = {"role": "assistant", "content": f"**System Error:** \n\n`{str(e)}`"}
        return {"response": error_msg}, state.append(messages=error_msg)


@action(reads=["messages", "tool_router"], writes=["messages"])
async def execute_tools(state: State) -> tuple[dict, State]:
    messages = state["messages"]
    tool_router = state["tool_router"] 
    last_msg = messages[-1]
    
    tool_results = []
    
    for tc in last_msg.get("tool_calls", []):
        tool_name = tc["function"]["name"]
        tool_args = json.loads(tc["function"]["arguments"])
        logger.info(f"Executing tool: {tool_name} with args: {tool_args}")
        
        client = tool_router.get(tool_name)
        if not client:
            result_str = f"Error: Tool {tool_name} not found on any active server."
        else:
            try:
                # 1. Execute the tool on the globally persistent connection
                result = await client.call_tool(tool_name, tool_args)
                
                # 2. FastMCP returns custom objects. We must format them into text for the LLM.
                if hasattr(result, "content") and isinstance(result.content, list):
                    texts = [c.text for c in result.content if getattr(c, "type", "") == "text"]
                    result_str = "\n".join(texts) if texts else str(result.content)
                elif hasattr(result, "dict"):
                    result_str = json.dumps(result.dict())
                else:
                    result_str = str(result)
                    
            except Exception as e:
                logger.error(f"Error executing {tool_name}: {str(e)}")
                result_str = f"Error executing {tool_name}: {str(e)}"
                
        tool_results.append({
            "role": "tool",
            "name": tool_name,
            "tool_call_id": tc["id"],
            "content": result_str
        })

    new_state = state
    for tr in tool_results:
        new_state = new_state.append(messages=tr)
        
    return {"tool_results": tool_results}, new_state


@action(reads=[], writes=[])
async def end(state: State) -> tuple[dict, State]:
    return {}, state


async def prompt_leak_agent(authenticated_clients: Dict[str, Any]):
    try:
        data = await request.get_json()
        messages = data.get("messages", [])
        raw_model = data.get("model")

        chat_id = data.get("id")
        
        # Ensure correct LiteLLM model prefixes
        if "gemini" in raw_model.lower() and not raw_model.startswith("gemini/"):
            model = f"gemini/{raw_model}"
        elif "grok" in raw_model.lower() and not raw_model.startswith("xai/"):
            model = "grok-free-pool"
        else:
            model = raw_model

        if not messages:
            return jsonify({"error": "Messages are required"}), 400
        
        latest_user_msg = messages[-1].get("content", "")
        
        # Search Mem0 for relevant past context linked strictly to this chat_id
        memories = mem0_client.search(query=latest_user_msg, filters={"user_id": chat_id})
        
        # Format the memories into a readable string for the LLM
        memory_context = ""
        if memories:
            memory_context = "\n\nRelevant Context from Previous Interactions:\n"
            for m in memories:
                if isinstance(m, dict):
                    fact = m.get("memory") or m.get("text", str(m))
                    memory_context += f"- {fact}\n"
                else:
                    # Fallback just in case Mem0 returns objects or strings directly
                    memory_context += f"- {str(m)}\n"
        
        system_directive = """You are a mathmatician equipped with state-of-the-art Lean4 tools. Your goal is to prove/disprove user statements.

        When you believe the proof is complete, you MUST synthesize your successful tool calls into a single, clean Lean 4 code block for the user. 
        Do not just say "the proof is complete." You must output the final theorem and the exact sequence of tactics/proven propositions/lemmas that solved it.

        Example of expected final output:
        ```lean4
        theorem and_comm (p q : Prop) : p ∧ q ↔ q ∧ p := by
        intro p q
        constructor
        · intro h
            exact ⟨h.right, h.left⟩
        · intro h
            exact ⟨h.right, h.left⟩
        ```"""

        if messages[0].get("role") == "system":
            # If your UI already sends a system message, append our strict rules to it
            messages[0]["content"] += f"\n\n{system_directive}"
        else:
            # Otherwise, insert it as the foundational system prompt at the very beginning
            messages.insert(0, {"role": "system", "content": system_directive})

        mcp_clients = [info["client"] for info in authenticated_clients.values()]
        openai_tools = []
        tool_router = {}

        # THE FIX: No AsyncExitStack! We just use the clients that are already open in index.py
        for client in mcp_clients:
            try:
                tools_list = await client.list_tools()
                for tool in tools_list:
                    t_name = tool.name if hasattr(tool, 'name') else str(tool)
                    t_desc = tool.description if hasattr(tool, 'description') else ""
                    t_schema = tool.inputSchema if hasattr(tool, 'inputSchema') else {"type": "object", "properties": {}}
                    
                    tool_router[t_name] = client
                    openai_tools.append({
                        "type": "function",
                        "function": {"name": t_name, "description": t_desc, "parameters": t_schema}
                    })
            except Exception as e:
                logger.error(f"Failed to load tools for agent: {e}")

        stream_queue = asyncio.Queue()

        logger.info(f"Starting Burr App Builder. Routing {len(openai_tools)} tools.")

        app_builder = (
            ApplicationBuilder()
            .with_state(messages=messages, tools=openai_tools, tool_router=tool_router, model=model, chat_id=chat_id, stream_queue=stream_queue)
            .with_actions(chat_model=chat_model, execute_tools=execute_tools, end=end)
            .with_transitions(
                ("chat_model", "execute_tools", expr("len(messages[-1].get('tool_calls', [])) > 0")),
                ("chat_model", "end", default),
                ("execute_tools", "chat_model", default)
            )
            .with_entrypoint("chat_model")
            .build()
        )

        # ==========================================
        # THE ASYNC KEEP-ALIVE GENERATOR
        # ==========================================
        async def event_generator():
            start_time = time.time()
            metrics: dict = {
                "tools_invoked": 0,
                "llm_invocations": 0,
            }

            # 1. Announce startup
            yield f"data: {json.dumps({'type': 'status', 'message': 'Agent booting up...', 'metrics': metrics})}\n\n"

            # 2. Create an async queue to decouple the heavy lifting from the stream
            # q = asyncio.Queue()

            # 3. Define Burr as a background worker
            async def run_burr():
                try:
                    final_state = None
                    async for action, result, state in app_builder.aiterate(halt_before=["end"]):
                        act_name = action.name if hasattr(action, 'name') else str(action)
                        print(f"🚨 [PYTHON] processing action:", action)
                        final_state = state
                        await stream_queue.put(("step", act_name, result, state))
                    await stream_queue.put(("done", None, None, final_state))
                except Exception as e:
                    logger.error(f"Burr iteration error: {e}")
                    await stream_queue.put(("error", str(e), None, None))

            # 4. Start Burr in the background
            task = asyncio.create_task(run_burr())

            try:
                while True:
                    try:
                        # Wait for Burr's next step, but WAKE UP every 10 seconds
                        msg_type, action_name, result, state = await asyncio.wait_for(stream_queue.get(), timeout=10.0)

                        if msg_type == "text_delta":
                            # action_name holds the full accumulated string here
                            yield f"data: {json.dumps({'type': 'text-delta', 'content': action_name})}\n\n"
                            continue

                        if msg_type == "error":
                            yield f"data: {json.dumps({'type': 'error', 'message': action_name})}\n\n"
                            break

                        if msg_type == "done":
                            yield f"data: {json.dumps({'type': 'done', 'message': 'Task complete.', 'metrics': metrics})}\n\n"

                            if state and "messages" in state:
                                final_assistant_msg = state["messages"][-1].get("content", "")
                                
                                def save_to_mem0():
                                    mem0_messages = [
                                        {"role": "user", "content": latest_user_msg},
                                        {"role": "assistant", "content": final_assistant_msg}
                                    ]
                                    mem0_client.add(messages=mem0_messages, user_id=chat_id)
                                    logger.info(f"[MEM0] Saved interaction to chat {chat_id}")
                                    
                                threading.Thread(target=save_to_mem0).start()
                                print(f"🚨 [PYTHON] saving final agent stste!")
                            break

                        elapsed = round(time.time() - start_time, 1)
                        metrics["time_elapsed"] = elapsed

                        if action_name == "chat_model":
                            metrics["llm_invocations"] += 1
                            msg = state["messages"][-1]

                            if msg.get("tool_calls"):
                                for tc in msg["tool_calls"]:
                                    t_name = tc["function"]["name"]
                                    metrics["tools_invoked"] += 1
                                    yield f"data: {json.dumps({'type': 'tool_intent', 'tool': t_name, 'message': f'Decided to use {t_name}...', 'metrics': metrics})}\n\n"
                            else:
                                content = msg.get("content", "")
                                logger.info(f"🚨 [PYTHON] Sending final text_response. Length: {len(content)}")
                                yield f"data: {json.dumps({'type': 'text_response', 'text': content, 'metrics': metrics})}\n\n"

                        elif action_name == "execute_tools":
                            for tr in result.get("tool_results", []):
                                yield f"data: {json.dumps({'type': 'tool_result', 'tool': tr['name'], 'message': f'Received output from {tr['name']}. Analyzing...', 'metrics': metrics})}\n\n"

                    except (asyncio.TimeoutError, TimeoutError):
                        elapsed = round(time.time() - start_time, 1)
                        metrics["time_elapsed"] = elapsed
                        
                        # THE FIX: 2048 bytes of invisible SSE comment padding to forcefully flush the server buffer!
                        yield f": {'=' * 2048}\n\n" 
                        yield f"data: {json.dumps({'type': 'status', 'message': 'Thinking deep (waiting on tool)...', 'metrics': metrics})}\n\n"
            
            finally:
                # If the user closes the browser window, kill the background Burr task to free up memory
                task.cancel()

        # Return the generator wrapped in a Quart Response with SSE headers
        return Response(
            event_generator(),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"
            }
        )
    
    except Exception as e:
        logger.error(f"Agent orchestration error: {e}")
        return jsonify({"success": False, "error": str(e)}), 500
