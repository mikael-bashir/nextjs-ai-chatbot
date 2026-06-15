from dotenv import load_dotenv
import os
load_dotenv()

import logging
import time
import json
from typing import Dict, Any
import torch
from litellm.exceptions import RateLimitError
import asyncio
from quart import request, jsonify, Response
from litellm import acompletion, supports_function_calling
from litellm.router import Router
from burr.core import action, State, ApplicationBuilder, default, expr
from litellm import aembedding
import uuid 
import threading
import re


from app.api.lib.leak_utils import (
    choose_child, 
    optimize_context_window, 
    mem0_client, 
    llm_router, 
    pool_semaphore,
    get_key_hash
)
# from app.api.lib.instincts import train_v_network, score_and_update_tree_func

logger = logging.getLogger(__name__)

# ==========================================
# ⚙️ BURR ACTIONS (SEARCH SUPERVISOR)
# ==========================================

@action(reads=["tree", "root_id", "stream_queue"], writes=["current_node_id", "messages"])
async def select_node(state: State) -> tuple[dict, State]:
    """Traverses the conversational tree to find the next node to expand."""
    tree = state["tree"]
    current_id = state["root_id"]
    stream_queue : asyncio.Queue = state["stream_queue"]
    
    # Walk down the tree until we hit a leaf
    while tree[current_id]["children"]:
        current_id = choose_child(current_id, tree)
        
    await stream_queue.put(("status", f"MCTS exploring branch {current_id[:6]}...", None, None))
        
    # Load the specific conversation state for this branch
    return {"selected": current_id}, state.update(
        current_node_id=current_id, 
        messages=tree[current_id]["messages"].copy()
    )


@action(reads=["messages", "tools", "model", "stream_queue", "chat_id"], writes=["messages"])
async def chat_model(state: State) -> tuple[dict, State]:
    """Generates the next step in the conversation (Expansion)."""
    raw_messages = state["messages"]
    tools = state.get("tools", [])
    model = state["model"]
    stream_queue : asyncio.Queue = state["stream_queue"]
    chat_id = state["chat_id"]

    # 🚨 Apply the Sliding Window Optimization
    # messages = optimize_context_window(raw_messages, chat_id)
    messages = raw_messages

    logger.info(f"Invoking {model} with {len(tools)} tools on optimized context.")

    # thinking_directive = {
    #     "role": "system",
    #     "content": (
    #         "MANDATORY PROTOCOL: Before you invoke any tool, you MUST output a text block enclosed in "
    #         "<thought_process> tags. Inside this block, you must explicitly answer these three questions:\n"
    #         "1. What exactly did the last tool error or output mean?\n"
    #         "2. Is our current mathematical strategy flawed, or did we just mess up the Lean 4 syntax?\n"
    #         "3. What is the precise goal of the tool call I am about to make?\n\n"
    #         "Do NOT invoke any tools until you have closed the </thought_process> tag."
    #     )
    # }

    thinking_directive = {
        "role": "system",
        "content": (
            "MANDATORY PROTOCOL: Every time you respond, you MUST output your thought process "
            "AND invoke a tool in the EXACT SAME RESPONSE.\n"
            "1. First, output a text block enclosed in <thought_process> tags answering:\n"
            "   - What exactly did the last tool error or output mean?\n"
            "   - Is our current mathematical strategy flawed, or did we just mess up the syntax?\n"
            "   - What is the precise goal of the tool call I am about to make?\n"
            "2. Immediately after closing the </thought_process> tag, you MUST invoke your chosen Lean 4 tool.\n"
            "DO NOT write your tool calls as plain text or XML in your response body. Use the native tool execution schema."
        )
    }
    
    invocation_messages = messages.copy()
    invocation_messages.insert(1, thinking_directive)

    # print("-" * 50)
    # print(f"\n🚀 [RAW MESSAGES] | Chat ID: {chat_id}")
    # print(json.dumps(raw_messages, indent=2)) 
    print("$*" * 50)
    print(f"\n🚀 [LLM INVOCATION CONTEXT] | Chat ID: {chat_id}")
    print(json.dumps(invocation_messages, indent=2)) 
    print("$*" * 50)

    response = None
    try :
        async with pool_semaphore:
            kwargs = {
                "model": model,
                "messages": invocation_messages,
                "temperature": 0.2, # Slightly higher temperature encourages diverse tree branching
                "stream": True
            }
            # if supports_function_calling(model) and len(tools) > 0:
            kwargs["tools"] = tools
                
            response = await llm_router.acompletion(**kwargs)
        
        full_content = ""
        tool_calls_dict = {}
        tool_calls_list = []

        async for chunk in response:
            delta = chunk.choices[0].delta

            if hasattr(delta, "content") and delta.content:
                full_content += delta.content
                if stream_queue:
                    await stream_queue.put(("text_delta", full_content, None, None))

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


        # if "<invoke" in full_content:
        #     # Match the <invoke name="tool_name"> block (re.DOTALL allows matching across newlines)
        #     invoke_pattern = re.compile(r'<invoke\s+name="([^"]+)">\s*(.*?)\s*</invoke>', re.DOTALL)
        #     invocations = invoke_pattern.findall(full_content)
            
        #     for tool_name, params_str in invocations:
        #         # Match the <parameter name="arg_name">value</parameter> blocks
        #         param_pattern = re.compile(r'<parameter\s+name="([^"]+)">\s*(.*?)\s*</parameter>', re.DOTALL)
        #         parameters = param_pattern.findall(params_str)
                
        #         # Build a dictionary of the arguments
        #         args_dict = {}
        #         for p_name, p_val in parameters:
        #             args_dict[p_name] = p_val.strip()
                
        #         # Forge an OpenAI-compliant tool call object so `execute_tools` doesn't break
        #         tool_calls_list.append({
        #             "id": f"call_xml_{uuid.uuid4().hex[:8]}", 
        #             "type": "function", 
        #             "function": {
        #                 "name": tool_name, 
        #                 # execute_tools expects a JSON string here, so we dump the dict
        #                 "arguments": json.dumps(args_dict) 
        #             }
        #         })

        msg_dict : Dict[str, Any] = {"role": "assistant", "content": full_content}
        if tool_calls_dict:
            msg_dict["tool_calls"] = list(tool_calls_dict.values()) + tool_calls_list

        return {"response": msg_dict}, state.append(messages=msg_dict)

    except Exception as e:
        logger.error(f"LLM Invocation Failure: {str(e)}")
        error_msg = {"role": "assistant", "content": f"**System Error:** \n\n`{str(e)}`"}
        return {"response": error_msg}, state.append(messages=error_msg)

