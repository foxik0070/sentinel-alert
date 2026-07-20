"""Streamování útoků do OpenSearch / Elasticsearch přes _bulk API.

Bez externích závislostí (urllib). Události se bufferují a flushují dávkově
na pozadí. Aktivní jen když je nakonfigurován [siem] url.
"""
import base64
import json
import queue
import threading
import urllib.request

_cfg = {"url": "", "index": "sentinel-attacks", "user": "", "password": ""}
_q: queue.Queue = queue.Queue(maxsize=10000)
_enabled = False


def configure(url="", index="sentinel-attacks", user="", password=""):
    global _enabled
    _cfg.update(url=url.rstrip("/"), index=index or "sentinel-attacks",
                user=user, password=password)
    _enabled = bool(url)


def push(event: dict):
    """Zařadí událost k odeslání (fire-and-forget, nikdy neblokuje)."""
    if not _enabled:
        return
    try:
        _q.put_nowait(event)
    except queue.Full:
        pass


def _headers():
    h = {"Content-Type": "application/x-ndjson"}
    if _cfg["user"]:
        tok = base64.b64encode(f"{_cfg['user']}:{_cfg['password']}".encode()).decode()
        h["Authorization"] = "Basic " + tok
    return h


def _flush(batch):
    # _bulk NDJSON: střídá action řádek a dokument
    lines = []
    for ev in batch:
        lines.append(json.dumps({"index": {"_index": _cfg["index"]}}))
        lines.append(json.dumps(ev, default=str))
    body = ("\n".join(lines) + "\n").encode()
    import ssl
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(_cfg["url"] + "/_bulk", data=body,
                                 headers=_headers(), method="POST")
    urllib.request.urlopen(req, timeout=15, context=ctx).close()


def _worker():
    import time
    while True:
        batch = []
        try:
            batch.append(_q.get(timeout=5))
            while len(batch) < 500:
                batch.append(_q.get_nowait())
        except queue.Empty:
            pass
        if not batch:
            continue
        try:
            _flush(batch)
        except Exception as e:
            print(f"siem_export: bulk flush failed: {e}")
            time.sleep(10)


def start(url="", index="sentinel-attacks", user="", password=""):
    configure(url, index, user, password)
    if not _enabled:
        return
    threading.Thread(target=_worker, daemon=True).start()
    print(f"siem_export: streaming to {_cfg['url']} index={_cfg['index']}")
