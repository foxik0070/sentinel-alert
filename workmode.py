"""Work mode helpers.

WHO file format (CSV, # comment lines ignored):
    name, department, ip, note
Example:
    # Sentinel-Alert — Work Users
    John Doe, IT Security, 10.0.1.42, Admin
    Jane Smith, Engineering, 10.0.1.55,
"""
import os
import conf


def is_work() -> bool:
    return conf.MODE_TYPE.strip().lower() == "work"


def get_users() -> list[dict]:
    """Parse MODE_WHO_FILE and return list of user dicts."""
    path = conf.MODE_WHO_FILE
    if not path or not os.path.exists(path):
        return []
    users = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = [p.strip() for p in line.split(",")]
                users.append({
                    "name": parts[0] if len(parts) > 0 else "",
                    "dept": parts[1] if len(parts) > 1 else "",
                    "ip":   parts[2] if len(parts) > 2 else "",
                    "note": parts[3] if len(parts) > 3 else "",
                })
    except Exception as e:
        print(f"workmode: who file read error: {e}")
    return users