@action(reads=["messages", "tree", "current_node_id", "model", "stream_queue"], writes=["tree"])
async def expand_strategic_branches(state: State) -> tuple[dict, State]:
    """
    Instead of executing tools, this action generates high-level conversational 
    themes/strategies to branch the tree.
    """
    messages = state["messages"]
    tree = state["tree"]
    current_id = state["current_node_id"]
    model = state["model"]
    stream_queue = state["stream_queue"]
    
    await stream_queue.put(("status", "Brainstorming new strategic approaches...", None, None))
    
    # 1. Meta-prompt to generate diverse strategies
    meta_prompt = {
        "role": "user",
        "content": (
            "Analyze the current state of our proof attempts. "
            "Generate 3 distinctly different, high-level mathematical strategies we should explore next. "
            "For example: 'Break this down into smaller lemmas', 'Test the base cases first', or 'Try proof by contradiction'. "
            "Return EXACTLY a JSON array of 3 strings."
        )
    }

    meta_prompt = {
        "role": "user",
        "content": (
            "You are the Lead Architect for a formal verification project. "
            "Review the current proof state and previous failures. "
            "Identify the 'blind spots' in our current approach and propose 1, 2, or 3 "
            "distinct, mathematically realistic strategies to pivot this branch. "
            "Focus on shifts in thematic tactics or approaches, like a human."
            "Return a JSON object with a 'strategies' key containing a list of 1 to 3 strings."
        )
    }
    
    try:
        async with pool_semaphore:
            # We use a standard non-streaming call just to get the JSON strategies
            response = await llm_router.acompletion(
                model=model,
                messages=messages + [meta_prompt],
                temperature=0.8, # Higher temp for diverse creative strategies
                response_format={"type": "json_object"} # Force JSON output if supported
            )
            
        content = response.choices[0].message.content or "{}"
        # Quick and dirty parsing of the JSON array (assuming the LLM followed instructions)
        strategies = json.loads(content).get("strategies", [])
        if not strategies:
            # Fallback if parsing fails
            strategies = [
                "Strategy A: Break the problem into smaller lemmas.",
                "Strategy B: Explore special or base cases.",
                "Strategy C: Attempt an indirect proof or contradiction."
            ]
            
    except Exception as e:
        logger.error(f"Strategy Generation Failed: {e}")
        strategies = ["Try a different tactical approach."]

    # 2. Create the child branches!
    new_children_ids = []
    for strategy in strategies:
        child_id = str(uuid.uuid4())
        
        # 🚨 THE MAGIC: We inject the strategy as an invisible system prompt
        # forcing the LLM in this branch to follow this specific theme.
        branch_messages = messages.copy()
        branch_messages.append({
            "role": "system",
            "content": f"[MCTS STRATEGIC DIRECTIVE]: For this branch of the conversation, you MUST strictly adhere to the following strategy: {strategy}. Use your tools to execute this strategy."
        })
        
        tree[child_id] = {
            "id": child_id,
            "parent": current_id,
            "children": [],
            "messages": branch_messages,
            "visits": 0,
            "wins": 0.0,
            "strategy_theme": strategy # Store the theme for the UI
        }
        tree[current_id]["children"].append(child_id)
        new_children_ids.append(child_id)
        
    await stream_queue.put(("status", f"Created 3 new branches. Exploring...", None, None))
        
    return {"strategies": strategies}, state.update(tree=tree)

