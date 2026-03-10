"""
Verification script for the Always-On Memory Service.

Tests the core functionality:
  1. Inbox JSON file writing
  2. Event ingestion into SQLite
  3. Per-chat memory isolation
  4. Consolidation generating summaries/insights
  5. Context query for prompt injection

Usage:
    # Start the memory service first:
    #   GOOGLE_API_KEY=your-key python agent.py
    #
    # Then run this script:
    #   python test_memory.py

    # Or run with --offline for database-only tests (no Gemini calls):
    #   python test_memory.py --offline
"""

import argparse
import json
import os
import sqlite3
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

# Add parent dir to path so we can import agent module functions
sys.path.insert(0, os.path.dirname(__file__))

# Test configuration
MEMORY_SERVICE_URL = os.getenv("MEMORY_SERVICE_URL", "http://localhost:8888")


@contextmanager
def temp_db():
    """Context manager that swaps agent.DB_PATH to a temp file and restores it after."""
    import agent
    original_path = agent.DB_PATH
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    agent.DB_PATH = tmp.name
    try:
        # Initialize schema
        db = agent.get_db()
        db.close()
        yield tmp.name
    finally:
        agent.DB_PATH = original_path
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def test_inbox_file_writing():
    """Test 1: Verify that conversation events are written as JSON files to inbox."""
    print("\n── Test 1: Inbox File Writing ──────────────────────────────")

    from agent import write_event_to_inbox

    with tempfile.TemporaryDirectory() as tmpdir:
        event = {
            "chat_id": "test_chat_123",
            "user_id": "test_user_456",
            "role": "user",
            "telegram_update_id": 991001,
            "telegram_message_id": 443,
            "ts": int(time.time()),
            "text": "hello, i'm testing the memory system!",
            "source": "telegram",
            "user_meta": {
                "first_name": "TestUser",
                "username": "testuser"
            }
        }

        filepath = write_event_to_inbox(event, inbox_path=tmpdir)
        path = Path(filepath)

        assert path.exists(), f"File was not created: {filepath}"
        assert path.parent.name == "test_chat_123", "Chat ID directory not correct"
        assert "__user__" in path.name, "Filename should contain role"
        assert "update_991001" in path.name, "Filename should contain update_id"
        assert path.suffix == ".json", "File should be .json"

        # Verify contents
        data = json.loads(path.read_text())
        assert data["chat_id"] == "test_chat_123"
        assert data["text"] == "hello, i'm testing the memory system!"
        assert data["role"] == "user"

        print("  ✅ Event written as JSON file to inbox/<chat_id>/")
        print(f"     Path: {filepath}")
        print(f"     Filename: {path.name}")

        # Write an assistant reply event too
        reply_event = {
            "chat_id": "test_chat_123",
            "user_id": "test_chat_123",
            "role": "assistant",
            "ts": int(time.time()),
            "text": "hey!! nice to meet you!",
            "source": "telegram",
        }
        reply_path = write_event_to_inbox(reply_event, inbox_path=tmpdir)
        assert Path(reply_path).exists()
        assert "__assistant__" in Path(reply_path).name
        print("  ✅ Assistant reply event also written correctly")

    print("  ✅ PASSED")


def test_database_schema():
    """Test 2: Verify SQLite schema has chat_id columns and indexes."""
    print("\n── Test 2: Database Schema ─────────────────────────────────")

    from agent import get_db

    with temp_db() as db_path:
        db = sqlite3.connect(db_path)
        db.row_factory = sqlite3.Row

        # Check memories table has chat_id
        cursor = db.execute("PRAGMA table_info(memories)")
        columns = {row[1] for row in cursor.fetchall()}
        assert "chat_id" in columns, "memories table missing chat_id column"
        assert "user_id" in columns, "memories table missing user_id column"
        print("  ✅ memories table has chat_id and user_id columns")

        # Check consolidations table has chat_id
        cursor = db.execute("PRAGMA table_info(consolidations)")
        columns = {row[1] for row in cursor.fetchall()}
        assert "chat_id" in columns, "consolidations table missing chat_id column"
        print("  ✅ consolidations table has chat_id column")

        # Check processed_files table
        cursor = db.execute("PRAGMA table_info(processed_files)")
        columns = {row[1] for row in cursor.fetchall()}
        assert "file_path" in columns
        print("  ✅ processed_files table exists")

        # Check indexes
        cursor = db.execute("SELECT name FROM sqlite_master WHERE type='index'")
        indexes = {row[0] for row in cursor.fetchall()}
        assert "idx_memories_chat_id" in indexes, "Missing index on memories.chat_id"
        print("  ✅ Index on memories.chat_id exists")

        db.close()

    print("  ✅ PASSED")


