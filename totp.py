"""TOTP (RFC 6238) čistě ze stdlib — bez externích závislostí.

Kompatibilní s Google Authenticator / Aegis (SHA1, 6 číslic, 30s krok).
"""
import base64
import hashlib
import hmac
import os
import struct
import time


def generate_secret() -> str:
    """Náhodný base32 secret (bez paddingu), 160 bitů."""
    return base64.b32encode(os.urandom(20)).decode().rstrip("=")


def _hotp(secret_b32: str, counter: int, digits: int = 6) -> str:
    # base32 dekódování vyžaduje padding na násobek 8
    pad = "=" * (-len(secret_b32) % 8)
    key = base64.b32decode(secret_b32.upper() + pad)
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(code % (10 ** digits)).zfill(digits)


def verify(secret_b32: str, code: str, window: int = 1) -> bool:
    """Ověří kód s tolerancí ±window kroků (proti drift hodin)."""
    if not secret_b32 or not code:
        return False
    code = code.strip().replace(" ", "")
    if not code.isdigit():
        return False
    counter = int(time.time()) // 30
    for w in range(-window, window + 1):
        try:
            if hmac.compare_digest(_hotp(secret_b32, counter + w), code):
                return True
        except Exception:
            return False
    return False


def provisioning_uri(secret_b32: str, account: str, issuer: str = "Sentinel-Alert") -> str:
    """otpauth:// URI pro QR / ruční zadání do authenticatoru."""
    from urllib.parse import quote
    label = quote(f"{issuer}:{account}")
    return (f"otpauth://totp/{label}?secret={secret_b32}"
            f"&issuer={quote(issuer)}&algorithm=SHA1&digits=6&period=30")
