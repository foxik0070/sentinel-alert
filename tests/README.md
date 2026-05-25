# Sentinel-Alert — Tests

## Spuštění

```bash
# z kořene projektu
python -m pytest tests/ -v

# jeden soubor
python -m pytest tests/test_services.py -v

# rychle bez výstupu
python -m pytest tests/ -q
```

## Závislosti

```bash
pip install pytest pytest-asyncio httpx
```

## Soubory

| Soubor | Co testuje |
|---|---|
| `test_services.py` | Service Monitor — backend, API, bridge |
| `conftest.py` | Sdílená konfigurace: asyncio mód, potlačení FastAPI lifespan |

---

## test_services.py — přehled testů

### 1. JSON persistence
| Test | Co ověřuje |
|---|---|
| `test_load_services_empty` | `_load_services()` vrací `[]` pokud soubor chybí |
| `test_save_and_load_services` | Uložení a zpětné načtení ze services.json |
| `test_migrate_domain` | Převod záznamu z domains.json na nový formát |
| `test_migration_from_domains_json` | Automatická migrace při prvním spuštění |

### 2. SQLite helpers
| Test | Co ověřuje |
|---|---|
| `test_svc_db_store_and_last` | Uložení výsledku + zpětné načtení přes `_svc_last()` |
| `test_svc_db_history_order` | Historie seřazena vzestupně (nejstarší první) |
| `test_svc_uptime_all_up` | 100% uptime při všech `up` záznamech |
| `test_svc_uptime_half` | 50% uptime při 5/10 `up` |
| `test_svc_uptime_no_data` | `None` pro neexistující service |
| `test_svc_last_no_data` | `None` pro neexistující service |

### 3. Check funkce
| Test | Co ověřuje |
|---|---|
| `test_check_http_success` | HTTP GET vrací `up=True` při HTTP 200 |
| `test_check_http_wrong_status` | `up=False` při neočekávaném status kódu |
| `test_check_http_text_not_found` | `up=False` pokud tělo neobsahuje očekávaný text |
| `test_check_ping_success` | Ping na 127.0.0.1 vrací `up=True` |
| `test_check_ping_failure` | Ping na nedosažitelnou IP vrací `up=False` |
| `test_check_tcp_success` | TCP connect na lokální port vrací `up=True` |
| `test_check_tcp_failure` | TCP connect na zavřený port vrací `up=False` |
| `test_check_dns_localhost` | DNS rozlišení `localhost` vrací `up=True` |
| `test_check_heartbeat_no_ping` | `up=False` pokud heartbeat ještě nepřišel |
| `test_check_heartbeat_recent_ping` | `up=True` pro čerstvý ping |
| `test_check_heartbeat_expired` | `up=False` pokud ping přišel příliš dávno |

### 4. API endpointy
| Test | Co ověřuje |
|---|---|
| `test_api_services_list_empty` | `GET /api/services` vrací `[]` |
| `test_api_services_add_http` | `POST /api/services` přidá HTTP service |
| `test_api_services_add_tcp` | `POST /api/services` přidá TCP service |
| `test_api_services_add_missing_target` | 400 při chybějícím URL pro HTTP |
| `test_api_services_add_missing_host` | 400 při chybějícím host pro TCP |
| `test_api_services_delete` | `DELETE /api/services/{id}` odstraní service |
| `test_api_services_delete_notfound` | 404 pro neexistující ID |
| `test_api_services_check_all` | `POST /api/services/check` zkontroluje všechny |
| `test_api_services_check_one` | `POST /api/services/{id}/check` zkontroluje jednu |
| `test_api_services_check_one_notfound` | 404 pro neexistující ID |
| `test_api_services_settings_get_default` | `GET /api/services/settings` vrací výchozí interval |
| `test_api_services_settings_set` | `POST /api/services/settings` uloží nový interval |
| `test_api_services_settings_clamp` | Interval se ořízne na max. 60 min |
| `test_api_heartbeat_ping` | `POST /api/heartbeat/{id}` zaznamená ping |
| `test_api_heartbeat_not_found` | 404 pro neexistující ID |
| `test_api_heartbeat_wrong_type` | 404 pro service jiného typu než heartbeat |

### 5. Bridge — překlad событий
| Test | Co ověřuje |
|---|---|
| `test_bridge_service_down_event` | DOWN event → `status=active` v bridge payload |
| `test_bridge_service_up_event` | UP event → `status=ok` v bridge payload |

### 6. State-change tracking
| Test | Co ověřuje |
|---|---|
| `test_store_check_result_first_run` | První výsledek — žádná bridge notifikace |
| `test_store_check_result_state_change` | up→down spustí bridge notifikaci |
| `test_store_check_result_no_change` | Stejný stav — žádná notifikace |

### 7. SSL verify + security check
| Test | Co ověřuje |
|---|---|
| `test_api_services_add_ssl_verify_false` | Service přidaná s `ssl_verify=False` si zachová pole |
| `test_migrate_domain_has_ssl_verify` | Migrované domény mají `ssl_verify=True` |
| `test_check_http_ssl_verify_false` | `ssl_verify=False` předá unverified SSL kontext do urlopen |
| `test_check_security_good_headers` | Všechny security headers přítomny → status=ok |
| `test_check_security_missing_headers` | Chybějící headers → fail/warn |
| `test_check_security_http_no_redirect` | HTTP bez HTTPS redirect → fail |
| `test_check_security_hsts_short_maxage` | HSTS max-age < 1 rok → warn |

### 8. Preview endpoint
| Test | Co ověřuje |
|---|---|
| `test_api_preview_http` | `POST /api/services/preview` vrací check + security, nic neukládá |
| `test_api_preview_ping_no_security` | Ping preview → security=[] |
| `test_api_preview_tcp_no_save` | TCP preview neukládá service |

---

## conftest.py

- **`suppress_lifespan`** — Nahradí FastAPI lifespan no-opem, aby se nespustily background tasky (scanner, service checker, heartbeat loop). Testy jsou tak izolované a rychlé.
- **`tmp_data_dir`** — Přesměruje všechny datové cesty (`_SVC_PATH`, `DB_PATH`, atd.) do dočasného adresáře. Každý test dostane čistý stav.
- **`pytest_collection_modifyitems`** — Async testy automaticky dostávají `@pytest.mark.asyncio`.
