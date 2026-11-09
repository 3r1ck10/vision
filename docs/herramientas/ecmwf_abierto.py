"""ECMWF IFS 0.25° (datos abiertos del ECMWF, licencia CC BY 4.0) -> JSON del visor

Requiere ecCodes: se ejecuta con el entorno aparte  D:\\miniconda\\envs\\grib\\python.exe
Uso:  python ecmwf_abierto.py           Sudamérica (1°, cada 6 h)          -> crudo_sa/ecmwf.json
      python ecmwf_abierto.py --nor     Nor-Oriente (0.25°, cada 3 h)      -> crudo/ecmwf.json

Fuente: primero los archivos locales  D:\\interpgrads\\Datos\\00\\ECMWF\\27.5Km  (AAAAMMDDHH0000-NNNh-oper-fc.grib2,
recortados por la descarga de InterPGrADS); si falta un paso, lo baja de data.ecmwf.int (solo los campos necesarios,
rangos de bytes según su .index, ~25 MB por paso). Misma corrida que el GFS del dominio si el ECMWF ya la publicó.
Sudamérica: promedio de bloques de 5x5 puntos (±0.5°) a la malla de 1°. Nor-Oriente: los puntos de 0.25° tal cual.
Mismas variables y unidades que extraer_modelos.py.
"""
import json, os, shutil, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
# el entorno "grib" no está activado: sus DLL (ecCodes) se buscan junto a su python.exe
_env = os.path.dirname(sys.executable)
os.environ["PATH"] = os.path.join(_env, "Library", "bin") + os.pathsep + _env + os.pathsep + os.environ.get("PATH", "")
import numpy as np
import eccodes

HERE = os.path.dirname(os.path.abspath(__file__))
INTERP = os.environ.get("INTERPGRADS", r"D:\interpgrads")
LOCAL = os.path.join(INTERP, r"Datos\00\ECMWF\27.5Km")
NOR = "--nor" in sys.argv

if NOR:      # Nor-Oriente: misma malla que el GFS regional (0.25°), pasos como Open-Meteo (cada 3 h hasta 144, luego 6 h)
    OUT, ARCH, NOMBRE = os.path.join(HERE, "crudo"), "ecmwf.json", "ECMWF"
    LON0, NX, LAT0, NY, DL, R = -81.5, 23, -8.5, 23, 0.25, 0
    PLEV = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 100]
    WLEV, QLEV = [925, 850, 700, 500, 250], [925, 850, 700, 500]
    STEPS = list(range(0, 145, 3)) + list(range(150, 169, 6)); STEP_H = 3
else:        # Sudamérica: 1°, cada 6 h
    OUT, ARCH, NOMBRE = os.path.join(HERE, "crudo_sa"), "ecmwf.json", "ECMWF"
    LON0, NX, LAT0, NY, DL, R = -150, 131, -60, 86, 1.0, 2
    PLEV = [1000, 925, 850, 700, 500, 300, 250, 200]
    WLEV, QLEV = [850, 500, 250], [925, 850, 700, 500]
    STEPS = list(range(0, 145, 6)); STEP_H = 6
TMP = os.path.join(HERE, "tmp", "ecmwf_" + ("nor" if NOR else "sa"))
os.makedirs(OUT, exist_ok=True); os.makedirs(TMP, exist_ok=True)
SFC = {"2t", "tp", "mucape", "lcc", "mcc", "hcc", "10u", "10v", "10fg", "10fg3", "10fg6", "msl"}   # ráfaga: el nombre cambia según el paso
BASE = "https://data.ecmwf.int/forecasts/{d}/{h:02d}z/ifs/0p25/oper/{d}{h:02d}0000-{s}h-oper-fc"

def curl(args, check=True):
    r = subprocess.run(["curl.exe", "-sS", "--fail", "--retry", "3", "--max-time", "300"] + args, capture_output=True)
    if check and r.returncode != 0:
        raise RuntimeError("curl: " + r.stderr.decode(errors="replace").strip())
    return r