# 🚨 Add "stream_queue" to the reads array
@action(reads=["messages", "tool_router", "stream_queue"], writes=["messages"])
async def execute_tools(state: State) -> tuple[dict, State]:
    """Executes chosen tools (Simulation)."""
    messages = state["messages"]
    tool_router = state["tool_router"] 
    stream_queue: asyncio.Queue = state["stream_queue"]
    last_msg = messages[-1]
    
    is_solved = state.get("is_solved", False)
    tool_results = []
    final_script_output = "" # Store the winning script
    
    for tc in last_msg.get("tool_calls", []):
        tool_name = tc["function"]["name"]
        tool_args = json.loads(tc["function"]["arguments"])
        logger.info(f"Executing tool: {tool_name} with args: {tool_args}")
        
        client = tool_router.get(tool_name)
        if not client:
            result_str = f"Error: Tool {tool_name} not found on any active server."
        else:
            try:
                result = await client.call_tool(tool_name, tool_args)
                if hasattr(result, "content") and isinstance(result.content, list):
                    texts = [c.text for c in result.content if getattr(c, "type", "") == "text"]
                    result_str = "\n".join(texts) if texts else str(result.content)
                elif hasattr(result, "dict"):
                    result_str = json.dumps(result.dict())
                else:
                    result_str = str(result)
                    
                # 🏆 INTERCEPT THE VICTORY
                if "Tactic succeeded! Proof complete. No goals remaining." in result_str:
                    logger.info("🎉 VICTORY DETECTED! Proof complete.")
                    is_solved = True
                    final_script_output = result_str # Save the exact tool output
                    
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
        
    # 🛑 THE SHORT-CIRCUIT: Push directly to UI and forge the final history
    if is_solved and final_script_output:
        success_message = f"🎉 **Proof Complete!**\n\n{final_script_output}"
        
        # 1. Stream the script to the frontend instantly (mimicking the LLM)
        await stream_queue.put(("text_delta", success_message, None, None))
        
        # 2. Append a synthetic assistant message so Mem0 records the script as the LLM's final answer
        synthetic_msg = {"role": "assistant", "content": success_message}
        new_state = new_state.append(messages=synthetic_msg)
        
    return {"tool_results": tool_results}, new_state.update(is_solved=is_solved)


# @action(reads=["tree", "current_node_id", "messages", "stream_queue", "chat_id"], writes=["tree", "messages", "is_solved"])
# async def score_and_update_tree(state: State) -> tuple[dict, State]:
#     return await score_and_update_tree_func(state)

@action(reads=["messages"], writes=["messages"])
async def nudge_agent(state: State) -> tuple[dict, State]:
    """Prods the LLM if it outputs pure text without solving the goal or using a tool."""
    nudge_msg = {
        "role": "system", 
        "content": "SYSTEM REMINDER: You did not invoke any tools, and the proof is not complete. You must use a tool to advance the proof, or use propose_lean_tactic if you are stuck."
    }
    return {"nudge": True}, state.append(messages=nudge_msg)

