# Sentinel-Alert Project Documentation

Sentinel-Alert is a dual-purpose network monitoring and honeypot visualization tool. It integrates LAN scanning (Pi.Alert style) with honeypot threat detection (Knock-Knock style). It runs on Ubuntu/Debian/RHEL. I want a modern look, interactive, attacker visualization on a globe with animations, labels, destination countries, etc.

## Basic Architecture
- **Backend:** Python / FastAPI
- **Database:** SQLite
- **Frontend:** HTML5, CSS3, Vanilla JS + D3.js/Leaflet
- **Communication:** WebSockets for live data streaming
- **Port:** 5056

## Modules
1. **Scanner/Collector:** ARP scanning, host inventory, service availability.
2. **Honeypot:** Captures SSH/HTTP/etc. attacks, GeoIP enrichment.
3. **API and WS:** FastAPI server, real-time event streaming.
4. **Sentinel Bridge:** Internal API/client for reporting to the main 'Sentinel' infrastructure.

## Plan
- [ ] Phase 1: Data and DB (Unified Schema)
- [ ] Phase 2: Scanning Engine
- [ ] Phase 3: Real-time Backend (WebSockets)
- [ ] Phase 4: Frontend Visualization
- [ ] Phase 5: Local Network Visualization with IP, Hostname, Port information

---

## Guidelines for Behavior (Strict)

### 1. Think before you code
- Don't assume. If you're not sure, stop and ask.
- Explicitly emphasize trade-offs.
- If there are multiple interpretations, present them - don't silently choose.

### 2. Simplicity First
- Minimal code that solves the problem. No speculative functions.
- No abstractions for disposable code.
- "Would the lead engineer say this is too complicated?" If so, rewrite.

### 3. Surgical Changes
- Touch only what is necessary.
- Do not improve or refactor existing code unless it is an explicit task.
- Adapt existing style.
- Every changed line must directly reference the requirement.

### 4. Goal-Oriented Execution
- Before coding, provide a plan:
1. [Step] → verify: [check]
2. [Step] → verify: [check]
- Before implementing, write tests/checks that reproduce the goal.

---

**These guidelines work if:** fewer unnecessary changes, fewer reworked solutions, and questions come *before* implementation.