def wanted(rec, step):
    p, lt = rec.get("param"), rec.get("levtype")
    if lt == "sfc":
        return p in SFC
    if lt != "pl":
        return False
    lev = int(rec.get("levelist", 0))
    if p in ("r", "t", "w") and lev in PLEV: return True
    if p in ("u", "v") and lev in WLEV: return True
    if p == "q" and lev in QLEV: return True
    if p == "gh" and lev in PLEV and (lev == 500 or step % 24 == 0): return True   # niveles completos 1 vez al día (altura media)
    return False

def archivo_local(run, step):
    fn = os.path.join(LOCAL, "%s0000-%03dh-oper-fc.grib2" % (time.strftime("%Y%m%d%H", time.gmtime(run)), step))
    return fn if os.path.exists(fn) and os.path.getsize(fn) > 1e6 else None

def bajar_paso(run, step):
    d, h = time.strftime("%Y%m%d", time.gmtime(run)), time.gmtime(run).tm_hour
    url = BASE.format(d=d, h=h, s=step)
    carpeta = os.path.join(TMP, time.strftime("%Y%m%d%H", time.gmtime(run)))
    os.makedirs(carpeta, exist_ok=True)
    fn = os.path.join(carpeta, "%03d.grib2" % step)
    idx = [json.loads(l) for l in curl([url + ".index"]).stdout.decode().splitlines() if l.strip()]
    sel = sorted((r for r in idx if wanted(r, step)), key=lambda r: r["_offset"])
    total = sum(r["_length"] for r in sel)
    if os.path.exists(fn) and os.path.getsize(fn) == total:
        return fn
    rangos = []                                    # rangos contiguos juntos -> menos consultas
    for r in sel:
        a, b = r["_offset"], r["_offset"] + r["_length"] - 1
        if rangos and rangos[-1][1] + 1 == a: rangos[-1][1] = b
        else: rangos.append([a, b])
    partes = [os.path.join(carpeta, "p%03d_%03d" % (step, i)) for i in range(len(rangos))]
    def una(i):                                    # cada rango en su propio curl (6 a la vez)
        a, b = rangos[i]
        curl(["-r", "%d-%d" % (a, b), "-o", partes[i], url + ".grib2"])
        if os.path.getsize(partes[i]) != b - a + 1:
            raise RuntimeError("paso %d: rango %d-%d incompleto" % (step, a, b))
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(una, range(len(rangos))))
    with open(fn, "wb") as o:
        for p in partes:
            o.write(open(p, "rb").read()); os.remove(p)
    if os.path.getsize(fn) != total:
        raise RuntimeError("paso %d: tamaño inesperado" % step)
    return fn

def muestrear(F, g):
    """Valores en la malla del visor. F: (Nj, Ni) en el orden del GRIB. R > 0: promedio de (2R+1)² puntos."""
    lat1 = eccodes.codes_get(g, "latitudeOfFirstGridPointInDegrees"); lon1 = eccodes.codes_get(g, "longitudeOfFirstGridPointInDegrees")
    d = eccodes.codes_get(g, "iDirectionIncrementInDegrees"); sur_norte = eccodes.codes_get(g, "jScansPositively") == 1
    ni = F.shape[1]; glob = abs(ni * d - 360) < 1e-6
    rows = np.array([int(round(((LAT0 + j * DL) - lat1) / d)) if sur_norte else int(round((lat1 - (LAT0 + j * DL)) / d)) for j in range(NY)])
    cols = np.array([int(round(((LON0 + i * DL - lon1) % 360) / d)) for i in range(NX)])
    if rows.min() - R < 0 or rows.max() + R >= F.shape[0] or (not glob and (cols.min() - R < 0 or cols.max() + R >= ni)):
        raise RuntimeError("el archivo no cubre el dominio")
    if R == 0:
        return F[np.ix_(rows, cols)].ravel()
    Rw = np.stack([F[r - R:r + R + 1].mean(axis=0) for r in rows])          # promedio de filas
    if glob: Rw = np.concatenate([Rw[:, -R:], Rw, Rw[:, :R]], axis=1); cols = cols + R
    return np.mean([Rw[:, cols + k] for k in range(-R, R + 1)], axis=0).ravel()