@action(reads=["is_solved", "chat_id", "skip_rl"], writes=[])
async def end(state: State) -> tuple[dict, State]:
    """Handles end of run and triggers Reinforcement Learning."""
    skip_rl = state.get("skip_rl", False)
    if not skip_rl:
        is_solved = state.get("is_solved", False)
        # train_v_network(state["chat_id"], is_solved, state["tree"], state["current_node_id"])
    else:
        logger.warning("Skipping RL update due to missing MCP tools or environment errors.")
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
        elif "grok" in raw_model.lower():
            model = "grok-free-pool"
        else:
            model = raw_model
        print("using model:", model)
        print('raw model was:', raw_model)

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

        When you believe the proof is complete, you MUST synthesize your successful tool calls into a single, clean Lean 4 code block for the user. """
                
        # Example of expected final output:
        # ```
        # theorem and_comm (p q : Prop) : p ∧ q ↔ q ∧ p := by
        # intro p q
        # constructor
        # · intro h
        #     exact ⟨h.right, h.left⟩
        # · intro h
        #     exact ⟨h.right, h.left⟩
        # ```

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

        root_id = str(uuid.uuid4())
        initial_tree = {
            root_id: {
                "id": root_id,
                "parent": None,
                "children": [],
                "messages": messages.copy(),
                "visits": 0,
                "wins": 0.0,
                "strategy_theme": "Root Problem",
                "evaluated": False
            }
        }

        logger.info(f"Starting Burr App Builder. Routing {len(openai_tools)} tools.")


        app_builder = (
            ApplicationBuilder()
            .with_state(
                messages=messages, 
                tools=openai_tools, 
                tool_router=tool_router, 
                model=model, 
                chat_id=chat_id, 
                stream_queue=stream_queue,
                tree=initial_tree,
                root_id=root_id,
                current_node_id=root_id,
                is_solved=False,
                iterations=0
            )
            # 🚨 ADD ALL LATS ACTIONS HERE
            .with_actions(
                select_node, 
                expand_strategic_branches, 
                chat_model, 
                execute_tools, 
                # score_and_update_tree, 
                nudge_agent,
                end
            )
            .with_transitions(
                # 1. If we select a node and it has no children, generate strategies to expand it
                # ("select_node", "chat_model", expr("not tree[current_node_id].get('evaluated', False)")),
                # ("select_node", "expand_strategic_branches", default),
                
                # 2. Once expanded, loop back to select one of those new branches
                # ("expand_strategic_branches", "select_node", default),
                
                # 4. Standard Tool Loop, leaving early if a tool provides a proof
                # ("chat_model", "execute_tools", expr("len(messages[-1].get('tool_calls', [])) > 0")),

                # ("chat_model", "end", expr("is_solved == True")),

                # ("execute_tools", "chat_model", default), # Always let the LLM read the tool output!
                
                # 5. When the LLM gives a final text response, score the branch
                # ("chat_model", "score_and_update_tree", default),
                
                # 6. Check for completion
                # ("score_and_update_tree", "end", expr("is_solved == True or iterations >= 10")), 
                
                # 7. Otherwise, loop back to select the next best branch
                # ("score_and_update_tree", "select_node", default)

                # 1. Unconditionally start the linear chat loop
                ("select_node", "chat_model", default),
                
                # 2. If Grok wants to use a tool, run it
                ("chat_model", "execute_tools", expr("len(messages[-1].get('tool_calls', [])) > 0")),
                
                # 3. If Grok synthesized the final proof (is_solved is flipped by execute_tools), end the run!
                ("chat_model", "end", expr("is_solved == True")),

                # If execute_tools flipped is_solved=True, go directly to the end! Do not wake Grok up.
                ("execute_tools", "end", expr("is_solved == True")),
                
                # 4. FALLBACK: If Grok just outputs normal text without a tool and hasn't solved it, 
                # safely end the run instead of crashing the server.
                ("chat_model", "nudge_agent", default),
                ("nudge_agent", "chat_model", default),

                # 5. After running tools, ALWAYS go back to Grok to read the output
                ("execute_tools", "chat_model", default)
            )
            .with_entrypoint("select_node")
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

                        if msg_type == "status":
                            yield f"data: {json.dumps({'type': 'status', 'message': action_name, 'metrics': metrics})}\n\n"
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
            except asyncio.CancelledError:
                logger.warning(f"Client disconnected or cancelled. Killing agent task for chat {chat_id}.")
                task.cancel()
                raise 
            finally:
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
