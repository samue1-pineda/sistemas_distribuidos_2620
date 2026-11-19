"""Pruebas end-to-end contra el clúster Docker real (NGINX + 2 nodos + 2 PostgreSQL).

Se omiten salvo que se definan ``CLUSTER_BASE_URL`` y la contraseña del administrador, p. ej.::

    CLUSTER_BASE_URL=http://localhost:8080 CLUSTER_ADMIN_PASSWORD=... python -m pytest tests/test_cluster_e2e.py -v
"""
from __future__ import annotations

import os
import time
import uuid

import httpx
import pytest

BASE_URL = os.getenv("CLUSTER_BASE_URL")
ADMIN_USER = os.getenv("CLUSTER_ADMIN_USER", "admin")
ADMIN_PASSWORD = os.getenv("CLUSTER_ADMIN_PASSWORD")
NODES = {"Nodo-Alpha-01", "Nodo-Beta-02"}

pytestmark = [
    pytest.mark.cluster,
    pytest.mark.skipif(
        not (BASE_URL and ADMIN_PASSWORD),
        reason="Define CLUSTER_BASE_URL (p. ej. http://localhost:8080) y CLUSTER_ADMIN_PASSWORD con el clúster arriba",
    ),
]

ITEMS = [{"product": "Caja e2e", "quantity": 2, "unit_price": 10.0}]


def _reset(http: httpx.Client) -> None:
    for node in NODES:
        http.put(f"/api/chaos/crash/{node}", json={"enabled": False})
    http.put("/api/chaos/db-primary", json={"enabled": False})
    time.sleep(0.5)


def _hit_both_nodes(http: httpx.Client, path: str, headers: dict, expected_status: int, check=None) -> set[str]:
    """Repite la petición hasta que la hayan atendido AMBOS nodos (todas con el estado esperado).

    NGINX excluye durante ``fail_timeout`` (10 s) a un nodo que falló, aunque ya se haya restaurado; si
    un test anterior lo "tumbó" hace menos de 10 s, al principio sólo responde el otro. Por eso no basta
    con un número fijo de peticiones (en CI la suite es más rápida y caía dentro de esa ventana).
    """
    seen: set[str] = set()
    deadline = time.monotonic() + 20
    while seen != NODES and time.monotonic() < deadline:
        response = http.get(path, headers=headers)
        assert response.status_code == expected_status, response.text
        if check:
            check(response)
        seen.add(response.headers["X-Handled-By-Node"])
        if seen != NODES:
            time.sleep(0.5)
    return seen