def leer(fn):
    campos = {}
    with open(fn, "rb") as f:
        while True:
            g = eccodes.codes_grib_new_from_file(f)
            if g is None: break
            try:
                sn, lev, tl = eccodes.codes_get(g, "shortName"), eccodes.codes_get(g, "level"), eccodes.codes_get(g, "typeOfLevel")
                if tl == "isobaricInhPa":
                    if not ((sn in ("r", "t", "w") and lev in PLEV) or (sn in ("u", "v") and lev in WLEV) or (sn == "q" and lev in QLEV)
                            or (sn == "gh" and lev in PLEV)):
                        continue
                    key = (sn, lev)
                elif sn in SFC: key = (sn, 0)
                else: continue
                ni, nj = eccodes.codes_get(g, "Ni"), eccodes.codes_get(g, "Nj")
                v = eccodes.codes_get_values(g).reshape(nj, ni)
                v = np.where(v == eccodes.codes_get(g, "missingValue"), np.nan, v)
                campos[key] = muestrear(v, g)
            finally:
                eccodes.codes_release(g)
    return campos

# HR común (agua T>=0 °C, hielo T<0 °C) desde la definición del IFS (mezcla entre 0 y -23 °C): igual que extraer_modelos.py
def es_w(tc): return 6.1121 * np.exp(17.502 * tc / (240.97 + tc))
def es_i(tc): return 6.1115 * np.exp(22.452 * tc / (272.55 + tc))
def rh_comun(rh, tk):
    tc = tk - 273.15
    a = np.where(tc >= 0, 1.0, np.where(tc > -23, ((tc + 23) / 23) ** 2, 0.0))
    es_m = a * es_w(tc) + (1 - a) * es_i(tc)
    es_c = np.where(tc >= 0, es_w(tc), es_i(tc))
    return np.minimum(100.0, rh * es_m / es_c)
def std_temp(p):
    z = 44330.8 * (1 - (p / 1013.25) ** 0.190263); return max(216.65, 288.15 - 0.0065 * z)
def omega_to_w(om, p): return -om * 287.05 * std_temp(p) / (p * 100 * 9.80665)

def ints(a, s=1.0, off=0.0):
    if a is None: return None
    return [None if not np.isfinite(x) else int(round((x - off) * s)) for x in a]

def corrida():
    """Corrida del GFS del dominio (para compararlos) si está en local o en el ECMWF; si no, la última 00/12Z."""
    cands = []
    g = os.path.join(OUT, "gfs.json")
    if os.path.exists(g):
        t0 = json.load(open(g))["t0"]
        cands.append(int(time.mktime(time.strptime(t0[:16], "%Y-%m-%dT%H:%M")) - time.timezone))
    now = int(time.time()) // 43200 * 43200
    cands += [now - 43200 * k for k in range(0, 8)]
    for run in cands:
        if time.gmtime(run).tm_hour not in (0, 12): continue
        if all(archivo_local(run, s) for s in STEPS):
            return run, (run == cands[0] and os.path.exists(g))
        d, h = time.strftime("%Y%m%d", time.gmtime(run)), time.gmtime(run).tm_hour
        if curl(["-I", BASE.format(d=d, h=h, s=STEPS[-1]) + ".index"], check=False).returncode == 0:
            return run, (run == cands[0] and os.path.exists(g))
    raise SystemExit("No hay corridas del ECMWF disponibles (ni en %s ni en data.ecmwf.int)" % LOCAL)

