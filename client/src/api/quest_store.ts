/**
 * Quest generation API client — real gateway surface backed by iteration 79's
 * parametrized quest engine (python/vtt_orchestrator/simulation/quest_engine.py).
 *
 * Routes (python/vtt_orchestrator/server.py):
 *   POST /api/v1/quest/generate  { campaign_theme, primary_house, rival_house } → QuestGraph
 *   GET  /api/v1/quest/active    → the gateway's most recently generated graph
 *
 * Mirrors handout_store conventions: helpers resolve null on network failure so
 * the UI can surface an honest error instead of padding with invented content.
 *
 * Honesty notes carried into the UI:
 *  - The gateway route is NOT role-enforced today; GM gating here is client-side
 *    only (the modal discloses this next to the control).
 *  - Generated graphs are held only in the gateway process (`global_quest_generator`
 *    module state). Nothing here persists them client-side either.
 */

import { authHeaders } from './auth_headers';

export interface QuestChoiceEdge {
  choice_id: string;
  target_node_id: string;
  prompt_text: string;
  /** e.g. ["Persuasion", 14] — skill name + DC. */
  skill_check_required?: [string, number] | null;
  faction_reputation_deltas: Record<string, number>;
  rewards_gold: number;
  rewards_xp: number;
}

export interface QuestNode {
  node_id: string;
  node_type: string;
  title: string;
  narrative_prompt: string;
  associated_faction_id?: string | null;
  choices: QuestChoiceEdge[];
}

export interface QuestGraph {
  quest_id: string;
  title: string;
  summary: string;
  initial_node_id: string;
  nodes: Record<string, QuestNode>;
  /**
   * Set by the engine only when the curated theme tables ran thin relative to
   * the requested structure — the truncation disclosure replaces filler.
   */
  coverage_note?: string | null;
}

export interface QuestGenerateInput {
  campaign_theme: string;
  primary_house: string;
  rival_house: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const resp = await fetch(path, {
      ...init,
      headers: { ...authHeaders(), ...(init?.headers ?? {}) },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

/** Shape-check the payload so a proxy HTML error page can't masquerade as a graph. */
function isQuestGraph(value: unknown): value is QuestGraph {
  if (typeof value !== 'object' || value === null) return false;
  const g = value as Partial<QuestGraph>;
  return typeof g.quest_id === 'string' && typeof g.initial_node_id === 'string'
    && typeof g.nodes === 'object' && g.nodes !== null;
}

/**
 * Generate a fresh campaign quest from the caller's theme/house parameters.
 * Returns null when the gateway is unreachable, the request fails, or the
 * response isn't a quest graph — callers must render an error, not a fallback.
 */
export async function generateQuest(input: QuestGenerateInput): Promise<QuestGraph | null> {
  const data = await req<unknown>('/api/v1/quest/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return isQuestGraph(data) ? data : null;
}

/**
 * Fetch the gateway's most recent graph. The gateway auto-generates one from
 * defaults if none exists yet, so null here strictly means transport/shape
 * failure, not "no quest".
 */
export async function fetchActiveQuest(): Promise<QuestGraph | null> {
  const data = await req<unknown>('/api/v1/quest/active');
  return isQuestGraph(data) ? data : null;
}

/**
 * Depth-first walk from initial_node_id along choice edges, then any nodes the
 * edges never reached (defensive against malformed graphs). Deterministic, so
 * the rendered DAG order matches the authored progression.
 */
export function orderQuestNodes(graph: QuestGraph): QuestNode[] {
  const ordered: QuestNode[] = [];
  const seen = new Set<string>();
  const stack = [graph.initial_node_id];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    const node = graph.nodes[id];
    if (!node) continue;
    seen.add(id);
    ordered.push(node);
    for (let i = node.choices.length - 1; i >= 0; i -= 1) {
      stack.push(node.choices[i].target_node_id);
    }
  }
  for (const node of Object.values(graph.nodes)) {
    if (!seen.has(node.node_id)) ordered.push(node);
  }
  return ordered;
}
