import json
import os
import subprocess
import threading
import time
import urllib.request

import conf as _conf

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_HOSTS_STATE_FILE = os.path.join(BASE_DIR, "data", "fsc_hosts.json")
_SSH_KEY = os.path.join(BASE_DIR, "conf", "id_ed25519")

HA_URL = os.environ.get("FSC_HA_URL") or _conf.FSC_HA_URL or ""
HA_TOKEN = os.environ.get("FSC_HA_TOKEN") or _conf.FSC_HA_TOKEN or ""

_DEFAULT_IGNORE = [
    "192.168.2.1",
    "192.168.2.120", "192.168.2.121", "192.168.2.122",
    "192.168.2.123", "192.168.2.124", "192.168.2.125",
    "192.168.2.202",
]
IGNORE_IPS = _conf.FSC_IGNORE_IPS if _conf.FSC_IGNORE_IPS else _DEFAULT_IGNORE


# ── Host enable/disable ────────────────────────────────────────────────────

def _load_disabled() -> set:
    try:
        with open(_HOSTS_STATE_FILE) as f:
            return set(json.load(f).get("disabled", []))
    except Exception:
        return set()


def _save_disabled(disabled: set):
    os.makedirs(os.path.dirname(_HOSTS_STATE_FILE), exist_ok=True)
    with open(_HOSTS_STATE_FILE, "w") as f:
        json.dump({"disabled": sorted(disabled)}, f)


def _parse_all_hosts() -> list[dict]:
    """Parse /etc/hosts, skip loopback/IPv6 and IGNORE_IPS."""
    hosts = []
    hosts_file = os.environ.get("SENTINEL_HOSTS_FILE") or _conf.COLLECTOR_HOSTS_FILE
    try:
        with open(hosts_file) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split()
                if len(parts) < 2:
                    continue
                ip, name = parts[0], parts[1]
                if (ip.startswith("127.") or ip.startswith("::") or
                        ip == "255.255.255.255" or ip in IGNORE_IPS):
                    continue
                hosts.append({"ip": ip, "name": name})
    except Exception:
        pass
    return hosts


def get_all_hosts_with_status() -> list[dict]:
    """Return all scannable hosts with their enabled/disabled status."""
    disabled = _load_disabled()
    return [
        {**h, "enabled": h["ip"] not in disabled}
        for h in _parse_all_hosts()
    ]


def toggle_host(ip: str) -> bool:
    """Toggle enabled/disabled for a host IP. Returns new enabled state."""
    disabled = _load_disabled()
    if ip in disabled:
        disabled.discard(ip)
    else:
        disabled.add(ip)
    _save_disabled(disabled)
    return ip not in disabled

data_store = {
    "inventory": {},
    "stats": {
        "total": 0, "online": 0, "offline": 0,
        "sec_alerts": 0, "firewalls_active": 0, "vms": 0, "lxcs": 0, "exposed_roots": 0
    },
    "system": {
        "scan_in_progress": False,
        "last_scan_time": "Not yet scanned",
        "next_scan_time": "Tomorrow at 02:00"
    }
}