if __name__ == "__main__":
    run, igual = corrida()
    run_iso = time.strftime("%Y-%m-%dT%H:00Z", time.gmtime(run))
    locales = sum(1 for s in STEPS if archivo_local(run, s))
    print("%s %s: corrida %s %s | %d de %d pasos en archivos locales" % (NOMBRE, "Nor-Oriente" if NOR else "Sudamérica", run_iso,
          "(igual que el GFS)" if igual else "(el GFS es de otra corrida)", locales, len(STEPS)), flush=True)
    for c in os.listdir(TMP):                                           # borrar descargas de corridas viejas
        if c != time.strftime("%Y%m%d%H", time.gmtime(run)): shutil.rmtree(os.path.join(TMP, c), ignore_errors=True)
    lons = [round(LON0 + i * DL, 3) for i in range(NX)]; lats = [round(LAT0 + j * DL, 3) for j in range(NY)]; n = NX * NY
    gfs = os.path.join(OUT, "gfs.json")
    hgt = json.load(open(gfs))["hgt"] if os.path.exists(gfs) else [0] * n   # orografía: la del GFS, misma malla (el ECMWF abierto no la publica)
    steps, prev_tp, zs, usados = [], None, {p: [] for p in PLEV}, set()
    for s in STEPS:
        t = time.time(); fn = archivo_local(run, s)
        usados.add("local" if fn else "descarga")
        fn = fn or bajar_paso(run, s); C = leer(fn)
        g = lambda k, l=0: C.get((k, l))
        tp = g("tp")
        pr = np.zeros(n) if prev_tp is None or tp is None else np.maximum(0, (tp - prev_tp) * 1000)
        prev_tp = tp
        cc = lambda a: None if a is None else (a * 100 if np.nanmax(a) <= 1.5 else a)   # nubosidad 0-1 -> %
        st = dict(fh=s, t2=ints(g("2t"), 10, 273.15), pr=ints(pr, 10), cape=ints(g("mucape")),
                  u10=ints(g("10u"), 10), v10=ints(g("10v"), 10), g10=ints(next((g(x) for x in ("10fg", "10fg3", "10fg6") if g(x) is not None), None), 10),
                  lcc=ints(cc(g("lcc"))), mcc=ints(cc(g("mcc"))), hcc=ints(cc(g("hcc"))),
                  slp=ints(g("msl"), 0.1), z500=ints(g("gh", 500)))
        for p in WLEV:
            st["u%d" % p] = ints(g("u", p), 10); st["v%d" % p] = ints(g("v", p), 10)
            st["t%d" % p] = ints(g("t", p), 10, 273.15)                  # temperatura (advección), décimas de °C
        for p in QLEV:
            qq = g("q", p)                                               # humedad específica (kg/kg) -> relación de mezcla w = q/(1-q),
            st["q%d" % p] = None if qq is None else ints(qq / (1 - qq), 10000)   # en décimas de g/kg (igual que GFS/ETA/Open-Meteo)
        for p in PLEV:
            r, tk, om = g("r", p), g("t", p), g("w", p)
            st["rh%d" % p] = ints(rh_comun(r, tk)) if r is not None and tk is not None else None
            st["w%d" % p] = None if om is None else ints(omega_to_w(om, p) * 100)      # cm/s, + ascenso
            if g("gh", p) is not None and (s % 24 == 0): zs[p].append(g("gh", p))
        steps.append(st)
        print(NOMBRE, s, "ok (%.0f s)" % (time.time() - t), flush=True)
    zlev = [ints(np.nanmean(zs[p], axis=0)) if zs[p] else None for p in PLEV]
    origen = "archivos locales Datos\\00\\ECMWF\\27.5Km" if usados == {"local"} else "data.ecmwf.int" if usados == {"descarga"} else "archivos locales + data.ecmwf.int"
    out = dict(model=NOMBRE, t0=run_iso, step_h=STEP_H, lons=lons, lats=lats, hgt=hgt, plev=PLEV, zlev=zlev, steps=steps,
               fuente="datos abiertos ECMWF (CC BY 4.0), %s, procesado %s UTC" % (origen, time.strftime("%Y-%m-%d %H:%M", time.gmtime())))
    json.dump(out, open(os.path.join(OUT, ARCH), "w"), separators=(",", ":"))
    print("%s listo: %d pasos %dx%d (%s)" % (ARCH, len(steps), NX, NY, origen))
    # ya procesado: borrar lo descargado (los archivos locales no se tocan)
    shutil.rmtree(os.path.join(TMP, time.strftime("%Y%m%d%H", time.gmtime(run))), ignore_errors=True)
