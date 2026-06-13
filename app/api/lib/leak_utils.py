from dotenv import load_dotenv
load_dotenv()

import os
import random
from mem0 import MemoryClient
import threading
from litellm.router import Router
import asyncio
from typing import Any
import hashlib
import logging

logger = logging.getLogger(__name__)

mem0_client = MemoryClient(api_key=os.getenv("MEM0_API_KEY"))
free_key_pool = [
    {
        "model_name": "grok-free-pool",
        "litellm_params": {"model": "xai/grok-4-1-fast-reasoning", "api_key": os.environ.get("XAI_FREE_KEY_1")}
    },
]

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

def choose_child(node_id: str, tree: dict) -> str:
    """
    Abstracted Selection Algorithm for MCTS.
    Currently defaults to a random walk (Monte Carlo).
    Future upgrade: Implement UCB1 (Upper Confidence Bound) here.
    """
    children = tree[node_id]["children"]
    return random.choice(children)


def optimize_context_window(messages: list[dict[str, Any]], chat_id: str) -> list[dict[str, Any]]:
    """
    Ensures the LLM only sees:
    1. The System Directive
    2. The User's original proof skeleton
    3. The specific MCTS Directive for this branch
    4. The last 3 agent responses (including tool calls)
    5. The last 3 tool results

    In the future, considering injecting mem0 hindsight context, only after every n iterations, as a way
    to try get out of eternal mistake cycles, or more formally, preventing convergence to a 
    conversation state that is not near the state we want.
    """
    if len(messages) <= 3:
        return messages
        
    system_msg = messages[0]
    original_prompt = messages[1]
    
    # 1. PIN THE STRATEGY: Find the strategic directive
    strategic_directive = next(
        (m for m in messages if isinstance(m.get("content"), str) and "[MCTS STRATEGIC DIRECTIVE]" in m["content"]), 
        None
    )

    # 2. PIN THE PATH: Find indices of successful tool results
    # We want the Assistant message immediately preceding a "Tactic succeeded"
    success_indices = [i for i, m in enumerate(messages) if m.get("role") == "tool" and "Tactic succeeded" in str(m.get("content") ) or "Proof initialized" in str(m.get("content"))]
    
    path_history = []
    for idx in success_indices[-2:]: # Keep the last 2 successful steps
        if idx > 0:
            path_history.append(messages[idx-1]) # The Assistant's call
        path_history.append(messages[idx])     # The Tool's result

    # 3. PIN THE PRESENT: Always keep the last 2 messages (the current state/error)
    last_turn = messages[-2:]

    # 4. CONSTRUCT FINAL PAYLOAD
    # Start with the foundational context
    final_context = [system_msg, original_prompt]
    
    # Add the strategy if it's not already in the path/last_turn
    if strategic_directive and strategic_directive not in path_history and strategic_directive not in last_turn:
        final_context.append(strategic_directive)
    
    # Use a list comprehension to remove duplicates while preserving order
    # (In case the last_turn IS a success)
    combined_history = path_history + last_turn
    seen_contents = []
    deduplicated_history = []
    
    for msg in combined_history:
        # We hash the content to check for duplicates
        content_hash = hash(str(msg.get('content')) + str(msg.get('role')))
        if content_hash not in seen_contents:
            deduplicated_history.append(msg)
            seen_contents.append(content_hash)
        
    return final_context + deduplicated_history

# def optimize_context_window(messages: list[dict[str, Any]], chat_id: str) -> list[dict[str, Any]]:
#     """
#     Sliding window to prevent context bloat during deep tree traversal.
#     Compresses history > 5 turns into Mem0, and injects relevant RAG context.
#     """
#     WINDOW_SIZE = 5 
    
#     # Needs System msg, original User prompt, and at least window size * 2
#     if len(messages) <= (WINDOW_SIZE * 2) + 2: 
#         return messages 

#     system_msg = messages[0]
#     original_prompt = messages[1]
    
#     working_history = messages[2:]
#     chunk_to_compress = working_history[:-WINDOW_SIZE]
#     recent_window = working_history[-WINDOW_SIZE:]
    
#     # 1. Fire and forget compression to Mem0
#     def compress_and_store():
#         synthesis = "\n".join([f"{m.get('role')}: {m.get('content', 'tool_call')}" for m in chunk_to_compress])
#         mem0_client.add(
#             messages=[{"role": "user", "content": "Store this branch history:"}, {"role": "assistant", "content": synthesis}], 
#             user_id=chat_id,
#             metadata={"memory_type": "working_episode"}
#         )
#     threading.Thread(target=compress_and_store).start()

#     # 2. Retrieve top context from Mem0 for the CURRENT focus
#     current_focus = recent_window[-1].get("content", str(recent_window[-1]))
#     memories = mem0_client.search(query=current_focus, filters={"user_id": chat_id}, limit=3)
    
#     memory_text = "No previous context."
#     memory_text = "\n".join([f"- {str(m)}" for m in memories])

#     print(f"!!!!!!!!! memories used: |||| {memory_text} |||| !!!!!!!!!!!!")
#     # 3. Reconstruct the lean message array
#     injected_context = {
#         "role": "system", 
#         "content": f"HINDSIGHT FROM PREVIOUS STEPS (MCTS Branch History):\n{memory_text}\n\nDo not repeat failed tactics."
#     }
#     print(f"!!!!!!!!! context injected: |||| {injected_context} |||| !!!!!!!!!!!!")
    
#     return [system_msg, original_prompt, injected_context] + recent_window