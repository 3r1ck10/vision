"""Descarga relieve (Open-Meteo elevation, DEM 90 m) y ECMWF IFS 0.25 (Open-Meteo) en grilla -> JSON."""
import json, math, os, subprocess, sys, time, urllib.request, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "crudo") if os.path.basename(HERE) == "herramientas" else os.path.join(HERE, "data")
os.makedirs(OUT, exist_ok=True)
LON0, LON1, LAT0, LAT1 = -81.5, -76.0, -8.5, -3.0

USE_CURL = False

def _curl(url):
    """Descarga con curl.exe de Windows (usa los certificados del sistema, que se mantienen al día)."""
    r = subprocess.run(["curl.exe", "-sS", "--fail", "--max-time", "180", url], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("curl: " + r.stderr.decode(errors="replace").strip())
    return json.loads(r.stdout)

def get(url, tries=5):
    global USE_CURL
    for k in range(tries):
        try:
            if USE_CURL:
                return _curl(url)
            with urllib.request.urlopen(url, timeout=120) as r:
                return json.load(r)
        except Exception as e:
            if not USE_CURL and "CERTIFICATE_VERIFY_FAILED" in str(e):
                # Python antiguo con certificados raíz vencidos: no se desactiva la verificación, se usa curl de Windows
                print("  certificados de Python vencidos; uso curl.exe de Windows", flush=True); USE_CURL = True
                continue
            espera = 65 if "429" in str(e) else 3 + 5 * k      # 429 = demasiadas consultas: esperar el minuto
            print("reintento", k, e, "- espero", espera, "s", flush=True); time.sleep(espera)
    raise SystemExit("falló " + url[:120])

def dem(step=0.05):
    lons = [round(LON0 + i * step, 4) for i in range(int(round((LON1 - LON0) / step)) + 1)]
    lats = [round(LAT0 + j * step, 4) for j in range(int(round((LAT1 - LAT0) / step)) + 1)]
    pts = [(la, lo) for la in lats for lo in lons]
    elev = []
    for i in range(0, len(pts), 100):
        ch = pts[i:i + 100]
        q = urllib.parse.urlencode({"latitude": ",".join(str(p[0]) for p in ch),
                                    "longitude": ",".join(str(p[1]) for p in ch)})
        elev += get("https://api.open-meteo.com/v1/elevation?" + q)["elevation"]
        if i % 2000 == 0: print("dem", i, "/", len(pts), flush=True)
        time.sleep(0.25)
    json.dump(dict(lons=lons, lats=lats, z=[int(round(max(e, -1))) for e in elev]),
              open(os.path.join(OUT, "dem.json"), "w"), separators=(",", ":"))
    print("dem listo", len(lons), "x", len(lats))

WLEV = [925, 850, 700, 500]          # niveles de relación de mezcla (iguales a extraer_modelos.py)
VLEV = WLEV + [250]                  # niveles de viento (250 hPa: corriente en chorro)
HV = ["temperature_2m", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high",
      "precipitation", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "cape", "pressure_msl"] + \
     [v % p for p in VLEV for v in ("wind_speed_%dhPa", "wind_direction_%dhPa")]

# Mismos 11 niveles que GFS y ETA (ver extraer_modelos.py): humedad, velocidad vertical y altura
PLEV = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 100]
HV_LEV = [v % p for p in PLEV for v in ("relative_humidity_%dhPa", "vertical_velocity_%dhPa", "geopotential_height_%dhPa", "temperature_%dhPa")]

# Humedad común (agua si T>=0, hielo si T<0): misma conversión que extraer_modelos.py; ECMWF usa la mezcla del IFS (0 a -23 °C)
def es_w(tc): return 6.1121 * math.exp(17.502 * tc / (240.97 + tc))
def es_i(tc): return 6.1115 * math.exp(22.452 * tc / (272.55 + tc))
def es_ecmwf(tc):                      # saturación según la definición del IFS (mezcla agua/hielo entre 0 y -23 °C)
    if tc >= 0: return es_w(tc)
    a = ((tc + 23) / 23) ** 2 if tc > -23 else 0.0
    return a * es_w(tc) + (1 - a) * es_i(tc)