SSH_PAYLOAD = r"""
export PATH=$PATH:/bin:/usr/bin:/sbin:/usr/sbin:/usr/local/bin
export DEBIAN_FRONTEND=noninteractive

OS=$(cat /etc/os-release 2>/dev/null | grep '^PRETTY_NAME' | cut -d '=' -f 2 | tr -d '"' || cat /etc/issue 2>/dev/null | head -n 1 || echo "Unknown OS")
KERNEL=$(uname -r 2>/dev/null || echo "Unknown")
UPTIME=$(awk '{print int($1/86400)"d "int(($1%86400)/3600)"h"}' /proc/uptime 2>/dev/null || echo "0d 0h")
LOAD=$(cat /proc/loadavg 2>/dev/null | awk '{print $1}' || echo "0.0")

MEM=$(free -m 2>/dev/null | awk '/Mem:/ {printf "%.0f", $3/$2 * 100}' || echo "0")
MEM=$(echo "$MEM" | grep -o '[0-9]*' | head -n1); [ -z "$MEM" ] && MEM=0

DISK=$(df -h / 2>/dev/null | awk 'NR==2 {print $5}' | sed 's/%//' || echo "0")
DISK=$(echo "$DISK" | grep -o '[0-9]*' | head -n1); [ -z "$DISK" ] && DISK=0

EOL_STATUS="supported"
if [ -f /etc/os-release ]; then
    . /etc/os-release
    if [ "$ID" = "ubuntu" ]; then
        YEAR=$(echo $VERSION_ID | cut -d. -f1)
        if [ -n "$YEAR" ] && [ "$YEAR" -le 20 ]; then EOL_STATUS="EOL_DANGER"; fi
    elif [ "$ID" = "debian" ]; then
        if [ -n "$VERSION_ID" ] && [ "$VERSION_ID" -le 11 ]; then EOL_STATUS="EOL_DANGER"; fi
    fi
fi
if grep -q "archive.ubuntu.com/ubuntu/ *[a-z]* *main *restricted" /etc/apt/sources.list 2>/dev/null || grep -q "archive.debian.org" /etc/apt/sources.list 2>/dev/null; then
    EOL_STATUS="EOL_ARCHIVE"
fi

if [ -f /var/run/reboot-required ]; then REBOOT="yes"; else REBOOT="no"; fi

if command -v apt >/dev/null 2>&1; then
    APT_OUT=$(apt list --upgradable 2>/dev/null | grep -v 'Listing...')
    UPDATES=$(echo "$APT_OUT" | grep -c "\[upgradable" || echo 0)
    SEC_UPDATES=$(echo "$APT_OUT" | grep -ci "security" || echo 0)
    SEC_PKGS=$(echo "$APT_OUT" | grep -i "security" | cut -d/ -f1 | tr '\n' ',' | sed 's/,$//')
else
    UPDATES=0; SEC_UPDATES=0; SEC_PKGS=""
fi

if command -v ss >/dev/null 2>&1; then
    PORTS_LIST=$(ss -H -tunlp 2>/dev/null | awk '{
        split($5, a, ":"); port=a[length(a)];
        split($0, b, "\""); svc=b[2];
        if(svc=="") svc="unknown";
        if(port != "") print port ":" svc;
    }' | sort -u | tr '\n' ',' | sed 's/,$//')
else
    PORTS_LIST=$(netstat -tunlp 2>/dev/null | awk '/LISTEN/ {
        n=split($4, a, ":"); port=a[n];
        m=split($7, b, "/"); svc=b[2];
        if(svc=="") svc="unknown";
        if(port != "") print port ":" svc;
    }' | sort -u | tr '\n' ',' | sed 's/,$//')
fi

VMS=$(command -v qm >/dev/null && qm list 2>/dev/null | grep -v VMID | grep -c running || echo 0)
LXCS=$(command -v pct >/dev/null && pct list 2>/dev/null | grep -v VMID | grep -c running || echo 0)

if pgrep -f fail2ban-server >/dev/null 2>&1; then F2B="active"; else F2B="inactive"; fi
F2B_JAILS=$(command -v fail2ban-client >/dev/null && fail2ban-client status 2>/dev/null | grep "Jail list" | cut -d: -f2 || echo "none")

MAC="none"
if command -v aa-status >/dev/null 2>&1 && aa-status 2>/dev/null | grep -qi "loaded"; then MAC="apparmor"
elif command -v sestatus >/dev/null 2>&1 && sestatus 2>/dev/null | grep -qi "enabled"; then MAC="selinux"
fi

FW="inactive"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi "active"; then FW="ufw"
elif command -v nft >/dev/null 2>&1 && nft list ruleset 2>/dev/null | grep -q "table"; then FW="nftables"
elif command -v iptables >/dev/null 2>&1 && iptables -S 2>/dev/null | grep -q "\-A"; then FW="iptables"
fi

ROOTSSH=$(sshd -T 2>/dev/null | awk '$1 ~ /permitrootlogin/ {print $2}' | head -n1 || echo unknown)
NOPASS=$(awk -F: '($2 == "") {print $1}' /etc/shadow 2>/dev/null | wc -l || echo 0)

UPDATES=$(echo "$UPDATES" | grep -o '[0-9]*' | head -n1); [ -z "$UPDATES" ] && UPDATES=0
SEC_UPDATES=$(echo "$SEC_UPDATES" | grep -o '[0-9]*' | head -n1); [ -z "$SEC_UPDATES" ] && SEC_UPDATES=0
VMS=$(echo "$VMS" | grep -o '[0-9]*' | head -n1); [ -z "$VMS" ] && VMS=0
LXCS=$(echo "$LXCS" | grep -o '[0-9]*' | head -n1); [ -z "$LXCS" ] && LXCS=0
NOPASS=$(echo "$NOPASS" | grep -o '[0-9]*' | head -n1); [ -z "$NOPASS" ] && NOPASS=0

OS=$(echo "$OS" | tr -d '\r\n\t"\\')
KERNEL=$(echo "$KERNEL" | tr -d '\r\n\t"\\')
UPTIME=$(echo "$UPTIME" | tr -d '\r\n\t"\\')
LOAD=$(echo "$LOAD" | tr -d '\r\n\t"\\')
SEC_PKGS=$(echo "$SEC_PKGS" | tr -d '\r\n\t"\\')
PORTS_LIST=$(echo "$PORTS_LIST" | tr -d '\r\n\t"\\')
F2B=$(echo "$F2B" | tr -d '\r\n\t"\\')
F2B_JAILS=$(echo "$F2B_JAILS" | tr -d ' \r\n\t"\\')
MAC=$(echo "$MAC" | tr -d '\r\n\t"\\')
FW=$(echo "$FW" | tr -d '\r\n\t"\\')
ROOTSSH=$(echo "$ROOTSSH" | tr -d '\r\n\t"\\')
EOL_STATUS=$(echo "$EOL_STATUS" | tr -d '\r\n\t"\\')
REBOOT=$(echo "$REBOOT" | tr -d '\r\n\t"\\')

cat <<JSON
{
  "os": "${OS}",
  "kernel": "${KERNEL}",
  "uptime": "${UPTIME}",
  "load": "${LOAD}",
  "mem": ${MEM},
  "disk": ${DISK},
  "updates": ${UPDATES},
  "sec_updates": ${SEC_UPDATES},
  "sec_packages": "${SEC_PKGS}",
  "ports_list": "${PORTS_LIST}",
  "vms": ${VMS},
  "lxcs": ${LXCS},
  "fail2ban": "${F2B}",
  "f2b_jails": "${F2B_JAILS}",
  "mac": "${MAC}",
  "firewall": "${FW}",
  "root_ssh": "${ROOTSSH}",
  "nopass_users": ${NOPASS},
  "eol_status": "${EOL_STATUS}",
  "reboot_req": "${REBOOT}"
}
JSON
"""


