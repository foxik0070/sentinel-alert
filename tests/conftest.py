"""
Shared pytest configuration.

Marks all async tests to use asyncio automatically.
Suppresses FastAPI lifespan background tasks during testing
(scanner, collector, heartbeat loop, service bg loop, etc.)
"""
import asyncio
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

import pytest


# Make pytest-asyncio work without per-test decoration
def pytest_collection_modifyitems(items):
    for item in items:
        if asyncio.iscoroutinefunction(getattr(item, "function", None)):
            item.add_marker(pytest.mark.asyncio)


# Suppress all background tasks so tests start/stop instantly
@pytest.fixture(autouse=True)
def suppress_lifespan(monkeypatch):
    """Replace FastAPI lifespan with a no-op so no background tasks run."""
    import app as _app

    @asynccontextmanager
    async def _noop_lifespan(application):
        yield

    monkeypatch.setattr(_app, "lifespan", _noop_lifespan)
    _app.app.router.lifespan_context = _noop_lifespan
