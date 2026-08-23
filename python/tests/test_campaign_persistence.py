"""Tests for dual-mode persistence: campaign save/load & durable auth.

API-level tests run against the default MemoryStore backend (no database
required). Postgres mode is exercised end-to-end through the storage layer
inside a single event loop when DATABASE_URL points at a live instance
(e.g. `docker compose up -d postgres`) — asyncpg pools are loop-bound, so
the store must be created and used within one loop.
"""

import os

import pytest
from fastapi.testclient import TestClient

import vtt_orchestrator.server as server_module
from vtt_orchestrator.server import app

client = TestClient(app)

SNAPSHOT = {
    "tokens": [{"id": "thorin_1", "x": 5, "y": 6}],
    "customWalls": [{"x": 1, "y": 1}],
    "messages": [{"id": "m1", "content": "hello"}],
}


@pytest.fixture()
def user_token():
    email = f"persist_{abs(hash(os.urandom(4)))}@aethertable.io"
    resp = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "display_name": "Saver", "password": "dice-dice"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["token"]


class TestCampaignSaveLoadApi:
    def test_save_list_load_roundtrip(self, user_token):
        saved = client.post(
            "/api/v1/campaign/save",
            json={"token": user_token, "name": "Baron Vane", "snapshot": SNAPSHOT, "round_number": 3},
        )
        assert saved.status_code == 200
        save_id = saved.json()["save_id"]

        listing = client.get("/api/v1/campaign/saves", params={"token": user_token}).json()
        assert listing["total"] == 1
        assert listing["saves"][0]["save_name"] == "Baron Vane"

        loaded = client.get(f"/api/v1/campaign/save/{save_id}", params={"token": user_token}).json()
        assert loaded["round_number"] == 3
        assert loaded["snapshot"]["tokens"][0]["id"] == "thorin_1"

    def test_same_name_upserts_instead_of_duplicating(self, user_token):
        for round_number in (2, 3):
            client.post(
                "/api/v1/campaign/save",
                json={"token": user_token, "name": "One Save", "snapshot": SNAPSHOT,
                      "round_number": round_number},
            )
        listing = client.get("/api/v1/campaign/saves", params={"token": user_token}).json()
        assert listing["total"] == 1
        assert listing["saves"][0]["round_number"] == 3

    def test_invalid_token_rejected(self):
        resp = client.post(
            "/api/v1/campaign/save",
            json={"token": "not-a-token", "name": "x", "snapshot": {}, "round_number": 1},
        )
        assert resp.status_code == 401

    def test_delete_removes_save(self, user_token):
        saved = client.post(
            "/api/v1/campaign/save",
            json={"token": user_token, "name": "Doomed", "snapshot": {}, "round_number": 1},
        ).json()
        deleted = client.delete(f"/api/v1/campaign/save/{saved['save_id']}", params={"token": user_token})
        assert deleted.status_code == 200
        gone = client.get(f"/api/v1/campaign/save/{saved['save_id']}", params={"token": user_token})
        assert gone.status_code == 404


@pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set; Postgres mode not exercised",
)
def test_postgres_store_end_to_end():
    """Full CRUD + durability through PostgresStore within one event loop."""
    import asyncio

    from vtt_orchestrator.storage import init_storage

    async def scenario():
        store = await init_storage()
        try:
            assert store.backend == "postgres"

            # Durable identity
            email = f"pg_probe_{os.urandom(4).hex()}@aethertable.io"
            record = await store.create_user(
                email=email, username="probe", display_name="Probe",
                role="player", password="dice-dice", assigned_token_ids=[],
            )
            fetched = await store.get_user_by_email(email)
            assert fetched is not None and store.verify_password(fetched, "dice-dice")
            assert not store.verify_password(fetched, "wrong")

            # Campaign save CRUD
            meta = await store.upsert_campaign_save(record["user_id"], "Probe Run", SNAPSHOT, 5)
            again = await store.upsert_campaign_save(record["user_id"], "Probe Run", SNAPSHOT, 6)
            saves = await store.list_campaign_saves(record["user_id"])
            assert len(saves) == 1 and saves[0]["round_number"] == 6

            loaded = await store.get_campaign_save(record["user_id"], meta["save_id"])
            assert loaded["snapshot"]["tokens"][0]["id"] == "thorin_1"

            # Cross-owner access denied
            other = await store.create_user(
                email=f"other_{os.urandom(3).hex()}@x.io", username="o", display_name="O",
                role="player", password="pass1234", assigned_token_ids=[],
            )
            assert await store.get_campaign_save(other["user_id"], meta["save_id"]) is None

            # Durability: a brand-new store instance (fresh pool) sees the data.
            fresh = await init_storage()
            try:
                survivor = await fresh.get_user_by_email(email)
                assert survivor is not None, "user must survive store re-init"
                fresh_saves = await fresh.list_campaign_saves(survivor["user_id"])
                assert any(s["save_id"] == meta["save_id"] for s in fresh_saves)
            finally:
                if getattr(fresh, "pool", None):
                    await fresh.pool.close()

            # Cleanup
            assert await store.delete_campaign_save(record["user_id"], meta["save_id"])
        finally:
            if getattr(store, "pool", None):
                await store.pool.close()

    asyncio.run(scenario())