def mixing_ratio(rh, tc, p):           # g/kg, misma fórmula que extraer_modelos.py
    if rh is None or tc is None: return None
    e = max(0.0, rh) / 100 * es_ecmwf(tc)
    return 622 * e / (p - e)

def rh_comun_ecmwf(rh, tc):
    if rh is None or tc is None: return rh
    if tc >= 0: return rh
    a = ((tc + 23) / 23) ** 2 if tc > -23 else 0.0
    return min(100.0, rh * (a * es_w(tc) + (1 - a) * es_i(tc)) / es_i(tc))

def iso_utc(s):        # "2026-11-06T00:00Z" -> segundos UTC
    return time.mktime(time.strptime(s.replace("Z", "")[:16], "%Y-%m-%dT%H:%M")) - time.timezone

def corrida_objetivo(latest):
    """Misma corrida que el GFS/ETA locales (para compararlos), si el ECMWF ya la publicó; si no, la última."""
    for n in ("gfs", "eta"):
        fn = os.path.join(OUT, n + ".json")
        if os.path.exists(fn):
            try:
                t0 = iso_utc(json.load(open(fn))["t0"])
            except Exception:
                continue
            if latest - 3 * 86400 <= t0 <= latest:
                return int(t0), n.upper()
    return latest, None

def ecmwf(step=0.25):
    lons = [round(LON0 + i * step, 3) for i in range(23)]
    lats = [round(LAT0 + j * step, 3) for j in range(23)]
    pts = [(la, lo) for la in lats for lo in lons]
    meta = get("https://api.open-meteo.com/data/ecmwf_ifs025/static/meta.json")
    latest = int(meta["last_run_initialisation_time"])
    init, ref = corrida_objetivo(latest)
    run_iso = time.strftime("%Y-%m-%dT%H:00Z", time.gmtime(init))
    print("ECMWF: última corrida publicada", time.strftime("%Y-%m-%d %HZ", time.gmtime(latest)),
          "| se descarga", run_iso, "(igual que " + ref + ")" if ref else "")
    # API de corridas individuales: entrega exactamente esa corrida (no la mezcla con otras)
    base = "https://single-runs-api.open-meteo.com/v1/forecast?"
    extra = {"run": run_iso[:16], "forecast_days": 7}
    res = []
    # Open-Meteo cuenta ~1 consulta por punto y por cada 10 variables, con tope de 600 por minuto:
    # 30 puntos x 63 variables = ~210 por bloque -> un bloque cada 25 s.
    CH = 30
    for i in range(0, len(pts), CH):
        ch = pts[i:i + CH]
        q = {"latitude": ",".join(str(p[0]) for p in ch), "longitude": ",".join(str(p[1]) for p in ch),
             "models": "ecmwf_ifs025", "hourly": ",".join(HV + HV_LEV), "timezone": "GMT", "wind_speed_unit": "ms"}
        try:
            r = get(base + urllib.parse.urlencode(dict(q, **extra)))
        except SystemExit:
            if i: raise
            # sin la API de corridas: la API normal (última corrida), desde el día de hoy
            print("  API de corridas no disponible; uso la última corrida", flush=True)
            base, init = "https://api.open-meteo.com/v1/forecast?", latest
            run_iso = time.strftime("%Y-%m-%dT%H:00Z", time.gmtime(init))
            extra = {"start_date": time.strftime("%Y-%m-%d", time.gmtime(init)),
                     "end_date": time.strftime("%Y-%m-%d", time.gmtime(init + 6 * 86400))}
            r = get(base + urllib.parse.urlencode(dict(q, **extra)))
        res += r if isinstance(r, list) else [r]
        print("ecmwf", i + len(ch), "/", len(pts), flush=True)
        if i + CH < len(pts): time.sleep(25)
    print("ECMWF corrida", run_iso)
    times = res[0]["hourly"]["time"]
    idx3 = [k for k, t in enumerate(times) if int(t[11:13]) % 3 == 0]
    def uv(s, d):
        if s is None or d is None: return None, None
        a = math.radians(d); return -s * math.sin(a), -s * math.cos(a)
    steps = []
    for k in idx3:
        st = {n: [] for n in ["t2", "u10", "v10", "g10", "cape", "lcc", "mcc", "hcc", "pr"] + ["%s%d" % (c, p) for p in WLEV for c in "uvq"] + ["u250", "v250"]}
        for r in res:
            h = r["hourly"]; v = lambda n: h[n][k]
            qi = lambda x, s=1.0: None if x is None else int(round(x * s))
            st["t2"].append(qi(v("temperature_2m"), 10))
            for p in WLEV:
                st["q%d" % p].append(qi(mixing_ratio(v("relative_humidity_%dhPa" % p), v("temperature_%dhPa" % p), p), 10))
            for lev, su in [("10m", "10")] + [("%dhPa" % p, str(p)) for p in VLEV]:
                u, vv = uv(v("wind_speed_" + lev), v("wind_direction_" + lev))
                st["u" + su].append(qi(u, 10)); st["v" + su].append(qi(vv, 10))
            st["g10"].append(qi(v("wind_gusts_10m"), 10))          # ráfaga máx. de la hora anterior, décimas de m/s
            st.setdefault("slp", []).append(qi(v("pressure_msl"), 10))           # décimas de hPa
            st.setdefault("z500", []).append(qi(v("geopotential_height_500hPa")))  # m
            st["cape"].append(qi(v("cape"))); st["lcc"].append(qi(v("cloud_cover_low")))
            st["mcc"].append(qi(v("cloud_cover_mid"))); st["hcc"].append(qi(v("cloud_cover_high")))
            pr = sum((h["precipitation"][j] or 0) for j in range(max(0, k - 2), k + 1))
            st["pr"].append(qi(pr, 10))
            for p in VLEV:                                            # temperatura en los niveles de viento (advección)
                st.setdefault("t%d" % p, []).append(qi(v("temperature_%dhPa" % p), 10))
            for p in PLEV:
                st.setdefault("rh%d" % p, []).append(qi(rh_comun_ecmwf(v("relative_humidity_%dhPa" % p), v("temperature_%dhPa" % p))))
                st.setdefault("w%d" % p, []).append(qi(v("vertical_velocity_%dhPa" % p), 100))   # cm/s, + ascenso
        valid = time.mktime(time.strptime(times[k], "%Y-%m-%dT%H:%M")) - time.timezone      # UTC
        st["fh"] = int(round((valid - init) / 3600))                                         # horas desde la inicialización
        steps.append(st)
    zlev = []
    for p in PLEV:     # altura media de cada nivel en el periodo (m)
        col = []
        for r in res:
            z = [x for x in r["hourly"]["geopotential_height_%dhPa" % p] if x is not None]
            col.append(int(round(sum(z) / len(z))) if z else None)
        zlev.append(col)
    out = dict(model="ECMWF", t0=run_iso, step_h=3, lons=lons, lats=lats,
               hgt=[int(round(r["elevation"])) for r in res], plev=PLEV, zlev=zlev, steps=steps,
               fuente="Open-Meteo, descargado %s UTC" % time.strftime("%Y-%m-%d %H:%M", time.gmtime()))
    json.dump(out, open(os.path.join(OUT, "ecmwf.json"), "w"), separators=(",", ":"))
    print("ecmwf listo", len(steps), "pasos")

if __name__ == "__main__":
    w = sys.argv[1:] or ["dem", "ecmwf"]
    if "ecmwf" in w: ecmwf()
    if "dem" in w: dem()