def send_ha_alert(message):
    if not HA_URL or not HA_TOKEN:
        return
    headers = {"Authorization": f"Bearer {HA_TOKEN}", "Content-Type": "application/json"}
    url = HA_URL.rstrip('/')
    if not url.endswith("/api/services/notify/mobile_app_lukas_mobil"):
        url += "/api/services/notify/mobile_app_lukas_mobil"
    payload = {"message": message, "title": "Foxik Security Center Alert"}
    try:
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode('utf-8'), headers=headers, method='POST'
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.getcode() == 200
    except Exception as e:
        print(f"FSC: HA notification failed: {e}")
        return False


def get_hosts():
    """Return hosts enabled for scanning (respects disabled list + IGNORE_IPS)."""
    disabled = _load_disabled()
    return [h for h in _parse_all_hosts() if h["ip"] not in disabled]


def check_host_security(ip, name):
    status = {
        "name": name, "ip": ip, "online": False,
        "os": "N/A", "kernel": "N/A", "uptime": "0d 0h", "load": "0.0", "mem": 0, "disk": 0,
        "updates": 0, "sec_updates": 0, "sec_packages": "",
        "cve_crit": 0, "cve_high": 0, "cve_med": 0,
        "ports_list": "", "vms": 0, "lxcs": 0,
        "fail2ban": "offline", "f2b_jails": "none", "mac": "unknown", "firewall": "unknown",
        "root_ssh": "unknown", "nopass_users": 0, "eol_status": "unknown", "reboot_req": "no",
        "last_check": time.strftime("%H:%M:%S")
    }
    res = subprocess.call(
        ["ping", "-c", "1", "-W", "1", ip],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    if res != 0:
        return status
    status["online"] = True
    cmd = [
        "ssh", "-q",
        "-i", _SSH_KEY,
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=8",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        f"root@{ip}", "bash", "-s"
    ]
    try:
        process = subprocess.run(cmd, input=SSH_PAYLOAD.encode('utf-8'), capture_output=True, timeout=65)
        out = process.stdout.decode('utf-8')
        err = process.stderr.decode('utf-8').strip()
        json_start = out.find('{')
        json_end = out.rfind('}') + 1
        if process.returncode != 0:
            status["os"] = f"ERR: {err[:50]}" if err else "ERR: SSH failed"
        elif json_start != -1 and json_end != -1:
            data = json.loads(out[json_start:json_end], strict=False)
            crit_keys = ['linux', 'kernel', 'ssh', 'ssl', 'sudo', 'bash', 'systemd', 'libc', 'crypt', 'pve']
            high_keys = ['apache', 'nginx', 'php', 'python', 'curl', 'wget', 'mysql', 'maria', 'postgre', 'docker', 'qemu', 'bind']
            c_crit = c_high = c_med = 0
            if data.get("sec_packages"):
                for pkg in data["sec_packages"].split(','):
                    p = pkg.lower()
                    if any(k in p for k in crit_keys):
                        c_crit += 1
                    elif any(k in p for k in high_keys):
                        c_high += 1
                    else:
                        c_med += 1
            data["cve_crit"] = c_crit
            data["cve_high"] = c_high
            data["cve_med"] = c_med
            status.update(data)
        else:
            status["os"] = f"ERR_PARSE: {err[:30]}" if err else "ERR: Bad data format"
    except subprocess.TimeoutExpired:
        status["os"] = "ERR_TIMEOUT: >65s"
    except Exception as e:
        status["os"] = f"ERR_SYS: {str(e)[:40]}"
    return status


_scan_lock = threading.Lock()


def update_global_stats(hosts_count):
    curr = {
        "total": hosts_count, "online": 0, "offline": 0,
        "sec_alerts": 0, "firewalls_active": 0, "vms": 0, "lxcs": 0, "exposed_roots": 0
    }
    for inv in data_store["inventory"].values():
        if inv["online"]:
            curr["online"] += 1
            curr["sec_alerts"] += inv.get("sec_updates", 0)
            curr["vms"] += inv.get("vms", 0)
            curr["lxcs"] += inv.get("lxcs", 0)
            if inv.get("firewall", "inactive") != "inactive":
                curr["firewalls_active"] += 1
            if inv.get("nopass_users", 0) > 0:
                curr["sec_alerts"] += 1
            if str(inv.get("root_ssh", "")).lower() == "yes":
                curr["exposed_roots"] += 1
            eol = inv.get("eol_status", "unknown")
            if eol not in ("supported", "unknown"):
                curr["sec_alerts"] += 1
        else:
            curr["offline"] += 1
    data_store["stats"] = curr


def run_full_scan():
    if data_store["system"]["scan_in_progress"]:
        return
    data_store["system"]["scan_in_progress"] = True
    data_store["system"]["next_scan_time"] = "Scanning..."
    hosts = get_hosts()
    hosts_count = len(hosts)
    for i, h in enumerate(hosts):
        data_store["system"]["last_scan_time"] = f"Scanning: {h['name']} ({i+1}/{hosts_count})"
        result = check_host_security(h["ip"], h["name"])
        with _scan_lock:
            data_store["inventory"][h["ip"]] = result
            update_global_stats(hosts_count)
        eol = result.get("eol_status", "supported")
        crit = result.get("cve_crit", 0)
        high = result.get("cve_high", 0)
        if (eol not in ("supported", "unknown")) or crit > 0 or high > 0:
            parts = []
            if eol not in ("supported", "unknown"):
                parts.append("SYSTEM EOL - NO SECURITY PATCHES!")
            if crit > 0 or high > 0:
                parts.append(f"Critical CVE: {crit}, High CVE: {high}, Packages: {result.get('sec_packages', '?')}")
            send_ha_alert(
                f"Server: {h['name']} ({h['ip']})\n"
                f"Status: Critical vulnerabilities or EOL detected!\n\n"
                f"{chr(10).join(parts)}\n\nAct immediately."
            )
    data_store["system"]["last_scan_time"] = time.strftime("%d.%m.%Y %H:%M:%S")
    now = time.localtime()
    data_store["system"]["next_scan_time"] = "Today at 02:00" if now.tm_hour < 2 else "Tomorrow at 02:00"
    data_store["system"]["scan_in_progress"] = False


def _worker():
    run_full_scan()
    while True:
        now = time.localtime()
        if now.tm_hour == 2 and now.tm_min == 0:
            run_full_scan()
            time.sleep(60)
        time.sleep(30)


def start():
    threading.Thread(target=_worker, daemon=True).start()
