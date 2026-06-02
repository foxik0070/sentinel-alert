"""MikroTik integration — reads firewall address-lists via SSH, supports block/unblock.

Polls every 30 s. Exposes data_store for the API.
Block adds to 'blocked_ips' list (drop rule already present on the router).
"""
import re
import subprocess
import threading
import time

_server = ""
_ssh_user = "sentinel-user"
_ssh_key = ""

data_store = {
    "connected": False,
    "last_error": "",
    "server": "",
    "lists": [],           # [{list, address, creation_time, timeout, dynamic, comment}]
    "summary": {},         # {list_name: count}
    "filter_rules": [],    # [{index, disabled, dynamic, comment, chain, action, ...}]
    "nat_rules": [],       # [{index, disabled, dynamic, comment, chain, action, ...}]
}

_lock = threading.Lock()
_DETAIL_RE = re.compile(
    r"list=(?P<list>\S+).*?address=(?P<address>\S+).*?"
    r"creation-time=(?P<ct>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})",
    re.DOTALL,
)
_TIMEOUT_RE  = re.compile(r"timeout=(?P<t>\S+)")
_COMMENT_RE  = re.compile(r"comment=(?P<c>.+?)(?=\s+\w+=|\s*$)")
_DYNAMIC_RE  = re.compile(r"dynamic=(?P<d>yes|no)")


def _run(cmd: str, timeout: int = 10) -> tuple[bool, str]:
    """Run a command on MikroTik via SSH. Returns (ok, output)."""
    full = [
        "ssh", "-i", _ssh_key,
        "-o", "BatchMode=yes",
        "-o", f"ConnectTimeout={timeout}",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        f"{_ssh_user}@{_server}",
        cmd,
    ]
    try:
        r = subprocess.run(full, capture_output=True, text=True, timeout=timeout + 5)
        if r.returncode != 0:
            return False, (r.stderr.strip() or f"exit {r.returncode}")[:200]
        return True, r.stdout
    except Exception as e:
        return False, str(e)[:200]


def _parse_detail(output: str) -> list[dict]:
    """Parse '/ip firewall address-list print detail' output into list of dicts."""
    entries = []
    # Split on entry boundaries — each entry starts with optional flags + number
    blocks = re.split(r'\n(?=\s*\d+ |\s*[DX] )', output)
    for block in blocks:
        block = block.strip()
        if not block or "list=" not in block:
            continue
        # Flatten continuation lines
        flat = " ".join(line.strip() for line in block.splitlines())
        m = _DETAIL_RE.search(flat)
        if not m:
            continue
        tm = _TIMEOUT_RE.search(flat)
        dm = _DYNAMIC_RE.search(flat)
        cm = _COMMENT_RE.search(flat)
        entries.append({
            "list":          m.group("list"),
            "address":       m.group("address"),
            "creation_time": m.group("ct"),
            "timeout":       tm.group("t") if tm else "",
            "dynamic":       (dm.group("d") == "yes") if dm else False,
            "comment":       cm.group("c").strip() if cm else "",
        })
    return entries


_RULE_KV = re.compile(r'(\S+)=("(?:[^"]*)"|[^\s]+)')
_RULE_INDEX = re.compile(r'^\s*(\d+)\s*([XI D]*)')
_RULE_COMMENT = re.compile(r';;;\s*(.*)')


def _parse_rules(output: str) -> list[dict]:
    """Parse '/ip firewall filter|nat print detail' output."""
    rules = []
    blocks = re.split(r'\n(?=\s*\d+\s)', output)
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        lines = block.splitlines()
        first = lines[0]
        im = _RULE_INDEX.match(first)
        if not im:
            continue
        idx = int(im.group(1))
        flags = im.group(2).upper()
        disabled = 'X' in flags
        dynamic  = 'D' in flags

        comment = ""
        kv_lines = []
        for line in lines:
            cm = _RULE_COMMENT.search(line)
            if cm:
                comment = cm.group(1).strip()
            else:
                kv_lines.append(line)

        flat = " ".join(kv_lines)
        rule = {"index": idx, "disabled": disabled, "dynamic": dynamic, "comment": comment}
        for m in _RULE_KV.finditer(flat):
            key = m.group(1).replace("-", "_")
            val = m.group(2).strip('"')
            rule[key] = val
        rules.append(rule)
    return rules


def _poll_worker():
    while True:
        ok_al, out_al = _run("/ip firewall address-list print detail")
        ok_f,  out_f  = _run("/ip firewall filter print detail")
        ok_n,  out_n  = _run("/ip firewall nat print detail")
        with _lock:
            if ok_al:
                entries = _parse_detail(out_al)
                summary: dict = {}
                for e in entries:
                    summary[e["list"]] = summary.get(e["list"], 0) + 1
                data_store["lists"] = entries
                data_store["summary"] = summary
                data_store["connected"] = True
                data_store["last_error"] = ""
            if ok_f:
                data_store["filter_rules"] = _parse_rules(out_f)
            if ok_n:
                data_store["nat_rules"] = _parse_rules(out_n)
            if not ok_al:
                data_store["connected"] = False
                data_store["last_error"] = out_al
        time.sleep(30)


def block_ip(ip: str, comment: str = "sentinel", timeout: str = "1w") -> tuple[bool, str]:
    """Add IP to MikroTik blocked_ips list."""
    cmd = f'/ip firewall address-list add list=blocked_ips address="{ip}" comment="{comment}" timeout={timeout}'
    ok, out = _run(cmd)
    if ok:
        # Trigger immediate refresh
        threading.Thread(target=_refresh_once, daemon=True).start()
    return ok, out


def unblock_ip(ip: str) -> tuple[bool, str]:
    """Remove IP from blocked_ips list (all matching entries)."""
    ok, out = _run(f'/ip firewall address-list remove [find list=blocked_ips address="{ip}"]')
    if ok:
        threading.Thread(target=_refresh_once, daemon=True).start()
    return ok, out


def _refresh_once():
    time.sleep(1)
    ok_al, out_al = _run("/ip firewall address-list print detail")
    ok_f,  out_f  = _run("/ip firewall filter print detail")
    ok_n,  out_n  = _run("/ip firewall nat print detail")
    with _lock:
        if ok_al:
            entries = _parse_detail(out_al)
            summary: dict = {}
            for e in entries:
                summary[e["list"]] = summary.get(e["list"], 0) + 1
            data_store["lists"] = entries
            data_store["summary"] = summary
            data_store["connected"] = True
            data_store["last_error"] = ""
        if ok_f:
            data_store["filter_rules"] = _parse_rules(out_f)
        if ok_n:
            data_store["nat_rules"] = _parse_rules(out_n)


def toggle_rule(rule_type: str, index: int, enable: bool) -> tuple[bool, str]:
    """Enable or disable a firewall filter or NAT rule by index."""
    if rule_type not in ("filter", "nat"):
        return False, "invalid rule_type"
    action = "enable" if enable else "disable"
    cmd = f"/ip firewall {rule_type} {action} {index}"
    ok, out = _run(cmd)
    if ok:
        threading.Thread(target=_refresh_once, daemon=True).start()
    return ok, out


def start(host: str, ssh_user: str, ssh_key: str):
    global _server, _ssh_user, _ssh_key
    _server = host
    _ssh_user = ssh_user
    _ssh_key = ssh_key
    data_store["server"] = host

    if not _server:
        data_store["last_error"] = "No MikroTik host configured — set mikrotik.host in sentinel-alert.conf"
        return

    threading.Thread(target=_poll_worker, daemon=True).start()
    print(f"mikrotik: monitoring {_server}")
