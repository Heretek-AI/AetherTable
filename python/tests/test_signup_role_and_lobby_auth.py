"""Audit findings F6 + F8: honest role assignment, fail-closed secrets, lobby privacy.

F6a — ``POST /api/v1/auth/signup`` used to accept any role string verbatim,
INCLUDING ``admin`` and ``gm``. Every staff RBAC gate in the gateway and the
Rust engine keys off that client-chosen claim, so self-service signup was
self-service privilege escalation. Signup now grants only ``player`` or
``spectator``; staff roles are rejected with 422 pointing at the real
bootstrap mechanism (``VTT_ADMIN_EMAILS``).

F6b — the gateway fell back to the hardcoded ``aethertable-dev-secret`` when
neither ``AUTH_SECRET`` nor ``VTT_ENGINE_SECRET`` was configured, meaning a
deployment that forgot the env var issued FORGEABLE session tokens (anyone
who read the source could mint an admin token). The Rust engine already
refuses to start in that situation; the gateway now fails closed the same way.

F8 — ``GET /api/v1/lobbies/{id}`` required only a valid token, so any
authenticated user could read ANY lobby's full record including its invite
code — and the invite code is the sole gate on join_lobby, which is the
authorization primitive behind x-card rewind, the durability bridge, and
agent turns. The route now requires lobby membership or a staff role, and
answers non-members identically whether the id exists or not (no existence
oracle).
"""

import os
import subprocess
import sys
import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator import server as server_mod
from vtt_orchestrator.server import app

client = TestClient(app)


def _signup(email: str, password: str = "dice-dice", **extra) -> object:
    return client.post(
        "/api/v1/auth/signup",
        json={"email": email, "username": email.split("@")[0],
              "display_name": email.split("@")[0], "password": password, **extra},
    )


def _unique(tag: str) -> str:
    return f"{tag}_{abs(hash(tag + str(time.time()))) % 10**9}@example.com"


def _signed(user_id: str, role: str) -> str:
    return server_mod._sign_token(
        {"user_id": user_id, "role": role, "exp": time.time() + 600}
    )


# --- F6a: signup cannot mint staff roles ---------------------------------------


class TestSignupRoleRestriction:
    @pytest.mark.parametrize("role", ["admin", "gm"])
    def test_staff_roles_rejected_at_signup(self, role):
        resp = _signup(_unique(f"escalate_{role}"), role=role)
        assert resp.status_code == 422, resp.text
        detail = str(resp.json().get("detail", ""))
        # The rejection must TEACH the operator the real bootstrap path.
        assert "VTT_ADMIN_EMAILS" in detail

    def test_unknown_role_rejected_not_silently_demoted(self):
        """The old code silently coerced junk roles to 'player', hiding client
        bugs. Honest behavior is a 422."""
        resp = _signup(_unique("wizard_lord"), role="archmage")
        assert resp.status_code == 422, resp.text

    @pytest.mark.parametrize("role", ["player", "spectator"])
    def test_self_service_roles_still_work(self, role):
        email = _unique(f"honest_{role}")
        resp = _signup(email, role=role)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["user"]["role"] == role

        # And the signed token carries exactly what the DB record says.
        token = body["token"]
        session = client.get("/api/v1/auth/session",
                             headers={"Authorization": f"Bearer {token}"})
        assert session.status_code == 200
        assert session.json()["user"]["role"] == role


class TestAdminBootstrap:
    def test_listed_email_gets_admin_at_signup(self, monkeypatch):
        email = _unique("bootstrapped_admin")
        monkeypatch.setenv("VTT_ADMIN_EMAILS", f"someone_else@example.com, {email.upper()} ")
        resp = _signup(email)
        assert resp.status_code == 200, resp.text
        assert resp.json()["user"]["role"] == "admin"
        # The claim must also travel in the SIGNED payload the engine trusts.
        token = resp.json()["token"]
        actor = server_mod._caller_actor(token)
        assert actor["role"] == "admin"

    def test_unlisted_email_stays_player_even_with_env_set(self, monkeypatch):
        monkeypatch.setenv("VTT_ADMIN_EMAILS", "boss@example.com")
        resp = _signup(_unique("not_boss"))
        assert resp.status_code == 200, resp.text
        assert resp.json()["user"]["role"] == "player"

    def test_no_env_no_admins(self):
        resp = _signup(_unique("plain_player"))
        assert resp.status_code == 200, resp.text
        assert resp.json()["user"]["role"] == "player"


# --- F6b: gateway fails closed without a signing secret -------------------------

def _import_server_env(**overrides) -> subprocess.CompletedProcess:
    """Runs `import vtt_orchestrator.server` in a fresh interpreter with the
    given environment, so module-import-time behavior is observable."""
    repo_python = os.path.dirname(os.path.dirname(server_mod.__file__))
    env = {k: v for k, v in os.environ.items()
           if k not in ("AUTH_SECRET", "VTT_ENGINE_SECRET")}
    env["PYTHONPATH"] = repo_python + os.pathsep + env.get("PYTHONPATH", "")
    env.update(overrides)
    return subprocess.run(
        [sys.executable, "-c", "import vtt_orchestrator.server"],
        capture_output=True, text=True, env=env, timeout=120,
    )


