# import logging
# import torch
# import torch.nn as nn
# import torch.optim as optim
# from litellm import aembedding
# from burr.core import State
# import re
# import json

# logger = logging.getLogger(__name__)

# class ProofValueNetwork(nn.Module):
#     def __init__(self, input_dim=1536):
#         super().__init__()
#         self.net = nn.Sequential(
#             nn.Linear(input_dim, 256),
#             nn.ReLU(),
#             nn.Linear(256, 64),
#             nn.ReLU(),
#             nn.Linear(64, 1),
#             nn.Sigmoid() # Forces output to be between 0.0 and 1.0
#         )

#     def forward(self, x):
#         return self.net(x)

# # Initialize globally so weights persist and improve across chat sessions
# v_network = ProofValueNetwork()
# v_optimizer = optim.Adam(v_network.parameters(), lr=0.001)
# v_criterion = nn.MSELoss()

# # Format: { chat_id: [ (tensor_embedding, node_id), ... ] }
# episode_memory = {}

# def normalize_signature(lean_text: str) -> str:
#     """Extracts everything from 'theorem' up to ':=' and normalizes whitespace."""
#     match = re.search(r'(theorem\s+[^{:=(]+.*?:.*?):=?', lean_text, re.DOTALL)
#     if match:
#         return " ".join(match.group(1).split())
#     return ""



# async def score_and_update_tree_func(state: State) -> tuple[dict, State]:
#     tree = state["tree"]
#     current_id = state["current_node_id"]
#     messages = state["messages"]
#     stream_queue = state["stream_queue"]
#     chat_id = state["chat_id"]
#     tool_router = state["tool_router"]
#     iterations = state.get("iterations", 0) + 1
    
#     is_solved = False
#     skip_rl = False
#     score = 0.0

#     if "verify_full_script" not in tool_router:
#         await stream_queue.put(("error", "CRITICAL: Leak-II Lean Daemon not connected.", None, None))
#         skip_rl = True
#         return {"score": 0.0}, state.update(skip_rl=True)

#     last_agent_msg = messages[-1].get("content", "")
    
#     # 1. EXTRACT STATE HISTORY (What did the LLM do, and what did Lean say?)
#     daemon_output = ""
#     lean_code_verified = ""
    
#     # Scan backward to find the most recent interaction with the verification tool
#     for msg in reversed(messages):
#         if msg.get("role") == "tool" and msg.get("name") == "verify_full_script":
#             daemon_output = msg.get("content", "")
#             break
            
#     for msg in reversed(messages):
#         if msg.get("role") == "assistant" and msg.get("tool_calls"):
#             for tc in msg["tool_calls"]:
#                 if tc["function"]["name"] == "verify_full_script":
#                     args = json.loads(tc["function"]["arguments"])
#                     lean_code_verified = args.get("script", "")
#                     break
#         if lean_code_verified:
#             break

#     # Extract the user's original skeleton signature
#     initial_user_msg = next((m["content"] for m in messages if m["role"] == "user"), "")
#     user_sig = normalize_signature(initial_user_msg)
#     verified_sig = normalize_signature(lean_code_verified)

#     # 2. THE STRICT 1.0 CONDITION
#     # - Must have compiled successfully
#     # - Must not contain 'sorry'
#     # - The signature tested must match the user's exact skeleton constraint
#     if (daemon_output and 
#         "✅ Compilation Successful" in daemon_output and 
#         "sorry" not in lean_code_verified and 
#         user_sig and user_sig == verified_sig):
        
#         score = 1.0
#         is_solved = True
#         await stream_queue.put(("status", "🎯 1.0: Full Proof Matched to User Skeleton!", None, None))
        
#     # 3. THE PURE V-FUNCTION DOMAIN
#     # If the proof isn't complete, we never provide a custom score. We let V decide.
#     else:
#         await stream_queue.put(("status", "Evaluating conversational state via V-Network...", None, None))
        
#         # We take your advice: V's domain is the Agent's Thought + The Objective Lean Environment State
#         v_domain_text = f"Agent Thought: {last_agent_msg}\n\nEnvironment Output: {daemon_output}"
        
#         try:
#             embed_res = await aembedding(model="text-embedding-3-small", input=v_domain_text)
#             vector = embed_res.data[0].embedding
#             state_tensor = torch.tensor(vector, dtype=torch.float32)
            
#             with torch.no_grad():
#                 score = v_network(state_tensor).item()
                
#             if not skip_rl:
#                 if chat_id not in episode_memory:
#                     episode_memory[chat_id] = []
#                 episode_memory[chat_id].append((state_tensor, current_id, score))
                
#         except Exception as e:
#             logger.warning(f"V-Function embedding failed: {e}")
#             score = 0.5 

#     # 4. BACKPROPAGATE MCTS SCORE
#     curr = current_id
#     while curr is not None:
#         tree[curr]["visits"] += 1
#         tree[curr]["wins"] += score
#         curr = tree[curr]["parent"]
        
#     tree[current_id]["messages"] = messages.copy()
#     tree[current_id]["evaluated"] = True

#     return {"score": score}, state.update(tree=tree, is_solved=is_solved, iterations=iterations, skip_rl=skip_rl)

# def get_path_distances(tree: dict, final_node_id: str) -> dict:
#     """
#     Traces back from the solved node to the root, returning a dictionary 
#     mapping node_id -> distance from the solution.
#     """
#     distances = {}
#     curr = final_node_id
#     distance = 0
    
#     while curr is not None:
#         distances[curr] = distance
#         curr = tree[curr]["parent"]
#         distance += 1
        
#     return distances

# def train_v_network(chat_id: str, is_solved: bool, tree: dict, final_node_id: str):
#     """
#     Updates the Neural Network using:
#     - Exponential discounting (0.95) for the winning path.
#     - Soft penalty (V^2 + 0.09) for unexplored or slower branches.
#     """
#     if chat_id not in episode_memory or not episode_memory[chat_id]:
#         return
        
#     logger.info(f"🧠 [RL TRAINING] Updating V-Network. Solved: {is_solved}")
    
#     GAMMA = 0.95 
    
#     path_distances = {}
#     if is_solved and final_node_id:
#         path_distances = get_path_distances(tree, final_node_id)
    
#     tensors_to_train = []
#     target_rewards = []
    
#     for state_tensor, node_id, original_v in episode_memory[chat_id]:
#         tensors_to_train.append(state_tensor)
        
#         if is_solved and node_id in path_distances:
#             # WINNING PATH: Reward based on distance to the finish line
#             distance = path_distances[node_id]
#             target = GAMMA ** distance
#         else:
#             # SLOWER/UNEXPLORED PATH: Soft penalty (V^2 + 0.09)
#             target = (original_v ** 2) + 0.09
#             # Cap it at 0.99 just in case V was extremely high (e.g., 0.96^2 + 0.09 > 1.0)
#             target = min(target, 0.99)
            
#         target_rewards.append([target])
            
#     states_batch = torch.stack(tensors_to_train)
#     target_batch = torch.tensor(target_rewards, dtype=torch.float32)
    
#     v_network.train()
#     v_optimizer.zero_grad()
    
#     predictions = v_network(states_batch)
#     loss = v_criterion(predictions, target_batch)
    
#     loss.backward()
#     v_optimizer.step()
    
#     logger.info(f"🧠 [RL TRAINING] Loss: {loss.item():.4f}. Processed {len(tensors_to_train)} states.")
    
#     del episode_memory[chat_id]