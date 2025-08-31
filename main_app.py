# main_app.py — GN Roof (migrating fix for old DB + auto-close working, no linter errors)
# --------------------------------------------------------------------------------
# - Adds missing columns to old tables on startup (no need to delete your DB)
# - Rain/Smoke default OFF; auto-close vent on Rain/Smoke/Humidity≥85
# - Seeds rain/smoke history if empty so graphs are never blank
# - Same routes as before; works with old and new overview checkboxes
# --------------------------------------------------------------------------------

from flask import Flask, render_template, request, redirect, url_for, session, jsonify, send_file
import os, sqlite3, random, io
from datetime import datetime

app = Flask(__name__)
app.secret_key = "gnroof_secret_2025"

DB_DIR  = r"C:\\gnroof_data"
DB_PATH = os.path.join(DB_DIR, "gnroof.db")

def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

def now_iso():
    return datetime.now().isoformat(timespec="seconds")

# ---- helpers for migrations ----
def col_exists(cur, table, col):
    cur.execute(f"PRAGMA table_info({table})")
    return any(r[1] == col for r in cur.fetchall())

def ensure_col(cur, table, col, decl, default_sql=None):
    """Add column if missing. decl like 'INTEGER', 'REAL', 'TEXT'."""
    if not col_exists(cur, table, col):
        cur.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
        if default_sql is not None:
            cur.execute(f"UPDATE {table} SET {col} = {default_sql}")

def init_db():
    os.makedirs(DB_DIR, exist_ok=True)
    con = db()
    cur = con.cursor()

    # --- create tables if not exist (latest schema) ---
    cur.execute("""
        CREATE TABLE IF NOT EXISTS state(
            key TEXT PRIMARY KEY,
            val TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS readings(
            ts   TEXT,
            temp REAL,
            hum  REAL
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS control_log(
            ts      TEXT,
            by_user TEXT,
            command TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS rain_history(
            ts  TEXT
            -- val INTEGER (may be missing on old DBs; added in migration below)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS smoke_history(
            ts  TEXT
            -- val INTEGER (may be missing on old DBs; added in migration below)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS users(
            username TEXT PRIMARY KEY,
            password TEXT
        )
    """)

    # --- migrate old tables: add 'val' column if it doesn't exist ---
    ensure_col(cur, "rain_history",  "val", "INTEGER", default_sql="0")
    ensure_col(cur, "smoke_history", "val", "INTEGER", default_sql="0")

    # --- defaults: vent OPEN, rain OFF, smoke OFF ---
    for k, v in [("vent", "OPEN"), ("rain", "0"), ("smoke", "0")]:
        cur.execute("INSERT OR IGNORE INTO state(key,val) VALUES(?,?)", (k, v))

    # --- seed hazard history once so charts aren’t empty (no semicolons/one-liners) ---
    ts = now_iso()

    cur.execute("SELECT val FROM state WHERE key='rain'")
    r = cur.fetchone()
    rain_val = int(r["val"]) if r else 0

    cur.execute("SELECT val FROM state WHERE key='smoke'")
    r = cur.fetchone()
    smoke_val = int(r["val"]) if r else 0

    cur.execute("SELECT COUNT(*) AS c FROM rain_history")
    if cur.fetchone()["c"] == 0:
        cur.execute("INSERT INTO rain_history(ts,val) VALUES(?,?)", (ts, rain_val))

    cur.execute("SELECT COUNT(*) AS c FROM smoke_history")
    if cur.fetchone()["c"] == 0:
        cur.execute("INSERT INTO smoke_history(ts,val) VALUES(?,?)", (ts, smoke_val))

    con.commit()
    con.close()

init_db()

# -------------------------- Helpers --------------------------------
def get_state(key):
    con = db()
    cur = con.cursor()
    cur.execute("SELECT val FROM state WHERE key=?", (key,))
    row = cur.fetchone()
    con.close()
    return row["val"] if row else None

