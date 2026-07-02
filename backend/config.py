"""
Centralised config loader.

Reads YAML from the path in $BACKEND_CONFIG_PATH, falling back to
backend/config.yml beside this file. The k8s Pod mounts a Secret at
/etc/monitoring/config.yml and sets BACKEND_CONFIG_PATH accordingly;
local dev keeps using the repo-local config.yml.

Cached so every request doesn't re-read the file.
"""
import os
from functools import lru_cache
from pathlib import Path

import yaml


@lru_cache(maxsize=1)
def get_config() -> dict:
    override = os.environ.get("BACKEND_CONFIG_PATH")
    path = Path(override) if override else (Path(__file__).parent / "config.yml")
    with open(path) as f:
        return yaml.safe_load(f) or {}