class TestSecretFailClosed:
    def test_import_fails_without_any_secret(self):
        proc = _import_server_env()
        assert proc.returncode != 0, (
            "gateway imported cleanly with NO signing secret configured — "
            "it would silently issue forgeable tokens"
        )
        assert "AUTH_SECRET" in proc.stderr
        assert "aethertable-dev-secret" not in proc.stdout

    def test_import_succeeds_with_auth_secret_only(self):
        proc = _import_server_env(AUTH_SECRET="test-only-signing-secret")
        assert proc.returncode == 0, proc.stderr

    def test_import_succeeds_with_engine_secret_only(self):
        proc = _import_server_env(VTT_ENGINE_SECRET="test-only-engine-secret")
        assert proc.returncode == 0, proc.stderr

    def test_resolver_prefers_auth_secret_then_engine_secret(self, monkeypatch):
        monkeypatch.delenv("AUTH_SECRET", raising=False)
        monkeypatch.delenv("VTT_ENGINE_SECRET", raising=False)
        with pytest.raises(RuntimeError, match="AUTH_SECRET"):
            server_mod._resolve_auth_secret()
        monkeypatch.setenv("VTT_ENGINE_SECRET", "engine-side")
        assert server_mod._resolve_auth_secret() == "engine-side"
        monkeypatch.setenv("AUTH_SECRET", "auth-side")
        assert server_mod._resolve_auth_secret() == "auth-side"


# --- F8: lobby reads require membership or staff --------------------------------


@pytest.fixture()
def table():
    """A host with a lobby, plus an outsider who is NOT a member."""
    host_email, outsider_email = _unique("lob_host"), _unique("lob_outsider")
    host = _signup(host_email).json()
    outsider = _signup(outsider_email).json()
    created = client.post("/api/v1/lobbies",
                          headers={"Authorization": f"Bearer {host['token']}"},
                          json={"name": "Sunken Crypt Run"})
    assert created.status_code == 200, created.text
    return {"host": host, "outsider": outsider, "lobby": created.json()}


class TestLobbyReadAuthorization:
    def test_member_host_reads_own_lobby_with_invite_code(self, table):
        resp = client.get(
            f"/api/v1/lobbies/{table['lobby']['lobby_id']}",
            headers={"Authorization": f"Bearer {table['host']['token']}"},
        )
        assert resp.status_code == 200, resp.text
        # Members still see the invite code — they need it to share the table.
        assert len(resp.json()["invite_code"]) == 6

    def test_joined_member_can_read_lobby(self, table):
        joined = client.post(
            f"/api/v1/lobbies/{table['lobby']['lobby_id']}/join",
            headers={"Authorization": f"Bearer {table['outsider']['token']}"},
            json={"invite_code": table["lobby"]["invite_code"]},
        )
        assert joined.status_code == 200, joined.text
        resp = client.get(
            f"/api/v1/lobbies/{table['lobby']['lobby_id']}",
            headers={"Authorization": f"Bearer {table['outsider']['token']}"},
        )
        assert resp.status_code == 200, resp.text

    def test_non_member_gets_403_without_invite_code(self, table):
        resp = client.get(
            f"/api/v1/lobbies/{table['lobby']['lobby_id']}",
            headers={"Authorization": f"Bearer {table['outsider']['token']}"},
        )
        assert resp.status_code == 403, resp.text
        assert "invite_code" not in resp.text

    def test_no_existence_oracle_for_foreign_ids(self, table):
        """A non-member must get the SAME error for a foreign-but-real lobby
        and a garbage id, so the route can't be probed as an existence oracle."""
        real = client.get(
            f"/api/v1/lobbies/{table['lobby']['lobby_id']}",
            headers={"Authorization": f"Bearer {table['outsider']['token']}"},
        )
        fake = client.get(
            "/api/v1/lobbies/lob_does_not_exist_000000",
            headers={"Authorization": f"Bearer {table['outsider']['token']}"},
        )
        assert real.status_code == fake.status_code == 403
        assert real.json()["detail"] == fake.json()["detail"]

    def test_gm_token_may_read_any_lobby(self, table):
        resp = client.get(
            f"/api/v1/lobbies/{table['lobby']['lobby_id']}",
            headers={"Authorization": f"Bearer {_signed('staff_gm', 'gm')}"},
        )
        assert resp.status_code == 200, resp.text

    def test_anonymous_still_401(self, table):
        assert client.get(
            f"/api/v1/lobbies/{table['lobby']['lobby_id']}"
        ).status_code == 401

    def test_mine_never_lists_foreign_lobbies(self, table):
        mine = client.get(
            "/api/v1/lobbies/mine",
            headers={"Authorization": f"Bearer {table['outsider']['token']}"},
        )
        assert mine.status_code == 200
        ids = [l["lobby_id"] for l in mine.json()["lobbies"]]
        assert table["lobby"]["lobby_id"] not in ids
        assert all("invite_code" in l for l in mine.json()["lobbies"]), (
            "own-lobby listing keeps invite codes (members need them to share)"
        )

    def test_join_by_code_never_returns_foreign_roster_on_bad_code(self, table):
        bad = client.post(
            f"/api/v1/lobbies/{table['lobby']['lobby_id']}/join",
            headers={"Authorization": f"Bearer {table['outsider']['token']}"},
            json={"invite_code": "ZZZZZZ"},
        )
        assert bad.status_code == 403, bad.text
        assert "invite_code" not in bad.text