def test_per_chat_isolation():
    """Test 3: Verify that memory storage and queries are isolated per chat_id."""
    print("\n── Test 3: Per-Chat Isolation ──────────────────────────────")

    from agent import store_memory, read_all_memories, read_unconsolidated_memories

    with temp_db():
        # Store memories for two different chats
        store_memory(
            chat_id="chat_A",
            user_id="user_1",
            raw_text="I love pizza",
            summary="User likes pizza",
            entities=["pizza"],
            topics=["food", "preferences"],
            importance=0.7,
            source="test",
        )
        store_memory(
            chat_id="chat_B",
            user_id="user_2",
            raw_text="I have an exam tomorrow",
            summary="User has an exam",
            entities=["exam"],
            topics=["school", "stress"],
            importance=0.9,
            source="test",
        )
        store_memory(
            chat_id="chat_A",
            user_id="user_1",
            raw_text="My name is Alice",
            summary="User's name is Alice",
            entities=["Alice"],
            topics=["identity"],
            importance=0.9,
            source="test",
        )

        # Query chat_A — should only see its own memories
        result_a = read_all_memories("chat_A")
        assert result_a["count"] == 2, f"Chat A should have 2 memories, got {result_a['count']}"
        summaries_a = {m["summary"] for m in result_a["memories"]}
        assert "User likes pizza" in summaries_a
        assert "User's name is Alice" in summaries_a
        assert "User has an exam" not in summaries_a
        print("  ✅ Chat A only sees its own 2 memories")

        # Query chat_B — should only see its own memories
        result_b = read_all_memories("chat_B")
        assert result_b["count"] == 1, f"Chat B should have 1 memory, got {result_b['count']}"
        assert result_b["memories"][0]["summary"] == "User has an exam"
        print("  ✅ Chat B only sees its own 1 memory")

        # Unconsolidated queries should also be isolated
        uncon_a = read_unconsolidated_memories("chat_A")
        assert uncon_a["count"] == 2
        uncon_b = read_unconsolidated_memories("chat_B")
        assert uncon_b["count"] == 1
        print("  ✅ Unconsolidated memory queries are chat-isolated")

    print("  ✅ PASSED")


def test_consolidation_isolation():
    """Test 4: Verify consolidation is scoped per chat_id."""
    print("\n── Test 4: Consolidation Isolation ─────────────────────────")

    from agent import store_memory, store_consolidation, read_consolidation_history

    with temp_db():
        # Store memories for chat_X
        m1 = store_memory("chat_X", "u1", "I like dogs", "User likes dogs", ["dogs"], ["pets"], 0.7)
        m2 = store_memory("chat_X", "u1", "I walk my dog daily", "User walks dog daily", ["dog"], ["routine"], 0.6)

        # Store memories for chat_Y
        m3 = store_memory("chat_Y", "u2", "I study math", "User studies math", ["math"], ["school"], 0.7)

        # Consolidate chat_X
        result = store_consolidation(
            chat_id="chat_X",
            source_ids=[m1["memory_id"], m2["memory_id"]],
            summary="User is a dog owner with a daily walking routine",
            insight="Pet care is important to this user",
            connections=[{"from_id": m1["memory_id"], "to_id": m2["memory_id"], "relationship": "both about dogs"}],
        )
        assert result["status"] == "consolidated"
        print("  ✅ Consolidation stored for chat_X")

        # Check consolidation history is isolated
        hist_x = read_consolidation_history("chat_X")
        assert hist_x["count"] == 1
        print("  ✅ Chat X has 1 consolidation record")

        hist_y = read_consolidation_history("chat_Y")
        assert hist_y["count"] == 0
        print("  ✅ Chat Y has 0 consolidation records (properly isolated)")

    print("  ✅ PASSED")


