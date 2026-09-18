import type { Message } from "@earendil-works/pi-ai";
import type { AgentState } from "./resume.ts";

/** Where a ReviewRun keeps a stage between parts: its own SQLite, one row per message. */
export interface AgentStore {
  load(key: string): AgentState | null;
  save(key: string, state: AgentState): void;
  clear(key: string): void;
}

export function sqlAgentStore(sql: SqlStorage): AgentStore {
  sql.exec(`CREATE TABLE IF NOT EXISTS agent_run (
    key TEXT PRIMARY KEY, attempt INTEGER NOT NULL, last_error TEXT, turns INTEGER NOT NULL,
    tool_calls INTEGER NOT NULL, usage TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS agent_message (
    key TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (key, seq))`);
  return {
    load(key) {
      const row = sql
        .exec<{
          attempt: number;
          last_error: string | null;
          turns: number;
          tool_calls: number;
          usage: string;
        }>("SELECT attempt, last_error, turns, tool_calls, usage FROM agent_run WHERE key = ?", key)
        .toArray()[0];
      if (!row) return null;
      const messages = sql
        .exec<{ json: string }>("SELECT json FROM agent_message WHERE key = ? ORDER BY seq", key)
        .toArray()
        .map((m) => JSON.parse(m.json) as Message);
      return {
        attempt: row.attempt,
        lastError: row.last_error,
        messages,
        turns: row.turns,
        toolCalls: row.tool_calls,
        usage: JSON.parse(row.usage) as AgentState["usage"],
      };
    },
    save(key, state) {
      sql.exec(
        `INSERT INTO agent_run (key, attempt, last_error, turns, tool_calls, usage) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET attempt = excluded.attempt, last_error = excluded.last_error,
         turns = excluded.turns, tool_calls = excluded.tool_calls, usage = excluded.usage`,
        key,
        state.attempt,
        state.lastError,
        state.turns,
        state.toolCalls,
        JSON.stringify(state.usage),
      );
      // Messages only grow within an attempt, so write the tail; a new attempt starts over.
      const have = Number(
        sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM agent_message WHERE key = ?", key)
          .toArray()[0]?.n ?? 0,
      );
      let from = have;
      if (have > state.messages.length) {
        sql.exec("DELETE FROM agent_message WHERE key = ?", key);
        from = 0;
      }
      for (let seq = from; seq < state.messages.length; seq += 1)
        sql.exec(
          "INSERT INTO agent_message (key, seq, json) VALUES (?, ?, ?)",
          key,
          seq,
          JSON.stringify(state.messages[seq]),
        );
    },
    clear(key) {
      sql.exec("DELETE FROM agent_message WHERE key = ?", key);
      sql.exec("DELETE FROM agent_run WHERE key = ?", key);
    },
  };
}
