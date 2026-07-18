"""Externí IP intelligence lookupy — AbuseIPDB, VirusTotal, Shodan, GreyNoise.

Každý běží jen když je nakonfigurovaný API klíč (jinak vrací {configured: False}).
Volané synchronně z threadpoolu; nikdy nevyhazují.
"""
import json
import urllib.request
import urllib.parse

import conf


def _get(url: str, headers: dict, timeout: int = 10):
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"error": str(e)[:100]}


def abuseipdb(ip: str) -> dict:
    if not conf.ABUSEIPDB_KEY:
        return {"configured": False}
    d = _get(f"https://api.abuseipdb.com/api/v2/check?ipAddress={urllib.parse.quote(ip)}&maxAgeInDays=90",
             {"Key": conf.ABUSEIPDB_KEY, "Accept": "application/json"})
    data = d.get("data", {})
    return {"configured": True, "score": data.get("abuseConfidenceScore"),
            "reports": data.get("totalReports"), "usage": data.get("usageType"),
            "tor": data.get("isTor"), "error": d.get("error")}


def virustotal(ip: str) -> dict:
    if not conf.VIRUSTOTAL_KEY:
        return {"configured": False}
    d = _get(f"https://www.virustotal.com/api/v3/ip_addresses/{urllib.parse.quote(ip)}",
             {"x-apikey": conf.VIRUSTOTAL_KEY})
    stats = d.get("data", {}).get("attributes", {}).get("last_analysis_stats", {})
    return {"configured": True, "malicious": stats.get("malicious"),
            "suspicious": stats.get("suspicious"), "harmless": stats.get("harmless"),
            "error": d.get("error")}


def shodan(ip: str) -> dict:
    if not conf.SHODAN_KEY:
        return {"configured": False}
    d = _get(f"https://api.shodan.io/shodan/host/{urllib.parse.quote(ip)}?key={conf.SHODAN_KEY}", {})
    return {"configured": True, "ports": d.get("ports"), "os": d.get("os"),
            "org": d.get("org"), "tags": d.get("tags"), "error": d.get("error")}


def greynoise(ip: str) -> dict:
    if not conf.GREYNOISE_KEY:
        return {"configured": False}
    d = _get(f"https://api.greynoise.io/v3/community/{urllib.parse.quote(ip)}",
             {"key": conf.GREYNOISE_KEY, "Accept": "application/json"})
    return {"configured": True, "classification": d.get("classification"),
            "name": d.get("name"), "noise": d.get("noise"), "riot": d.get("riot"),
            "error": d.get("error")}


def enrich_all(ip: str) -> dict:
    """Spustí všechny nakonfigurované lookupy."""
    return {
        "abuseipdb": abuseipdb(ip),
        "virustotal": virustotal(ip),
        "shodan": shodan(ip),
        "greynoise": greynoise(ip),
    }
