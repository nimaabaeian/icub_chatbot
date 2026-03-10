"""
Always-On Memory Service for iCub Telegram Bot
================================================

Adapted from GoogleCloudPlatform/generative-ai/gemini/agents/always-on-memory-agent
https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/agents/always-on-memory-agent

Key differences from the original:
  - Per-chat / per-user memory isolation (chat_id + user_id scoping)
  - Ingests Telegram conversation event JSON files from ./inbox/<chat_id>/
  - More aggressive consolidation (every 5 min or after 4-6 new events per chat)
  - HTTP API extended with per-chat query parameters
  - SQLite schema includes chat_id and user_id columns

Usage:
    python agent.py                          # watch ./inbox, serve on :8888
    python agent.py --port 9000
    python agent.py --consolidate-every 5

API:
    POST /ingest-event   — write a conversation event JSON to inbox and ingest it
    POST /query          — query memories for a specific chat_id
    POST /consolidate    — trigger consolidation (optionally for a specific chat_id)
    GET  /status         — memory stats (optionally per chat_id)
    GET  /memories       — list memories (requires chat_id query param)
"""

import argparse
import asyncio
import json
import logging
import os
import signal
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from aiohttp import web

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

# ─── Config ────────────────────────────────────────────────────
MODEL = os.getenv("MODEL", "gemini-2.0-flash-lite")
DB_PATH = os.getenv("MEMORY_DB", "memory.db")
INBOX_PATH = os.getenv("INBOX_PATH", "./inbox")
CONSOLIDATE_EVERY_MINUTES = int(os.getenv("CONSOLIDATE_EVERY_MINUTES", "5"))
CONSOLIDATE_MIN_EVENTS = int(os.getenv("CONSOLIDATE_MIN_EVENTS", "4"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(message)s",
    datefmt="[%H:%M]",
)
log = logging.getLogger("memory-agent")


# ─── Database ──────────────────────────────────────────────────
# Schema adapted from Google's always-on-memory-agent with chat_id/user_id
# scoping added for per-user memory isolation.

def get_db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            user_id TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            raw_text TEXT NOT NULL,
            summary TEXT NOT NULL,
            entities TEXT NOT NULL DEFAULT '[]',
            topics TEXT NOT NULL DEFAULT '[]',
            connections TEXT NOT NULL DEFAULT '[]',
            importance REAL NOT NULL DEFAULT 0.5,
            created_at TEXT NOT NULL,
            consolidated INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS consolidations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            source_ids TEXT NOT NULL,
            summary TEXT NOT NULL,
            insight TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS processed_files (
            file_path TEXT PRIMARY KEY,
            processed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memories_chat_id ON memories(chat_id);
        CREATE INDEX IF NOT EXISTS idx_memories_unconsolidated ON memories(chat_id, consolidated);
        CREATE INDEX IF NOT EXISTS idx_consolidations_chat_id ON consolidations(chat_id);
    """)
    return db


# ─── ADK Tools ─────────────────────────────────────────────────
# These are the tools exposed to the ADK agents (ingest, consolidate, query).
# All storage functions require chat_id for isolation.

def store_memory(
    chat_id: str,
    user_id: str,
    raw_text: str,
    summary: str,
    entities: list[str],
    topics: list[str],
    importance: float,
    source: str = "",
) -> dict:
    """Store a processed memory in the database, scoped to a specific chat.

    Args:
        chat_id: The Telegram chat ID this memory belongs to.
        user_id: The Telegram user ID associated with this memory.
        raw_text: The original input text.
        summary: A concise 1-2 sentence summary.
        entities: Key people, topics, or concepts mentioned.
        topics: 2-4 topic tags.
        importance: Float 0.0 to 1.0 indicating importance.
        source: Where this memory came from (filename, api, etc).

    Returns:
        dict with memory_id and confirmation.
    """
    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    cursor = db.execute(
        """INSERT INTO memories (chat_id, user_id, source, raw_text, summary, entities, topics, importance, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (chat_id, user_id, source, raw_text, summary, json.dumps(entities), json.dumps(topics), importance, now),
    )
    db.commit()
    mid = cursor.lastrowid
    db.close()
    log.info(f"📥 Stored memory #{mid} [chat={chat_id}]: {summary[:60]}...")
    return {"memory_id": mid, "status": "stored", "summary": summary}


def read_all_memories(chat_id: str) -> dict:
    """Read all stored memories for a specific chat, most recent first.

    Args:
        chat_id: The Telegram chat ID to read memories for.

    Returns:
        dict with list of memories and count.
    """
    db = get_db()
    rows = db.execute(
        "SELECT * FROM memories WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50",
        (chat_id,)
    ).fetchall()
    memories = []
    for r in rows:
        memories.append({
            "id": r["id"], "source": r["source"], "summary": r["summary"],
            "entities": json.loads(r["entities"]), "topics": json.loads(r["topics"]),
            "importance": r["importance"], "connections": json.loads(r["connections"]),
            "created_at": r["created_at"], "consolidated": bool(r["consolidated"]),
        })
    db.close()
    return {"memories": memories, "count": len(memories)}


def read_unconsolidated_memories(chat_id: str) -> dict:
    """Read memories that haven't been consolidated yet for a specific chat.

    Args:
        chat_id: The Telegram chat ID to read unconsolidated memories for.

    Returns:
        dict with list of unconsolidated memories and count.
    """
    db = get_db()
    rows = db.execute(
        "SELECT * FROM memories WHERE chat_id = ? AND consolidated = 0 ORDER BY created_at DESC LIMIT 20",
        (chat_id,)
    ).fetchall()
    memories = []
    for r in rows:
        memories.append({
            "id": r["id"], "summary": r["summary"],
            "entities": json.loads(r["entities"]), "topics": json.loads(r["topics"]),
            "importance": r["importance"], "created_at": r["created_at"],
        })
    db.close()
    return {"memories": memories, "count": len(memories)}


def store_consolidation(
    chat_id: str,
    source_ids: list[int],
    summary: str,
    insight: str,
    connections: list[dict],
) -> dict:
    """Store a consolidation result and mark source memories as consolidated.

    Args:
        chat_id: The Telegram chat ID this consolidation belongs to.
        source_ids: List of memory IDs that were consolidated.
        summary: A synthesized summary across all source memories.
        insight: One key pattern or insight discovered.
        connections: List of dicts with 'from_id', 'to_id', 'relationship'.

    Returns:
        dict with confirmation.
    """
    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    db.execute(
        "INSERT INTO consolidations (chat_id, source_ids, summary, insight, created_at) VALUES (?, ?, ?, ?, ?)",
        (chat_id, json.dumps(source_ids), summary, insight, now),
    )
    # Update connections on the source memories
    for conn in connections:
        from_id, to_id = conn.get("from_id"), conn.get("to_id")
        rel = conn.get("relationship", "")
        if from_id and to_id:
            for mid in [from_id, to_id]:
                row = db.execute(
                    "SELECT connections FROM memories WHERE id = ? AND chat_id = ?",
                    (mid, chat_id)
                ).fetchone()
                if row:
                    existing = json.loads(row["connections"])
                    existing.append({"linked_to": to_id if mid == from_id else from_id, "relationship": rel})
                    db.execute("UPDATE memories SET connections = ? WHERE id = ?", (json.dumps(existing), mid))
    # Mark source memories as consolidated
    placeholders = ",".join("?" * len(source_ids))
    db.execute(
        f"UPDATE memories SET consolidated = 1 WHERE id IN ({placeholders}) AND chat_id = ?",
        [*source_ids, chat_id]
    )
    db.commit()
    db.close()
    log.info(f"🔄 Consolidated {len(source_ids)} memories [chat={chat_id}]. Insight: {insight[:80]}...")
    return {"status": "consolidated", "memories_processed": len(source_ids), "insight": insight}


def read_consolidation_history(chat_id: str) -> dict:
    """Read past consolidation insights for a specific chat.

    Args:
        chat_id: The Telegram chat ID to read consolidation history for.

    Returns:
        dict with list of consolidation records.
    """
    db = get_db()
    rows = db.execute(
        "SELECT * FROM consolidations WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10",
        (chat_id,)
    ).fetchall()
    result = [{"summary": r["summary"], "insight": r["insight"], "source_ids": r["source_ids"]} for r in rows]
    db.close()
    return {"consolidations": result, "count": len(result)}


def get_memory_stats(chat_id: str = "") -> dict:
    """Get current memory statistics, optionally scoped to a specific chat.

    Args:
        chat_id: Optional. If provided, returns stats for this chat only.

    Returns:
        dict with counts of memories, consolidations, etc.
    """
    db = get_db()
    if chat_id:
        total = db.execute("SELECT COUNT(*) as c FROM memories WHERE chat_id = ?", (chat_id,)).fetchone()["c"]
        unconsolidated = db.execute("SELECT COUNT(*) as c FROM memories WHERE chat_id = ? AND consolidated = 0", (chat_id,)).fetchone()["c"]
        consolidations = db.execute("SELECT COUNT(*) as c FROM consolidations WHERE chat_id = ?", (chat_id,)).fetchone()["c"]
    else:
        total = db.execute("SELECT COUNT(*) as c FROM memories").fetchone()["c"]
        unconsolidated = db.execute("SELECT COUNT(*) as c FROM memories WHERE consolidated = 0").fetchone()["c"]
        consolidations = db.execute("SELECT COUNT(*) as c FROM consolidations").fetchone()["c"]
    db.close()
    result = {
        "total_memories": total,
        "unconsolidated": unconsolidated,
        "consolidations": consolidations,
    }
    if chat_id:
        result["chat_id"] = chat_id
    return result


# ─── ADK Agents ────────────────────────────────────────────────
# Adapted from Google's always-on-memory-agent architecture:
#   - ingest_agent: processes raw text into structured memory
#   - consolidate_agent: finds patterns across unconsolidated memories
#   - query_agent: answers questions using stored memories
#   - orchestrator: routes to sub-agents
#
# Key adaptation: all tools accept chat_id for per-user isolation.

def build_agents():
    ingest_agent = Agent(
        name="ingest_agent",
        model=MODEL,
        description="Processes raw conversation text into structured memory. Call this when new information arrives.",
        instruction=(
            "You are a Memory Ingest Agent for a Telegram chatbot called iCub.\n"
            "You receive conversation events from Telegram chats.\n"
            "For any input you receive:\n"
            "1. Create a concise 1-2 sentence summary capturing the key information\n"
            "2. Extract key entities (people, places, emotions, topics mentioned)\n"
            "3. Assign 2-4 topic tags\n"
            "4. Rate importance from 0.0 to 1.0:\n"
            "   - 0.9-1.0: personal facts (name, age, relationships), strong emotions, life events\n"
            "   - 0.7-0.8: preferences, opinions, recurring topics\n"
            "   - 0.4-0.6: general conversation, casual chat\n"
            "   - 0.1-0.3: greetings, filler, very short responses\n"
            "5. Call store_memory with ALL extracted information including the chat_id and user_id\n\n"
            "IMPORTANT: Always pass the chat_id and user_id from the input to store_memory.\n"
            "Always call store_memory. Be concise and accurate.\n"
            "After storing, confirm what was stored in one sentence."
        ),
        tools=[store_memory],
    )

    consolidate_agent = Agent(
        name="consolidate_agent",
        model=MODEL,
        description="Merges related memories and finds patterns for a specific chat. Call this periodically.",
        instruction=(
            "You are a Memory Consolidation Agent for a Telegram chatbot.\n"
            "You work on memories from a SINGLE chat at a time.\n"
            "1. Call read_unconsolidated_memories with the given chat_id\n"
            "2. If fewer than 2 memories, say nothing to consolidate\n"
            "3. Find connections and patterns across the memories:\n"
            "   - User preferences and personality traits\n"
            "   - Recurring topics or concerns\n"
            "   - Emotional patterns\n"
            "   - Relationships and social context\n"
            "   - Life events and their progression\n"
            "4. Create a synthesized summary and one key insight about this user\n"
            "5. Call store_consolidation with chat_id, source_ids, summary, insight, and connections\n\n"
            "Connections: list of dicts with 'from_id', 'to_id', 'relationship' keys.\n"
            "Think deeply about what these memories reveal about the user."
        ),
        tools=[read_unconsolidated_memories, store_consolidation],
    )

    query_agent = Agent(
        name="query_agent",
        model=MODEL,
        description="Answers questions about a user using their stored memories.",
        instruction=(
            "You are a Memory Query Agent for a Telegram chatbot called iCub.\n"
            "When asked about a user (identified by chat_id):\n"
            "1. Call read_all_memories with the chat_id\n"
            "2. Call read_consolidation_history with the chat_id for higher-level insights\n"
            "3. Synthesize a concise answer based ONLY on stored memories\n"
            "4. Focus on the most relevant and recent information\n"
            "5. If no relevant memories exist, say so honestly\n\n"
            "Prioritize:\n"
            "  - Recent user facts and preferences\n"
            "  - Stable personality traits\n"
            "  - Prior unresolved topics\n"
            "  - Recent emotional context\n\n"
            "Be thorough but concise. Format your answer as a brief context summary\n"
            "that could be injected into a conversation prompt, not as a formal report."
        ),
        tools=[read_all_memories, read_consolidation_history],
    )

    orchestrator = Agent(
        name="memory_orchestrator",
        model=MODEL,
        description="Routes memory operations to specialist agents.",
        instruction=(
            "You are the Memory Orchestrator for an always-on memory system.\n"
            "Route requests to the right sub-agent:\n"
            "- New information -> ingest_agent\n"
            "- Consolidation request -> consolidate_agent\n"
            "- Questions about a user -> query_agent\n"
            "- Status check -> call get_memory_stats and report\n\n"
            "IMPORTANT: Always pass the chat_id through to the sub-agent.\n"
            "After the sub-agent completes, give a brief summary."
        ),
        sub_agents=[ingest_agent, consolidate_agent, query_agent],
        tools=[get_memory_stats],
    )

    return orchestrator


# ─── Agent Runner ──────────────────────────────────────────────
class MemoryAgent:
    """Wraps the ADK agent pipeline for convenient programmatic use."""

    def __init__(self):
        self.agent = build_agents()
        self.session_service = InMemorySessionService()
        self.runner = Runner(
            agent=self.agent,
            app_name="memory_layer",
            session_service=self.session_service,
        )

    async def run(self, message: str) -> str:
        session = await self.session_service.create_session(
            app_name="memory_layer", user_id="agent",
        )
        content = types.Content(role="user", parts=[types.Part.from_text(text=message)])
        return await self._execute(session, content)

    async def _execute(self, session, content: types.Content) -> str:
        """Run the agent with the given content and return the text response."""
        response = ""
        async for event in self.runner.run_async(
            user_id="agent", session_id=session.id, new_message=content,
        ):
            if event.content and event.content.parts:
                for part in event.content.parts:
                    if hasattr(part, "text") and part.text:
                        response += part.text
        return response

    async def ingest_event(self, event_data: dict) -> str:
        """Ingest a Telegram conversation event."""
        chat_id = str(event_data.get("chat_id", ""))
        user_id = str(event_data.get("user_id", ""))
        role = event_data.get("role", "user")
        text = event_data.get("text", "")
        source = event_data.get("source", "telegram")
        user_meta = event_data.get("user_meta", {})

        first_name = user_meta.get("first_name", "")
        username = user_meta.get("username", "")
        name_part = first_name or username or f"User {user_id}"

        if role == "user":
            msg = (
                f"Remember this conversation event (chat_id: {chat_id}, user_id: {user_id}, source: {source}):\n\n"
                f"{name_part} said: \"{text}\""
            )
        else:
            msg = (
                f"Remember this conversation event (chat_id: {chat_id}, user_id: {user_id}, source: {source}):\n\n"
                f"iCub (assistant) replied: \"{text}\""
            )

        return await self.run(msg)

    async def consolidate(self, chat_id: str = "") -> str:
        """Trigger consolidation for a specific chat or all chats with enough events."""
        if chat_id:
            return await self.run(
                f"Consolidate unconsolidated memories for chat_id={chat_id}. "
                "Find connections and patterns about this user."
            )
        else:
            db = get_db()
            rows = db.execute(
                "SELECT chat_id, COUNT(*) as cnt FROM memories WHERE consolidated = 0 "
                "GROUP BY chat_id HAVING cnt >= ?",
                (CONSOLIDATE_MIN_EVENTS,)
            ).fetchall()
            db.close()

            if not rows:
                return "No chats have enough unconsolidated memories for consolidation."

            results = []
            for row in rows:
                cid = row["chat_id"]
                cnt = row["cnt"]
                log.info(f"🔄 Consolidating chat {cid} ({cnt} unconsolidated memories)")
                try:
                    result = await self.run(
                        f"Consolidate unconsolidated memories for chat_id={cid}. "
                        "Find connections and patterns about this user."
                    )
                    results.append(f"chat {cid}: {result[:100]}")
                except Exception as e:
                    log.error(f"Consolidation error for chat {cid}: {e}")
                    results.append(f"chat {cid}: error - {str(e)[:60]}")

            return "; ".join(results) if results else "No consolidations performed."

    async def query(self, chat_id: str, question: str) -> str:
        """Query memories for a specific chat."""
        return await self.run(
            f"Based on memories for chat_id={chat_id}, provide context about this user. "
            f"Specific question: {question}"
        )

    async def get_user_context(self, chat_id: str) -> str:
        """Get a concise user context summary for use in reply generation."""
        return await self.run(
            f"Based on memories for chat_id={chat_id}, provide a concise summary of "
            "what you know about this user. Include: their name, key facts, preferences, "
            "recent topics, emotional state, and any important context. "
            "Format as a brief paragraph that could be injected into a conversation prompt. "
            "If no memories exist, say 'No prior context available for this user.'"
        )

    async def status(self, chat_id: str = "") -> dict:
        """Get memory stats."""
        return get_memory_stats(chat_id)


# ─── Inbox File I/O ────────────────────────────────────────────
def write_event_to_inbox(event_data: dict, inbox_path: str = INBOX_PATH) -> str:
    """Write a conversation event as a JSON file to the inbox.

    Creates unique filenames like:
      ./inbox/<chat_id>/2026-03-10T14-21-03Z__user__update_991001.json
    """
    chat_id = str(event_data.get("chat_id", "unknown"))
    role = event_data.get("role", "user")
    update_id = event_data.get("telegram_update_id", "")
    message_id = event_data.get("telegram_message_id", "")

    chat_dir = Path(inbox_path) / chat_id
    chat_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    id_part = f"update_{update_id}" if update_id else f"msg_{message_id}" if message_id else f"ts_{int(time.time() * 1000)}"
    filename = f"{ts}__{role}__{id_part}.json"
    filepath = chat_dir / filename

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(event_data, f, ensure_ascii=False, indent=2)

    log.info(f"📝 Wrote inbox event: {filepath}")
    return str(filepath)


# ─── File Watcher ──────────────────────────────────────────────
async def watch_inbox(agent: MemoryAgent, inbox_path: str = INBOX_PATH, poll_interval: int = 5):
    """Watch the inbox folder for new conversation event files and ingest them."""
    folder = Path(inbox_path)
    folder.mkdir(parents=True, exist_ok=True)
    db = get_db()
    log.info(f"👁️  Watching: {folder}/ for new conversation events")

    while True:
        try:
            for chat_dir in sorted(folder.iterdir()):
                if not chat_dir.is_dir() or chat_dir.name.startswith("."):
                    continue

                for f in sorted(chat_dir.iterdir()):
                    if f.suffix.lower() != ".json" or f.name.startswith("."):
                        continue

                    row = db.execute("SELECT 1 FROM processed_files WHERE file_path = ?", (str(f),)).fetchone()
                    if row:
                        continue

                    try:
                        event_data = json.loads(f.read_text(encoding="utf-8"))
                        log.info(f"📄 Ingesting event: {f.name}")
                        await agent.ingest_event(event_data)
                        
                        db.execute(
                            "INSERT OR REPLACE INTO processed_files (file_path, processed_at) VALUES (?, ?)",
                            (str(f), datetime.now(timezone.utc).isoformat()),
                        )
                        db.commit()
                    except Exception as file_err:
                        log.error(f"Error ingesting {f.name}: {file_err}")
        except Exception as e:
            log.error(f"Watch error: {e}")

        await asyncio.sleep(poll_interval)


# ─── Consolidation Timer ──────────────────────────────────────
async def consolidation_loop(agent: MemoryAgent, interval_minutes: int = CONSOLIDATE_EVERY_MINUTES):
    """Run consolidation periodically on all chats with enough unconsolidated events."""
    log.info(f"🔄 Consolidation: every {interval_minutes} minutes (min {CONSOLIDATE_MIN_EVENTS} events per chat)")
    while True:
        await asyncio.sleep(interval_minutes * 60)
        try:
            result = await agent.consolidate()
            if result and "No chats" not in result:
                log.info(f"🔄 Consolidation result: {result[:200]}")
            else:
                log.info("🔄 Consolidation: nothing to consolidate")
        except Exception as e:
            log.error(f"Consolidation error: {e}")


# ─── HTTP API ──────────────────────────────────────────────────
def build_http(agent: MemoryAgent, inbox_path: str = INBOX_PATH):
    app = web.Application()

    async def handle_ingest_event(request: web.Request):
        """POST /ingest-event — Write a conversation event to inbox and ingest it."""
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)

        text = (data.get("text") or "").strip()
        chat_id = str(data.get("chat_id", ""))
        if not text or not chat_id:
            return web.json_response({"error": "missing 'text' or 'chat_id'"}, status=400)

        try:
            filepath = write_event_to_inbox(data, inbox_path)
        except Exception as e:
            log.error(f"Failed to write inbox file: {e}")
            filepath = None

        try:
            result = await agent.ingest_event(data)

            if filepath:
                db = get_db()
                db.execute(
                    "INSERT OR REPLACE INTO processed_files (file_path, processed_at) VALUES (?, ?)",
                    (filepath, datetime.now(timezone.utc).isoformat()),
                )
                db.commit()
                db.close()

            return web.json_response({"status": "ingested", "filepath": filepath, "response": result})
        except Exception as e:
            log.error(f"Ingest error: {e}")
            return web.json_response(
                {"status": "file_written", "filepath": filepath, "error": str(e)},
                status=202
            )

    async def handle_query(request: web.Request):
        """POST /query — Query memories for a specific chat."""
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)

        chat_id = str(data.get("chat_id", ""))
        question = data.get("question", "").strip()
        if not chat_id:
            return web.json_response({"error": "missing 'chat_id'"}, status=400)

        if not question:
            question = "What do you know about this user? Summarize everything."

        answer = await agent.query(chat_id, question)
        return web.json_response({"chat_id": chat_id, "question": question, "answer": answer})

    async def handle_context(request: web.Request):
        """POST /context — Get concise user context for prompt injection."""
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)

        chat_id = str(data.get("chat_id", ""))
        if not chat_id:
            return web.json_response({"error": "missing 'chat_id'"}, status=400)

        context = await agent.get_user_context(chat_id)
        return web.json_response({"chat_id": chat_id, "context": context})

    async def handle_consolidate(request: web.Request):
        """POST /consolidate — Trigger consolidation."""
        chat_id = ""
        try:
            data = await request.json()
            chat_id = str(data.get("chat_id", ""))
        except Exception:
            pass

        result = await agent.consolidate(chat_id)
        return web.json_response({"status": "done", "response": result})

    async def handle_status(request: web.Request):
        """GET /status — Memory statistics."""
        chat_id = request.query.get("chat_id", "")
        stats = get_memory_stats(chat_id)
        return web.json_response(stats)

    async def handle_memories(request: web.Request):
        """GET /memories?chat_id=... — List memories for a chat."""
        chat_id = request.query.get("chat_id", "")
        if not chat_id:
            return web.json_response({"error": "missing ?chat_id= parameter"}, status=400)
        data = read_all_memories(chat_id)
        return web.json_response(data)

    async def handle_health(request: web.Request):
        """GET / — Health check."""
        return web.json_response({"status": "ok", "service": "always-on-memory"})

    app.router.add_get("/", handle_health)
    app.router.add_post("/ingest-event", handle_ingest_event)
    app.router.add_post("/query", handle_query)
    app.router.add_post("/context", handle_context)
    app.router.add_post("/consolidate", handle_consolidate)
    app.router.add_get("/status", handle_status)
    app.router.add_get("/memories", handle_memories)

    return app