def test_memory_stats():
    """Test 5: Verify memory stats support both global and per-chat scoping."""
    print("\n── Test 5: Memory Stats ────────────────────────────────────")

    from agent import store_memory, get_memory_stats

    with temp_db():
        store_memory("c1", "u1", "txt", "summary1", [], [], 0.5)
        store_memory("c1", "u1", "txt", "summary2", [], [], 0.5)
        store_memory("c2", "u2", "txt", "summary3", [], [], 0.5)

        # Global stats
        global_stats = get_memory_stats()
        assert global_stats["total_memories"] == 3
        print(f"  ✅ Global stats: {global_stats['total_memories']} total memories")

        # Per-chat stats
        c1_stats = get_memory_stats("c1")
        assert c1_stats["total_memories"] == 2
        assert c1_stats["chat_id"] == "c1"
        print(f"  ✅ Chat c1 stats: {c1_stats['total_memories']} memories")

        c2_stats = get_memory_stats("c2")
        assert c2_stats["total_memories"] == 1
        print(f"  ✅ Chat c2 stats: {c2_stats['total_memories']} memories")

    print("  ✅ PASSED")


def test_api_integration():
    """Test 6: Integration test — actually call the running memory service API."""
    print("\n── Test 6: API Integration (requires running service) ─────")

    try:
        import requests
    except ImportError:
        print("  ⚠️  `requests` not installed — skipping API test")
        return

    # Check if service is running
    try:
        resp = requests.get(f"{MEMORY_SERVICE_URL}/", timeout=3)
        if resp.status_code != 200:
            print(f"  ⚠️  Memory service not responding at {MEMORY_SERVICE_URL} — skipping")
            return
    except Exception:
        print(f"  ⚠️  Memory service not reachable at {MEMORY_SERVICE_URL} — skipping")
        return

    print(f"  ℹ️  Testing against {MEMORY_SERVICE_URL}")

    test_chat_id = f"test_{int(time.time())}"

    # Ingest a user event
    event = {
        "chat_id": test_chat_id,
        "user_id": "test_user",
        "role": "user",
        "ts": int(time.time()),
        "text": "my name is TestBot and i really love chocolate cake",
        "source": "test",
        "user_meta": {"first_name": "TestBot", "username": "testbot"}
    }
    resp = requests.post(f"{MEMORY_SERVICE_URL}/ingest-event", json=event, timeout=30)
    print(f"  Ingest response: {resp.status_code} — {resp.json().get('status', 'unknown')}")
    assert resp.status_code in (200, 202), f"Ingest failed: {resp.text}"
    print("  ✅ Event ingested")

    # Query context
    resp = requests.post(f"{MEMORY_SERVICE_URL}/context", json={"chat_id": test_chat_id}, timeout=30)
    print(f"  Context response: {resp.status_code}")
    if resp.status_code == 200:
        ctx = resp.json().get("context", "")
        print(f"  Context: {ctx[:200]}...")
        print("  ✅ Context query returned a response")
    else:
        print(f"  ⚠️  Context query returned {resp.status_code}: {resp.text[:200]}")

    # Check memories
    resp = requests.get(f"{MEMORY_SERVICE_URL}/memories?chat_id={test_chat_id}", timeout=10)
    if resp.status_code == 200:
        data = resp.json()
        print(f"  ✅ Memories for test chat: {data.get('count', 0)}")
    else:
        print(f"  ⚠️  Memories query returned {resp.status_code}")

    # Check status
    resp = requests.get(f"{MEMORY_SERVICE_URL}/status?chat_id={test_chat_id}", timeout=10)
    if resp.status_code == 200:
        stats = resp.json()
        print(f"  ✅ Stats: {stats}")

    print("  ✅ PASSED")


def main():
    parser = argparse.ArgumentParser(description="Memory service verification tests")
    parser.add_argument("--offline", action="store_true", help="Run only offline tests (no Gemini/API calls)")
    args = parser.parse_args()

    print("=" * 60)
    print("  Always-On Memory Service — Verification Tests")
    print("=" * 60)

    # Offline tests (always run)
    test_inbox_file_writing()
    test_database_schema()
    test_per_chat_isolation()
    test_consolidation_isolation()
    test_memory_stats()

    # Online tests (require running service)
    if not args.offline:
        test_api_integration()
    else:
        print("\n── Skipping API integration test (--offline mode) ────────")

    print("\n" + "=" * 60)
    print("  ✅ All tests passed!")
    print("=" * 60)


if __name__ == "__main__":
    main()