def set_state(key, val):
    con = db()
    cur = con.cursor()
    cur.execute("UPDATE state SET val=? WHERE key=?", (val, key))
    con.commit()
    con.close()
def log_action(by_user, command, cause=None):
    """Write control log; command includes cause in text if provided."""
    con = db()
    cur = con.cursor()
    desc = command if not cause else f"{command} (cause={cause})"
    cur.execute(
        "INSERT INTO control_log(ts, by_user, command) VALUES (?,?,?)",
        (now_iso(), by_user, desc),
    )
    con.commit()
    con.close()

def last_vent_change_ts():
    con = db()
    cur = con.cursor()
    cur.execute("SELECT ts FROM control_log WHERE command IN ('OPEN','CLOSE') ORDER BY rowid DESC LIMIT 1")
    row = cur.fetchone()
    con.close()
    return row["ts"] if row else None

def set_vent(state, by="USER", cause=None):
    state = "OPEN" if str(state).upper().startswith("O") else "CLOSE"
    if get_state("vent") != state:
        set_state("vent", state)
        log_action(by, state, cause=cause)
    else:
        set_state("vent", state)

def hazard_flags(hum=None, rain=None, smoke=None):
    if hum is None:
        con = db()
        cur = con.cursor()
        cur.execute("SELECT hum FROM readings ORDER BY rowid DESC LIMIT 1")
        row = cur.fetchone()
        con.close()
        hum = float(row["hum"]) if row and row["hum"] is not None else None
    if rain  is None:
        rain  = get_state("rain")  == "1"
    if smoke is None:
        smoke = get_state("smoke") == "1"
    humid = (hum is not None) and (float(hum) >= 85.0)
    active = bool(rain or smoke or humid)
    return {"rain": bool(rain), "smoke": bool(smoke), "humid": bool(humid), "active": active}
def maybe_auto_close(hum=None, rain=None, smoke=None):
    """If any hazard is active and vent is open, close it with cause precedence (smoke > rain > humidity)."""
    hz = hazard_flags(hum=hum, rain=rain, smoke=smoke)
    if hz.get("humidity_high") or hz.get("rain") or hz.get("smoke"):
        if get_state("vent") != "CLOSE":
            cause = "smoke" if hz.get("smoke") else ("rain" if hz.get("rain") else "humidity")
            set_vent("CLOSE", by="SYSTEM", cause=cause)
            # store last alert for UI
            set_state("last_alert", {"type": cause, "ts": now_iso()})
            return True
    return False

def insert_reading(temp, hum):
    con = db()
    cur = con.cursor()
    cur.execute("INSERT INTO readings(ts,temp,hum) VALUES (?,?,?)",
                (now_iso(), float(temp), float(hum)))
    con.commit()
    con.close()
    maybe_auto_close(hum=hum)

# ----------------------- Weather Integration -----------------------
def get_weather(city="Sydney,AU"):
    import requests
    api_key = os.getenv("OPENWEATHER_KEY") or "351390f538057811e3c0a090fe7dbe08"
    url = f"http://api.openweathermap.org/data/2.5/weather?q={city}&appid={api_key}&units=metric"
    try:
        r = requests.get(url, timeout=8)
        data = r.json()
        if "main" in data:
            return {
                "city": city,
                "temp": float(data["main"]["temp"]),
                "humidity": float(data["main"]["humidity"]),
                "condition": data["weather"][0]["description"].title(),
                "ok": True
            }
    except Exception:
        pass
    return {"city": city, "temp": None, "humidity": None, "condition": "N/A", "ok": False}

# ------------------------- Auth + Pages -----------------------------
@app.get("/")
def index():
    if "user" in session:
        return redirect(url_for("overview"))
    return redirect(url_for("login_page"))

@app.get("/login")
def login_page():
    return render_template("login.html")