# ─── Main ──────────────────────────────────────────────────────
async def main_async(args):
    agent = MemoryAgent()

    log.info("🧠 Always-On Memory Service starting")
    log.info(f"   Adapted from: GoogleCloudPlatform/generative-ai/gemini/agents/always-on-memory-agent")
    log.info(f"   Model: {MODEL}")
    log.info(f"   Database: {DB_PATH}")
    log.info(f"   Inbox: {args.inbox}")
    log.info(f"   Consolidate: every {args.consolidate_every}m (min {CONSOLIDATE_MIN_EVENTS} events/chat)")
    log.info(f"   API: http://localhost:{args.port}")
    log.info("")

    tasks = [
        asyncio.create_task(watch_inbox(agent, args.inbox)),
        asyncio.create_task(consolidation_loop(agent, args.consolidate_every)),
    ]

    app = build_http(agent, inbox_path=args.inbox)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", args.port)
    await site.start()

    log.info(f"✅ Memory service running on http://localhost:{args.port}")
    log.info(f"   POST /ingest-event  — write & ingest a conversation event")
    log.info(f"   POST /query         — query memories for a chat")
    log.info(f"   POST /context       — get user context for prompt injection")
    log.info(f"   POST /consolidate   — trigger consolidation")
    log.info(f"   GET  /status        — memory statistics")
    log.info(f"   GET  /memories      — list memories for a chat")
    log.info("")

    try:
        await asyncio.gather(*tasks)
    except asyncio.CancelledError:
        pass
    finally:
        await runner.cleanup()


def main():
    parser = argparse.ArgumentParser(
        description="Always-On Memory Service — adapted from GoogleCloudPlatform/generative-ai/gemini/agents/always-on-memory-agent"
    )
    parser.add_argument("--inbox", default=INBOX_PATH, help=f"Inbox folder to watch (default: {INBOX_PATH})")
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "8888")), help="HTTP API port (default: 8888)")
    parser.add_argument("--consolidate-every", type=int, default=CONSOLIDATE_EVERY_MINUTES, help=f"Consolidation interval in minutes (default: {CONSOLIDATE_EVERY_MINUTES})")
    args = parser.parse_args()

    loop = asyncio.new_event_loop()

    def shutdown(sig):
        log.info(f"\n👋 Shutting down (signal {sig})...")
        for task in asyncio.all_tasks(loop):
            task.cancel()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, shutdown, sig)

    try:
        loop.run_until_complete(main_async(args))
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        loop.close()
        log.info("🧠 Memory service stopped.")


if __name__ == "__main__":
    main()
