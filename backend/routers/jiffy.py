from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from bson import ObjectId
import httpx
import time
import logging
from database import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/integrations/jiffy", tags=["Jiffy Integrations"])

COLLECTION = "jiffy_integrations"

# In-memory token cache: { integration_id: { "token": str, "expires_at": float } }
_token_cache: dict[str, dict] = {}


class JiffyIntegrationIn(BaseModel):
    env_name: str
    url: str
    client_id: str
    client_secret: str


class JiffyIntegrationOut(JiffyIntegrationIn):
    id: str


def _serialize(doc: dict) -> dict:
    doc["id"] = str(doc.pop("_id"))
    return doc


@router.post("", response_model=JiffyIntegrationOut, status_code=201)
def create_integration(payload: JiffyIntegrationIn):
    db = get_db()
    data = payload.model_dump()
    result = db[COLLECTION].insert_one(data)
    created = db[COLLECTION].find_one({"_id": result.inserted_id})
    return _serialize(created)


@router.get("", response_model=list[JiffyIntegrationOut])
def list_integrations():
    db = get_db()
    return [_serialize(doc) for doc in db[COLLECTION].find()]


@router.get("/{integration_id}", response_model=JiffyIntegrationOut)
def get_integration(integration_id: str):
    db = get_db()
    doc = db[COLLECTION].find_one({"_id": ObjectId(integration_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Integration not found")
    return _serialize(doc)


@router.put("/{integration_id}", response_model=JiffyIntegrationOut)
def update_integration(integration_id: str, payload: JiffyIntegrationIn):
    db = get_db()
    data = payload.model_dump()
    result = db[COLLECTION].find_one_and_replace(
        {"_id": ObjectId(integration_id)},
        data,
        return_document=True,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Integration not found")
    _token_cache.pop(integration_id, None)
    return _serialize(result)


@router.delete("/{integration_id}", status_code=204)
def delete_integration(integration_id: str):
    db = get_db()
    result = db[COLLECTION].delete_one({"_id": ObjectId(integration_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Integration not found")
    _token_cache.pop(integration_id, None)


def _get_access_token(doc: dict) -> str:
    integration_id = str(doc.get("_id", doc.get("id", "")))
    cached = _token_cache.get(integration_id)
    if cached and cached["expires_at"] > time.time() + 30:
        return cached["token"]

    token_url = f"{str(doc['url']).rstrip('/')}/apexiam/v1/auth/token"
    response = httpx.post(
        token_url,
        params={"tenantId": "jiffy"},
        data={
            "grant_type": "client_credentials",
            "client_id": doc["client_id"],
            "client_secret": doc["client_secret"],
            "scope": "openid",
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=30,
    )
    if response.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Authentication failed — Jiffy returned {response.status_code}",
        )
    token_data = response.json()
    token = token_data.get("access_token") or token_data.get("token")
    expires_in = token_data.get("expires_in", 3600)
    _token_cache[integration_id] = {
        "token": token,
        "expires_at": time.time() + expires_in,
    }
    return token


@router.post("/{integration_id}/test")
def test_integration(integration_id: str):
    db = get_db()
    doc = db[COLLECTION].find_one({"_id": ObjectId(integration_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Integration not found")

    try:
        _get_access_token(doc)
        return {"success": True, "message": "Connection successful"}
    except HTTPException as e:
        return {"success": False, "message": e.detail}
    except httpx.TimeoutException:
        return {"success": False, "message": "Connection timed out — check the URL"}
    except httpx.RequestError as e:
        return {"success": False, "message": f"Could not reach server: {e}"}


@router.get("/{integration_id}/tenants/{tenant_name}/apps")
def list_tenant_apps(integration_id: str, tenant_name: str, offset: int = 0, limit: int = 50):
    db = get_db()
    doc = db[COLLECTION].find_one({"_id": ObjectId(integration_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Integration not found")

    try:
        token = _get_access_token(doc)
        base = str(doc["url"]).rstrip("/")
        response = httpx.get(
            f"{base}/pam/tenant/{tenant_name}/app/list",
            params={"offset": offset, "limit": limit, "inst": "true"},
            headers={
                "Authorization": f"Bearer {token}",
                "Origin": "jiffy.ai",
            },
            timeout=15,
        )
        if response.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"Jiffy app list returned {response.status_code}",
            )
        return response.json()
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Request to Jiffy timed out")
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Could not reach Jiffy: {e}")


# ── UUID resolution cache: { "{integration_id}:{tenant_name}:{app_name}" → (tenant_uuid, app_uuid) }
_uuid_cache: dict[str, tuple[str, str]] = {}


def _resolve_uuids(doc: dict, token: str, tenant_name: str, app_name: str) -> tuple[str, str]:
    """Resolve tenant_name + app_name → (tenant_uuid, app_uuid) via PAM."""
    integration_id = str(doc.get("_id", doc.get("id", "")))
    cache_key = f"{integration_id}:{tenant_name}:{app_name}"
    if cache_key in _uuid_cache:
        return _uuid_cache[cache_key]

    base = str(doc["url"]).rstrip("/")
    hdrs = {"Authorization": f"Bearer {token}", "Origin": "jiffy.ai"}

    # Tenant UUID
    t_resp = httpx.get(f"{base}/pam/tenant/list", params={"offset": 0, "limit": 200}, headers=hdrs, timeout=15)
    t_data = t_resp.json()
    logger.info("PAM tenant list raw keys: %s (status %s)", list(t_data.keys()) if isinstance(t_data, dict) else type(t_data).__name__, t_resp.status_code)

    # Flatten regardless of envelope shape
    if isinstance(t_data, list):
        t_list = t_data
    else:
        t_list = (t_data.get("data") or t_data.get("tenants") or t_data.get("results")
                  or t_data.get("content") or t_data.get("list") or [])

    tenant_name_lower = tenant_name.lower()
    tenant_uuid: str | None = None
    for t in t_list:
        if not isinstance(t, dict):
            continue
        # Try every plausible name field, case-insensitive
        for field in ("name", "tenantId", "tenant_name", "tenantName", "id", "code", "slug"):
            val = str(t.get(field) or "").lower()
            if val == tenant_name_lower:
                tenant_uuid = t.get("id") or t.get("tenantId") or t.get("uuid")
                break
        if tenant_uuid:
            break

    if not tenant_uuid:
        logger.warning(
            "Tenant '%s' not found in PAM tenant list. First 3 entries: %s",
            tenant_name, t_list[:3]
        )
        raise HTTPException(
            status_code=404,
            detail=f"Tenant '{tenant_name}' UUID not found in PAM (got {len(t_list)} tenants)"
        )

    # App UUID
    a_resp = httpx.get(
        f"{base}/pam/tenant/{tenant_name}/app/list",
        params={"offset": 0, "limit": 200, "inst": "true"},
        headers=hdrs,
        timeout=15,
    )
    a_data = a_resp.json()
    logger.info("PAM app list raw keys: %s (status %s)", list(a_data.keys()) if isinstance(a_data, dict) else type(a_data).__name__, a_resp.status_code)

    if isinstance(a_data, list):
        a_list = a_data
    else:
        a_list = (a_data.get("data") or a_data.get("apps") or a_data.get("results")
                  or a_data.get("content") or a_data.get("list") or [])

    app_name_lower = app_name.lower()
    app_uuid: str | None = None
    _ENV_PRIO = {"prod": 0, "production": 0, "uat": 1, "develop": 2, "dev": 2, "staging": 3}
    for a in a_list:
        if not isinstance(a, dict):
            continue
        matched = False
        for field in ("displayName", "name", "appName", "app_name", "title"):
            val = str(a.get(field) or "").lower()
            if val == app_name_lower:
                matched = True
                break
        if not matched:
            continue
        # Prefer prod instance UUID; fall back to uat → develop → top-level id
        insts = a.get("insts") or []
        if insts:
            insts_sorted = sorted(
                insts,
                key=lambda i: _ENV_PRIO.get(str(i.get("environment", "")).lower(), 99),
            )
            app_uuid = insts_sorted[0].get("id")
        if not app_uuid:
            app_uuid = a.get("id") or a.get("appId") or a.get("uuid")
        logger.info("Resolved app '%s' → uuid=%s (from %d insts)", app_name, app_uuid, len(insts))
        break

    if not app_uuid:
        logger.warning(
            "App '%s' not found in PAM app list for tenant '%s'. displayNames available: %s",
            app_name, tenant_name,
            [a.get("displayName") or a.get("name") for a in a_list[:10]]
        )
        raise HTTPException(
            status_code=404,
            detail=f"App '{app_name}' not found in tenant '{tenant_name}' (got {len(a_list)} apps)"
        )

    _uuid_cache[cache_key] = (tenant_uuid, app_uuid)
    return tenant_uuid, app_uuid


@router.get("/{integration_id}/workflow/instances")
def list_workflow_instances(
    integration_id: str,
    tenant_name: str,
    app_name: str,
    limit: int = 20,  # matches frontend EXEC_PAGE_SIZE
    offset: int = 0,
    status: str = "",
):
    db = get_db()
    doc = db[COLLECTION].find_one({"_id": ObjectId(integration_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Integration not found")

    try:
        token = _get_access_token(doc)
        tenant_uuid, app_uuid = _resolve_uuids(doc, token, tenant_name, app_name)
        base = str(doc["url"]).rstrip("/")

        params: dict = {"limit": limit, "offset": offset, "orderByCloseDate": "desc"}
        if status:
            params["status"] = status

        headers = {
            "Authorization": f"Bearer {token}",
            "x-jiffy-tenant-id": tenant_uuid,
            "x-jiffy-app-id": app_uuid,
            "x-jiffy-target-app-id": app_uuid,
        }
        resp = httpx.get(
            f"{base}/platform/workflow/v1/instances/list",
            params=params,
            headers=headers,
            timeout=30,
        )
        logger.info(
            "Jiffy instances API: status=%s body_len=%d body_preview=%s",
            resp.status_code, len(resp.content), resp.text[:200]
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Jiffy workflow API returned {resp.status_code}: {resp.text[:200]}")
        if not resp.content or not resp.text.strip():
            return {"results": [], "running": 0, "completed": 0, "failed": 0, "totalSize": 0}
        try:
            return resp.json()
        except Exception:
            raise HTTPException(status_code=502, detail=f"Jiffy returned non-JSON: {resp.text[:200]}")
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Request to Jiffy timed out")
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Could not reach Jiffy: {e}")


@router.get("/{integration_id}/workflow/instances/{execution_id}/runlog")
def get_workflow_runlog(
    integration_id: str,
    execution_id: str,
    tenant_name: str,
    app_name: str,
):
    db = get_db()
    doc = db[COLLECTION].find_one({"_id": ObjectId(integration_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Integration not found")

    try:
        token = _get_access_token(doc)
        tenant_uuid, app_uuid = _resolve_uuids(doc, token, tenant_name, app_name)
        base = str(doc["url"]).rstrip("/")

        headers = {
            "Authorization": f"Bearer {token}",
            "x-jiffy-tenant-id": tenant_uuid,
            "x-jiffy-app-id": app_uuid,
            "x-jiffy-target-app-id": app_uuid,
        }
        resp = httpx.get(
            f"{base}/platform/workflow/v1/instances/{execution_id}/runlog",
            headers=headers,
            timeout=30,
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Jiffy runlog API returned {resp.status_code}: {resp.text[:200]}")
        return resp.json()
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Request to Jiffy timed out")
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Could not reach Jiffy: {e}")


@router.get("/{integration_id}/debug/pam")
def debug_pam(integration_id: str, tenant_name: str = ""):
    """
    Debug: return raw PAM tenant list (and app list if tenant_name provided).
    Useful for diagnosing UUID resolution failures.
    """
    db = get_db()
    doc = db[COLLECTION].find_one({"_id": ObjectId(integration_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Integration not found")

    try:
        token = _get_access_token(doc)
        base = str(doc["url"]).rstrip("/")
        hdrs = {"Authorization": f"Bearer {token}", "Origin": "jiffy.ai"}

        t_resp = httpx.get(f"{base}/pam/tenant/list", params={"offset": 0, "limit": 200}, headers=hdrs, timeout=15)
        result: dict = {"tenant_list_status": t_resp.status_code, "tenant_list": t_resp.json()}

        if tenant_name:
            a_resp = httpx.get(
                f"{base}/pam/tenant/{tenant_name}/app/list",
                params={"offset": 0, "limit": 200, "inst": "true"},
                headers=hdrs,
                timeout=15,
            )
            result["app_list_status"] = a_resp.status_code
            result["app_list"] = a_resp.json()

        return result
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Request timed out")
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Could not reach Jiffy: {e}")


@router.get("/{integration_id}/tenants")
def list_tenants(integration_id: str, offset: int = 0, limit: int = 100):
    db = get_db()
    doc = db[COLLECTION].find_one({"_id": ObjectId(integration_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Integration not found")

    try:
        token = _get_access_token(doc)
        base = str(doc["url"]).rstrip("/")
        response = httpx.get(
            f"{base}/pam/tenant/list",
            params={"offset": offset, "limit": limit},
            headers={
                "Authorization": f"Bearer {token}",
                "Origin": "jiffy.ai",
            },
            timeout=30,
        )
        if response.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"Jiffy tenant list returned {response.status_code}",
            )
        return response.json()
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Request to Jiffy timed out")
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Could not reach Jiffy: {e}")
