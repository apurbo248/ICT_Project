# main_app.py  — GN Roof (stable, DB outside OneDrive)

from __future__ import annotations
import os, sqlite3
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional
from flask import (
    Flask, request, jsonify, render_template, redirect, url_for, session
)
from werkzeug.security import generate_password_hash, check_password_hash

# -------------------- Database location (outside OneDrive) --------------------
DB_PATH = Path(r"C:\gnroof_data\gnroof.db")            # <— change only if you want
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

def con():
    """Open a resilient SQLite connection with sane pragmas."""
    c = sqlite3.connect(DB_PATH, timeout=60)
    c.execute("PRAGMA busy_timeout = 60000;")          # wait for file locks
    c.execute("PRAGMA journal_mode = WAL;")            # better concurrent reads
    c.execute("PRAGMA synchronous = NORMAL;")
    c.row_factory = sqlite3.Row
    return c

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def init_db():
    """Create tables if missing and seed default state row."""
    with con() as c:
        cur = c.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS readings(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                temp REAL, hum REAL
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS control_log(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                by_user TEXT NOT NULL,
                command TEXT NOT NULL
            )
        """)
    
        cur.execute("""
            CREATE TABLE IF NOT EXISTS rain_log(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                rain INTEGER NOT NULL
            )
        """)
        # seed one rain_log row if empty (so chart has a starting point)
        cur.execute("SELECT COUNT(*) FROM rain_log")
        if cur.fetchone()[0] == 0:
         cur.execute("INSERT INTO rain_log(ts, rain) VALUES (?, 0)", (now_iso(),))


        # seed single state row
        cur.execute("INSERT OR IGNORE INTO state(id,vent_state,rain,updated_at) "
                    "VALUES (1,'CLOSE',0,'init')")
    print(f"DB initialized ✓  -> {DB_PATH}")

# -------------------- Flask app --------------------
BASE_DIR = Path(__file__).resolve().parent
app = Flask(__name__, template_folder=str(BASE_DIR / "templates"),
            static_folder=str(BASE_DIR / "static"))
app.config.update(
    SECRET_KEY="dev-change-me",
    SESSION_COOKIE_NAME="gnroof_session",
    SESSION_COOKIE_HTTPONLY=True,
)

def current_user() -> Optional[str]:
    return session.get("username")

def require_login_json():
    if not current_user():
        return jsonify({"ok": False, "error": "Not logged in"}), 401

# -------------------- Pages --------------------
@app.get("/")
def home():
    return render_template("login.html")

@app.get("/dashboard")
def dashboard():
    if not current_user():
        return redirect(url_for("home"))
    return render_template("dashboard.html")

# -------------------- Auth APIs --------------------
@app.post("/register")
def register():
    d = request.get_json(silent=True) or {}
    u = (d.get("username") or "").strip()
    p = (d.get("password") or "").strip()
    if not u or not p:
        return jsonify({"ok": False, "error": "Username and password required"}), 400
    try:
        with con() as c:
            c.execute("INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)",
                      (u, generate_password_hash(p), now_iso()))
    except sqlite3.IntegrityError:
        return jsonify({"ok": False, "error": "Username already exists"}), 409
    return jsonify({"ok": True, "message": "Registered"}), 201

@app.post("/login")
def login():
    d = request.get_json(silent=True) or {}
    u = (d.get("username") or "").strip()
    p = (d.get("password") or "").strip()
    with con() as c:
        row = c.execute("SELECT password_hash FROM users WHERE username=?", (u,)).fetchone()
    if not row or not check_password_hash(row["password_hash"], p):
        return jsonify({"ok": False, "error": "Invalid credentials"}), 401
    session["username"] = u
    return jsonify({"ok": True, "user": u, "token": "ok"})

@app.post("/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})

# -------------------- Vent + sensor helpers --------------------
def set_vent(state: str, by_user: str):
    ts = now_iso()
    with con() as c:
        c.execute("UPDATE state SET vent_state=?, updated_at=? WHERE id=1", (state, ts))
        c.execute("INSERT INTO control_log(ts,by_user,command) VALUES(?,?,?)",
                  (ts, by_user, state))
    return ts

def auto_close_if_rain_or_hum(hum_val: float|None):
    with con() as c:
        s = c.execute("SELECT vent_state,rain FROM state WHERE id=1").fetchone()
    if not s: 
        return
    raining = bool(s["rain"])
    too_humid = (isinstance(hum_val, (int,float)) and hum_val >= 85.0)
    if (raining or too_humid) and s["vent_state"] != "CLOSE":
        set_vent("CLOSE", "SYSTEM")

# -------------------- JSON APIs (used by your dashboard) --------------------
@app.get("/status")
def status():
    with con() as c:
        last = c.execute("SELECT ts,temp,hum FROM readings ORDER BY id DESC LIMIT 1").fetchone()
        s = c.execute("SELECT vent_state,rain,updated_at FROM state WHERE id=1").fetchone()
    return jsonify({
        "temp": last["temp"] if last else None,
        "hum":  last["hum"]  if last else None,
        "ts":   last["ts"]   if last else None,
        "vent": s["vent_state"] if s else "CLOSE",
        "rain": bool(s["rain"]) if s else False,
        "vent_updated": s["updated_at"] if s else None,
        "user": current_user()
    })

@app.post("/sensor")
def sensor():
    if not current_user(): return require_login_json()
    d = request.get_json(silent=True) or {}
    temp = d.get("temp"); hum = d.get("hum")
    with con() as c:
        c.execute("INSERT INTO readings(ts,temp,hum) VALUES (?,?,?)", (now_iso(), temp, hum))
    auto_close_if_rain_or_hum(hum)
    return jsonify({"ok": True})

@app.post("/control-vent")
def control_vent():
    if not current_user(): return require_login_json()
    d = request.get_json(silent=True) or {}
    cmd = (d.get("command") or "").upper()
    if cmd not in {"OPEN", "CLOSE"}:
        return jsonify({"ok": False, "error": "Invalid command"}), 400
    ts = set_vent(cmd, current_user() or "user")
    return jsonify({"ok": True, "vent": cmd, "ts": ts})

@app.get("/control-log")
def control_log():
    limit = int(request.args.get("limit", 50))
    with con() as c:
        rows = c.execute(
            "SELECT ts,by_user,command FROM control_log ORDER BY id DESC LIMIT ?",
            (limit,)
        ).fetchall()
    return jsonify([{"ts": r["ts"], "by_user": r["by_user"], "command": r["command"]} for r in rows])

@app.get("/history")
def history():
    limit = int(request.args.get("limit", 50))
    with con() as c:
        rows = c.execute(
            "SELECT ts,temp,hum FROM readings ORDER BY id DESC LIMIT ?",
            (limit,)
        ).fetchall()
    rows = rows[::-1]  # oldest -> newest
    return jsonify([{"ts": r["ts"], "temp": r["temp"], "hum": r["hum"]} for r in rows])
@app.post("/rain")
def rain_toggle():
    if not current_user(): return require_login_json()
    d = request.get_json(silent=True) or {}
    is_rain = 1 if bool(d.get("on", False)) else 0
    ts = now_iso()
    with con() as c:
        c.execute("UPDATE state SET rain=?, updated_at=? WHERE id=1", (is_rain, ts))
        # NEW: log the change for charting
        c.execute("INSERT INTO rain_log(ts, rain) VALUES (?, ?)", (ts, is_rain))
    if is_rain:
        set_vent("CLOSE", "SYSTEM")
    return jsonify({"ok": True, "rain": bool(is_rain)})
@app.get("/rain-history")
def rain_history():
    limit = int(request.args.get("limit", 50))
    with con() as c:
        rows = c.execute(
            "SELECT ts, rain FROM rain_log ORDER BY id DESC LIMIT ?",
            (limit,)
        ).fetchall()
    rows = rows[::-1]  # oldest -> newest for nice charting
    return jsonify([{"ts": r["ts"], "rain": int(r["rain"])} for r in rows])


# Optional: quick route to see registered routes for debugging
@app.get("/debug/routes")
def debug_routes():
    return jsonify(sorted([str(r.rule) for r in app.url_map.iter_rules()]))

# -------------------- Boot --------------------

if __name__ == "__main__":
    print(f"Using DB: {DB_PATH}")   # should print C:\gnroof_data\gnroof.db


    init_db()
    app.run(host="127.0.0.1", port=5000, debug=True)
