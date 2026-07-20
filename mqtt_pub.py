"""Minimální MQTT publisher (QoS 0) čistě ze stdlib — bez paho.

Publikuje metriky/eventy pro Home Assistant přes MQTT (discovery + state).
Podporuje nešifrované TCP připojení; volitelně username/password.
Když je [mqtt] host prázdný, je vypnutý.
"""
import socket
import struct
import threading

_cfg = {"host": "", "port": 1883, "user": "", "password": "", "prefix": "sentinel"}
_enabled = False
_lock = threading.Lock()


def configure(host="", port=1883, user="", password="", prefix="sentinel"):
    global _enabled
    _cfg.update(host=host, port=int(port or 1883), user=user, password=password,
                prefix=prefix or "sentinel")
    _enabled = bool(host)


def _encode_len(n):
    out = b""
    while True:
        b = n % 128
        n //= 128
        if n > 0:
            b |= 0x80
        out += bytes([b])
        if n == 0:
            break
    return out


def _str(s):
    b = s.encode()
    return struct.pack(">H", len(b)) + b


def _connect_packet():
    # MQTT 3.1.1 CONNECT
    payload = _str("sentinel-alert")
    flags = 0x02  # clean session
    if _cfg["user"]:
        flags |= 0x80
        payload += _str(_cfg["user"])
        if _cfg["password"]:
            flags |= 0x40
            payload += _str(_cfg["password"])
    var = _str("MQTT") + bytes([0x04, flags]) + struct.pack(">H", 30)
    body = var + payload
    return bytes([0x10]) + _encode_len(len(body)) + body


def _publish_packet(topic, payload):
    # QoS 0 PUBLISH
    body = _str(topic) + payload.encode()
    return bytes([0x30]) + _encode_len(len(body)) + body


def publish(metrics: dict):
    """Pošle sadu metrik jako retained-less QoS0 zprávy. Fire-and-forget."""
    if not _enabled:
        return
    threading.Thread(target=_publish_sync, args=(metrics,), daemon=True).start()


def _publish_sync(metrics):
    try:
        with _lock:
            s = socket.create_connection((_cfg["host"], _cfg["port"]), timeout=8)
            try:
                s.sendall(_connect_packet())
                s.recv(4)  # CONNACK
                for key, val in metrics.items():
                    topic = f"{_cfg['prefix']}/{key}"
                    s.sendall(_publish_packet(topic, str(val)))
            finally:
                s.sendall(bytes([0xE0, 0x00]))  # DISCONNECT
                s.close()
    except Exception as e:
        print(f"mqtt_pub: publish failed: {e}")


def start(host="", port=1883, user="", password="", prefix="sentinel"):
    configure(host, port, user, password, prefix)
    if _enabled:
        print(f"mqtt_pub: enabled → {_cfg['host']}:{_cfg['port']} prefix={_cfg['prefix']}")