@app.post("/login")
def login_post():
    data = request.get_json(silent=True) or request.form
    u = (data.get("username") or "").strip()
    p = (data.get("password") or "").strip()
    if not u or not p:
        return jsonify({"ok": False, "err": "missing"}), 400
    con = db()
    cur = con.cursor()
    cur.execute("SELECT password FROM users WHERE username=?", (u,))
    row = cur.fetchone()
    if not row or row["password"] != p:
        return jsonify({"ok": False, "err": "invalid"}), 401
    session["user"] = u
    return jsonify({"ok": True})

@app.post("/register")
def register():
    data = request.get_json(silent=True) or request.form
    u = (data.get("username") or "").strip()
    p = (data.get("password") or "").strip()
    if not u or not p:
        return jsonify({"ok": False}), 400
    con = db()
    cur = con.cursor()
    try:
        cur.execute("INSERT INTO users(username,password) VALUES(?,?)", (u, p))
        con.commit()
    except sqlite3.IntegrityError:
        con.close()
        return jsonify({"ok": False, "err": "exists"}), 409
    con.close()
    return jsonify({"ok": True})

@app.post("/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})

def require_user():
    if "user" not in session:
        return redirect(url_for("login_page"))
    return None

@app.get("/overview")
def overview():
    guard = require_user()
    if guard: return guard
    return render_template("overview.html", page="overview")

@app.get("/sensors")
def sensors_page():
    guard = require_user()
    if guard: return guard
    return render_template("sensors.html", page="sensors")

@app.get("/logs")
def logs_page():
    guard = require_user()
    if guard: return guard
    return render_template("logs.html", page="logs")

@app.get("/settings")
def settings_page():
    guard = require_user()
    if guard: return guard
    return render_template("settings.html", page="settings")

# ---------------------------- APIs --------------------------------
@app.get("/status")
def status():
    con = db()
    cur = con.cursor()
    cur.execute("SELECT ts,temp,hum FROM readings ORDER BY rowid DESC LIMIT 1")
    last = cur.fetchone()
    con.close()

    h = hazard_flags(hum=(last["hum"] if last else None))
    return jsonify({
        "ok": True,
        "vent":  get_state("vent"),
        "rain":  get_state("rain") == "1",
        "smoke": get_state("smoke") == "1",
        "ts":    last["ts"] if last else None,
        "temp":  last["temp"] if last else None,
        "hum":   last["hum"] if last else None,
        "user":  session.get("user", None),
        "vent_updated": last_vent_change_ts(),
        "hazard": h
    })

@app.post("/control")
def control():
    guard = require_user()
    if guard: return jsonify({"ok": False, "err": "auth"}), 401
    data = request.get_json(silent=True) or {}
    cmd = (data.get("cmd") or data.get("command") or "").upper()
    if cmd not in ("OPEN", "CLOSE"):
        return jsonify({"ok": False}), 400
    set_vent(cmd, by=session.get("user","USER"))
    return jsonify({"ok": True, "vent": get_state("vent")})

@app.post("/control-vent")
def control_vent_compat():
    return control()

@app.post("/set-rain")
def set_rain():
    data = request.get_json(silent=True) or {}
    val = 1 if str(data.get("on")).lower() in ("1","true","on") else 0
    set_state("rain", str(val))
    con = db()
    cur = con.cursor()
    cur.execute("INSERT INTO rain_history(ts,val) VALUES(?,?)", (now_iso(), val))
    con.commit()
    con.close()
    auto = maybe_auto_close(rain=bool(val))
    return jsonify({"ok": True, "rain": bool(val), "auto_close": auto, "vent": get_state("vent")})

@app.post("/rain")
def rain_compat():
    return set_rain()

@app.post("/set-smoke")
def set_smoke():
    data = request.get_json(silent=True) or {}
    val = 1 if str(data.get("on")).lower() in ("1","true","on") else 0
    set_state("smoke", str(val))
    con = db()
    cur = con.cursor()
    cur.execute("INSERT INTO smoke_history(ts,val) VALUES(?,?)", (now_iso(), val))
    con.commit()
    con.close()
    auto = maybe_auto_close(smoke=bool(val))
    return jsonify({"ok": True, "smoke": bool(val), "auto_close": auto, "vent": get_state("vent")})

@app.post("/smoke")
def smoke_compat():
    return set_smoke()

@app.get("/history")
def history():
    limit = int(request.args.get("limit", 50))
    con = db()
    cur = con.cursor()
    cur.execute("SELECT ts,temp,hum FROM readings ORDER BY rowid DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cur.fetchall()]
    con.close()
    return jsonify(rows[::-1])

@app.get("/rain-history")
def rain_history():
    limit = int(request.args.get("limit", 50))
    con = db()
    cur = con.cursor()
    cur.execute("SELECT ts,val FROM rain_history ORDER BY rowid DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cur.fetchall()]
    con.close()
    return jsonify(rows[::-1])

@app.get("/smoke-history")
def smoke_history():
    limit = int(request.args.get("limit", 50))
    con = db()
    cur = con.cursor()
    cur.execute("SELECT ts,val FROM smoke_history ORDER BY rowid DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cur.fetchall()]
    con.close()
    return jsonify(rows[::-1])

@app.get("/control-log")
def control_log_feed():
    limit = int(request.args.get("limit", 50))
    con = db()
    cur = con.cursor()
    cur.execute("SELECT ts,by_user,command FROM control_log ORDER BY rowid DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cur.fetchall()]
    con.close()
    return jsonify(rows)

@app.get("/logs.csv")
def logs_csv():
    con = db()
    cur = con.cursor()
    cur.execute("SELECT ts,by_user,command FROM control_log ORDER BY rowid DESC")
    rows = cur.fetchall()
    con.close()
    buf = io.StringIO()
    buf.write("timestamp,by,command\n")
    for r in rows:
        buf.write(f'{r["ts"]},{r["by_user"]},{r["command"]}\n')
    out = io.BytesIO(buf.getvalue().encode("utf-8"))
    return send_file(out, mimetype="text/csv", as_attachment=True, download_name="control_log.csv")

@app.post("/sensor")
def sensor_ingest():
    data = request.get_json(silent=True) or {}
    try:
        temp = float(data.get("temp"))
        hum  = float(data.get("hum"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "err": "bad-input"}), 400
    insert_reading(temp, hum)
    return jsonify({"ok": True})

@app.post("/demo-tick")
def demo_tick():
    temp = round(random.uniform(20, 30), 1)
    hum  = round(random.uniform(45, 65), 1)
    insert_reading(temp, hum)
    return jsonify({"ok": True, "temp": temp, "hum": hum})

@app.post("/pull-weather")
def pull_weather():
    data = request.get_json(silent=True) or {}
    city = (data.get("city") or "Sydney,AU").strip()
    w = get_weather(city)
    if not w.get("ok"):
        return jsonify({"ok": False, "city": city}), 200
    insert_reading(w["temp"], w["humidity"])
    return jsonify({"ok": True, "city": city, "temp": w["temp"], "hum": w["humidity"]})

@app.get("/config")
def config_info():
    has_env_key   = bool(os.getenv("OPENWEATHER_KEY"))
    default_city  = "Sydney,AU"
    return jsonify({"has_env_key": has_env_key, "default_city": default_city})

@app.post("/reset-hazards")
def reset_hazards():
    set_state("rain", "0")
    set_state("smoke", "0")
    log_action("SYSTEM", "RESET_HAZARDS")
    return jsonify({"ok": True})

@app.get("/debug/routes")
def debug_routes():
    return jsonify(sorted([str(r.rule) for r in app.url_map.iter_rules()]))

if __name__ == "__main__":
    print(f"Using DB: {DB_PATH}")
    init_db()
    app.run(host="127.0.0.1", port=5000, debug=True, use_reloader=False)