@pytest.fixture
def http():
    with httpx.Client(base_url=BASE_URL, timeout=15) as client:
        response = client.post("/api/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASSWORD})
        assert response.status_code == 200, response.text
        client.headers["Authorization"] = f"Bearer {response.json()['access_token']}"
        _reset(client)
        yield client
        _reset(client)


def test_e2e_sesion_valida_en_ambos_nodos_y_sin_reintentos_en_401(http):
    username = f"e2e_{uuid.uuid4().hex[:8]}"
    registered = http.post(
        "/api/auth/register",
        json={"username": username, "full_name": "Cliente E2E", "password": "ClienteE2E1"},
        headers={"Authorization": ""},
    )
    assert registered.status_code == 201, registered.text
    user_headers = {"Authorization": f"Bearer {registered.json()['access_token']}"}

    # El mismo token, validado por ambos nodos sin estado compartido.
    seen = _hit_both_nodes(
        http, "/api/auth/me", user_headers, 200,
        check=lambda me: me.json()["user"]["username"] == username or pytest.fail(me.text),
    )
    assert seen == NODES

    anonymous = http.get("/api/orders", headers={"Authorization": ""})
    assert anonymous.status_code == 401
    assert anonymous.headers["X-Upstream-Status"] == "401"  # NGINX no reintenta errores de autenticación
    assert http.get("/api/chaos/status", headers=user_headers).status_code == 403


def test_e2e_round_robin_alterna_entre_los_dos_nodos(http):
    handled = []
    for _ in range(6):
        response = http.get("/api/orders")
        assert response.status_code == 200
        handled.append(response.headers["X-Handled-By-Node"])
    assert set(handled) == NODES, handled
    # Round-Robin: reparto equilibrado (tolera peticiones ajenas, p. ej. el dashboard abierto).
    assert all(handled.count(node) >= 2 for node in NODES), handled


def test_e2e_caida_de_nodo_es_transparente_para_el_cliente(http):
    assert http.put("/api/chaos/crash/Nodo-Alpha-01", json={"enabled": True}).json()["simulate_crash"] is True

    upstream_statuses = []
    for _ in range(8):
        response = http.get("/api/orders")
        assert response.status_code == 200  # el cliente nunca ve el 503
        assert response.headers["X-Handled-By-Node"] == "Nodo-Beta-02"
        upstream_statuses.append(response.headers.get("X-Upstream-Status", ""))
    assert any("503" in status for status in upstream_statuses), upstream_statuses  # NGINX reintentó

    created = http.post("/api/orders", json={"customer_name": "E2E caída de nodo", "items": ITEMS})
    assert created.status_code == 201
    assert created.headers["X-Handled-By-Node"] == "Nodo-Beta-02"
    http.put("/api/chaos/crash/Nodo-Alpha-01", json={"enabled": False})
    assert http.delete(f"/api/orders/{created.json()['data']['id']}").status_code == 200


def test_e2e_failover_de_bd_primaria_y_reconciliacion(http):
    down = http.put("/api/chaos/db-primary", json={"enabled": True}).json()
    assert all(p["ok"] for p in down["propagated_to"]) and len(down["propagated_to"]) == 2

    for _ in range(2):  # ambos nodos conmutan a la réplica
        listed = http.get("/api/orders")
        assert listed.status_code == 200
        assert listed.json()["db_used"] == "replica_failover"

    created = http.post("/api/orders", json={"customer_name": "E2E failover BD", "items": ITEMS})
    assert created.status_code == 201
    assert created.json()["db_used"] == "replica_failover"
    assert created.json()["replication"] == "pending"
    order_id = created.json()["data"]["id"]
    assert http.get("/api/replication/status").json()["in_sync"] is False

    up = http.put("/api/chaos/db-primary", json={"enabled": False}).json()
    assert up["sync"]["status"] == "ok"
    status = http.get("/api/replication/status").json()
    assert status["in_sync"] is True, status

    fetched = http.get(f"/api/orders/{order_id}")
    assert fetched.status_code == 200
    assert fetched.json()["db_used"] == "primary"
    assert http.delete(f"/api/orders/{order_id}").status_code == 200


def test_e2e_gateway_sirve_el_frontend_react(http):
    home = http.get("/")
    assert home.status_code == 200
    assert "text/html" in home.headers["content-type"]
    assert '<div id="root">' in home.text

    spa_route = http.get("/ruta/del/frontend")  # try_files -> index.html
    assert spa_route.status_code == 200
    assert '<div id="root">' in spa_route.text


def test_e2e_monitoreo_agrega_ambos_nodos_y_el_gateway(http):
    for _ in range(6):
        http.get("/api/orders")
    view = http.get("/api/monitoring/cluster", params={"window": 300})
    assert view.status_code == 200, view.text
    data = view.json()

    nodes = {n["node"]: n for n in data["nodes"]}
    assert set(nodes) == NODES and all(n["reachable"] for n in nodes.values())
    assert data["summary"]["nodes_up"] == 2
    assert sum(n["traffic"]["window_requests"] for n in nodes.values()) >= 6
    # El gateway expone stub_status en un puerto interno (8081) que los nodos leen por la red de Docker.
    assert data["gateway"]["configured"] is True and data["gateway"]["reachable"] is True
    assert data["gateway"]["requests"] > 0
    with httpx.Client(timeout=3) as outside:  # ...y que NO está publicado hacia fuera
        try:
            outside.get(BASE_URL.replace(":8080", ":8081") + "/nginx_status")
            exposed = True
        except httpx.HTTPError:
            exposed = False
    assert exposed is False


def test_e2e_administracion_revoca_sesiones_en_ambos_nodos_y_audita(http):
    username = f"e2e_admin_{uuid.uuid4().hex[:6]}"
    registered = http.post(
        "/api/auth/register",
        json={"username": username, "full_name": "Cliente Revocable", "password": "ClienteE2E1"},
        headers={"Authorization": ""},
    ).json()
    user_id = registered["user"]["id"]
    user_headers = {"Authorization": f"Bearer {registered['access_token']}"}
    assert http.get("/api/orders", headers=user_headers).status_code == 200

    off = http.patch(f"/api/admin/users/{user_id}", json={"is_active": False})
    assert off.status_code == 200 and off.json()["replication"] == "synced"
    # Ningún nodo acepta ya su token: la sesión se revoca sin estado compartido entre nodos.
    assert _hit_both_nodes(http, "/api/orders", user_headers, 401) == NODES

    actions = [e["action"] for e in http.get("/api/admin/audit", params={"entity_id": user_id}).json()["data"]]
    assert actions == ["user.deactivate", "user.register"]
    assert http.delete(f"/api/admin/users/{user_id}", params={"orders": "delete"}).status_code == 200
