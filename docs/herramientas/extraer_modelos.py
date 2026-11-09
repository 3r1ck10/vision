"""Extrae GFS y ETA locales recortados al dominio norte del Perú -> JSON para el visor 3D.

Nubes: para poder intercomparar, los tres modelos (GFS, ETA, ECMWF) entregan lo mismo:
humedad relativa (%), velocidad vertical (m/s, + = ascenso) y altura geopotencial (m)
en los mismos 11 niveles PLEV. El visor diagnostica la nube con un único método.
Uso:  python extraer_modelos.py GFS ETA          (normal)
      python extraer_modelos.py GFS --prueba     (ignora corridas mezcladas; escribe crudo/prueba_gfs.json)
      python extraer_modelos.py GFS --sa         (Sudamérica 25°N–60°S, 150°O–20°O, 1°, cada 6 h -> crudo_sa/)
"""
import subprocess, os, json, sys, re

W = r"D:\OpenGrADS-2.2\Contents\Cygwin\Versions\2.2.1.oga.1\i686\wgrib2.exe"
HERE = os.path.dirname(os.path.abspath(__file__))
SA = "--sa" in sys.argv
OUT = os.path.join(HERE, "crudo_sa" if SA else "crudo") if os.path.basename(HERE) == "herramientas" else os.path.join(HERE, "data")
TMP = os.path.join(HERE, "tmp")
INTERP = os.environ.get("INTERPGRADS", r"D:\interpgrads")
os.makedirs(OUT, exist_ok=True); os.makedirs(TMP, exist_ok=True)

# Niveles presentes en GFS, ETA y ECMWF (Open-Meteo). El ETA no tiene 150 hPa.
# Sudamérica usa menos niveles para que el paquete no pese demasiado (mismos que ecmwf_abierto.py).
PLEV = [1000, 925, 850, 700, 500, 300, 250, 200] if SA else [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 100]
PL = "|".join(str(p) for p in PLEV)
WLEV = [850, 500, 250] if SA else [925, 850, 700, 500, 250]   # niveles de viento
QLEV = [925, 850, 700, 500]                                   # niveles de relación de mezcla
WL = "|".join(str(p) for p in WLEV)
BASE = ("(TMP:2 m above ground|UGRD:10 m above ground|VGRD:10 m above ground|"
        "UGRD:(%s) mb|VGRD:(%s) mb|CAPE:surface|HGT:surface|PRMSL:mean sea level|MSLET:mean sea level|"
        "LCDC:low cloud layer|MCDC:middle cloud layer|HCDC:high cloud layer|"
        "RH:(%s) mb|VVEL:(%s) mb|HGT:(%s) mb|TMP:(%s) mb)" % (WL, WL, PL, PL, PL, PL))
INST = ":%s:([0-9]+ hour fcst|anl):" % BASE
ACC = ":APCP:surface:[0-9]+-[0-9]+ (hour|day) acc fcst:"   # GFS: 0-N y parciales; ETA: parciales de 6 h; en múltiplos de 24 h wgrib2 escribe "day"

# ---- Humedad relativa con una definición común para los tres modelos ----
# Común: respecto del agua si T >= 0 °C y respecto del hielo si T < 0 °C.
# Cada modelo la entrega distinto (comprobado con los datos): ETA respecto del agua siempre;
# GFS ya respecto del hielo bajo 0 °C; ECMWF mixta entre 0 y -23 °C (definición del IFS).
import math as _m
def es_w(tc): return 6.1121 * _m.exp(17.502 * tc / (240.97 + tc))
def es_i(tc): return 6.1115 * _m.exp(22.452 * tc / (272.55 + tc))
def es_model(tc, defin):
    if tc >= 0 or defin == "agua": return es_w(tc)
    if defin == "hielo": return es_i(tc)
    if tc <= -23: return es_i(tc)                     # "ecmwf": mezcla cuadrática entre 0 y -23 °C
    a = ((tc + 23) / 23) ** 2
    return a * es_w(tc) + (1 - a) * es_i(tc)
def rh_comun(rh, t_k, defin):
    if rh is None or t_k is None: return rh
    tc = t_k - 273.15
    es_c = es_w(tc) if tc >= 0 else es_i(tc)
    return min(100.0, rh * es_model(tc, defin) / es_c)

def mixing_ratio(rh, t_k, p_hpa, defin):
    """Relación de mezcla (g/kg) con la HR en la definición PROPIA del modelo: e = HR·es(T); w = 622·e/(p−e)."""
    if rh is None or t_k is None: return None
    e = max(0.0, rh) / 100 * es_model(t_k - 273.15, defin)
    return 622 * e / (p_hpa - e)

def std_temp(p_hpa):
    """Temperatura de la atmósfera estándar (K) a la presión p, para pasar Pa/s a m/s."""
    z = 44330.8 * (1 - (p_hpa / 1013.25) ** 0.190263)
    return max(216.65, 288.15 - 0.0065 * z)

def omega_to_w(omega, p_hpa):
    """w (m/s, + ascenso) = -omega * R * T / (p * g)."""
    return -omega * 287.05 * std_temp(p_hpa) / (p_hpa * 100 * 9.80665)

def read_grib(grib, tag, grid):
    lon0, nx, dl, lat0, ny, da = grid
    txt = os.path.join(TMP, tag + ".txt")
    r = subprocess.run([W, grib, "-match", "(%s|%s)" % (INST, ACC),
                        "-lola", "%g:%d:%g" % (lon0, nx, dl), "%g:%d:%g" % (lat0, ny, da), txt, "text"],
                       capture_output=True, text=True, check=True)
    inv = [l.split(":") for l in r.stdout.strip().splitlines()]
    with open(txt) as f:
        vals = f.read().split()
    recs, pos = {}, 0
    for p in inv:
        n = int(vals[pos]) * int(vals[pos + 1]); pos += 2
        data = [float(v) for v in vals[pos:pos + n]]; pos += n
        key = (p[3], p[4])
        if p[3] == "APCP":       # cada intervalo de acumulación en horas: ("APCP", (a, b))
            mm = re.match(r"(\d+)-(\d+) (hour|day) acc", p[5])
            f = 24 if mm.group(3) == "day" else 1
            key = ("APCP", (int(mm.group(1)) * f, int(mm.group(2)) * f))
        if key in recs:          # registros duplicados: quedarse con el primero
            continue
        recs[key] = [None if abs(v) > 9e19 else v for v in data]      # plano, fila = latitud
    return recs

def grid_axes(grid):
    lon0, nx, dl, lat0, ny, da = grid
    return [round(lon0 + i * dl, 3) for i in range(nx)], [round(lat0 + j * da, 3) for j in range(ny)]

def run_date(path):
    """Fecha de la corrida leída del propio GRIB (d=AAAAMMDDHH) -> 'AAAA-MM-DDTHH:00Z'."""
    out = subprocess.run([W, path, "-d", "1", "-t"], capture_output=True, text=True).stdout
    d = out.strip().split("d=")[1][:10]
    return "%s-%s-%sT%s:00Z" % (d[:4], d[4:6], d[6:8], d[8:10])

def q(arr, s=1.0, off=0.0):
    if arr is None:
        return None
    return [int(round((v - off) * s)) if v is not None else None for v in arr]

def process(name, files, step_h, grid, prueba=False, rh_def="agua"):
    runs = {p: run_date(p) for _, p in files if os.path.exists(p)}
    if not runs:
        print(name, ": no hay archivos, se omite"); return False
    t0_iso = max(runs.values())
    otros = [fh for fh, p in files if p in runs and runs[p] != t0_iso]
    faltan = [fh for fh, p in files if p not in runs]
    if otros and not prueba:
        # Archivos de corridas distintas con el mismo nombre: mezclarlos da campos y lluvias falsas.
        print("*** %s: la carpeta mezcla corridas. Corrida más reciente %s, pero %d archivos son de otra: f%s"
              % (name, t0_iso, len(otros), ",".join("%03d" % f for f in otros)))
        print("*** No se actualiza %s. Vuelve a descargar la corrida completa y ejecuta de nuevo." % name)
        return False
    if faltan:
        print("  aviso: %s sin archivos f%s (se interpola entre los que hay)" % (name, ",".join("%03d" % f for f in faltan)))
    print(name, "corrida", t0_iso, "(PRUEBA: corridas mezcladas)" if otros else "")
    lons, lats = grid_axes(grid)
    n = len(lons) * len(lats)
    hgt = None; prev_bk = {}; prev_fh = None; steps = []
    zsum = [[0.0] * n for _ in PLEV]; zcnt = [[0] * n for _ in PLEV]
    for fh, path in files:
        if not os.path.exists(path):
            continue
        recs = read_grib(path, "%s_%03d" % (name, fh), grid)
        g = lambda v, l: recs.get((v, l))
        if hgt is None:
            hgt = g("HGT", "surface")
        # Lluvia del intervalo (fh_anterior, fh]: intervalo exacto si existe, si no la resta de dos
        # parciales que empiezan igual (60-66 menos 60-63), y como último recurso el acumulado 0-N.
        zero = [0.0] * n
        bk = {k[1]: [0.0 if x is None else x for x in recs[k]] for k in recs if k[0] == "APCP"}
        if prev_fh is None:
            pr = zero
        elif (prev_fh, fh) in bk:
            pr = bk[(prev_fh, fh)]
        else:
            a = next((a for (a, b) in bk if b == fh and (a, prev_fh) in prev_bk), None)
            if a is not None:
                pr = [max(0.0, x - y) for x, y in zip(bk[(a, fh)], prev_bk[(a, prev_fh)])]
            elif (0, fh) in bk and (0, prev_fh) in prev_bk:
                pr = [max(0.0, x - y) for x, y in zip(bk[(0, fh)], prev_bk[(0, prev_fh)])]
            else:
                print("  aviso: sin lluvia para", name, prev_fh, "-", fh); pr = zero
        prev_bk, prev_fh = bk, fh
        st = dict(fh=fh,
                  t2=q(g("TMP", "2 m above ground"), 10, 273.15),
                  u10=q(g("UGRD", "10 m above ground"), 10), v10=q(g("VGRD", "10 m above ground"), 10),
                  cape=q(g("CAPE", "surface")),
                  lcc=q(g("LCDC", "low cloud layer")), mcc=q(g("MCDC", "middle cloud layer")),
                  hcc=q(g("HCDC", "high cloud layer")),
                  pr=q(pr, 10),
                  # presión a nivel del mar (décimas de hPa; GFS PRMSL, ETA MSLET) y altura geopotencial de 500 hPa (m)
                  slp=q(g("PRMSL", "mean sea level") or g("MSLET", "mean sea level"), 0.1),
                  z500=q(g("HGT", "500 mb")))
        for p in WLEV:
            st["u%d" % p] = q(g("UGRD", "%d mb" % p), 10); st["v%d" % p] = q(g("VGRD", "%d mb" % p), 10)
        for li, p in enumerate(PLEV):
            rh, om, z, tk = g("RH", "%d mb" % p), g("VVEL", "%d mb" % p), g("HGT", "%d mb" % p), g("TMP", "%d mb" % p)
            if p in WLEV:                                           # temperatura en los niveles de viento (advección)
                st["t%d" % p] = q(tk, 10, 273.15)
            if p in QLEV and rh is not None and tk is not None:     # antes de cambiar la definición de HR
                st["q%d" % p] = [None if r is None or t is None else int(round(mixing_ratio(r, t, p, rh_def) * 10)) for r, t in zip(rh, tk)]
            if rh is not None:
                tk = tk or [std_temp(p)] * n
                rh = [rh_comun(r, t, rh_def) for r, t in zip(rh, tk)]
            st["rh%d" % p] = q(rh)
            st["w%d" % p] = None if om is None else [None if v is None else int(round(omega_to_w(v, p) * 100)) for v in om]  # cm/s
            if z:
                for i, v in enumerate(z):
                    if v is not None: zsum[li][i] += v; zcnt[li][i] += 1
        steps.append(st)
        print(name, fh, "ok", flush=True)
    zlev = [[int(round(s / c)) if c else None for s, c in zip(zsum[li], zcnt[li])] for li in range(len(PLEV))]
    out = dict(model=name, t0=t0_iso, step_h=step_h, lons=[lo - 360 if lo > 180 else lo for lo in lons], lats=lats,
               hgt=[None if v is None else int(round(v)) for v in hgt], plev=PLEV, zlev=zlev, steps=steps)
    fn = ("prueba_" if prueba else "") + name.lower() + ".json"
    with open(os.path.join(OUT, fn), "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(name, "escrito", fn, len(steps), "pasos", len(lons), "x", len(lats))
    return True

if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    which = args or ["GFS", "ETA", "WRF"]
    prueba = "--prueba" in sys.argv
    ok = True
    if SA:
        # GFS de la carpeta 27.5Km (cubre 144°O–6°O, 70°S–30°N); de 150°O a 144°O queda sin dato
        ok &= process("GFS", [(fh, os.path.join(INTERP, r"Datos\00\GFS\27.5Km\gfs.t00z.pgrb2.0p25.f%03d" % fh)) for fh in range(0, 145, 6)],
                      6, (210, 131, 1.0, -60, 86, 1.0), prueba, rh_def="hielo") is not False
        sys.exit(0 if ok else 2)
    if "GFS" in which:
        ok &= process("GFS", [(fh, os.path.join(INTERP, r"Datos\00\GFS\27.5Km\gfs.t00z.pgrb2.0p25.f%03d" % fh)) for fh in range(0, 169, 3)],
                      3, (278.5, 23, 0.25, -8.5, 23, 0.25), prueba, rh_def="hielo") is not False
    if "ETA" in which:
        # ETA 22 km (0.2°) si existe; si no, la versión anterior de 32 km (0.333°)
        d22 = os.path.join(INTERP, r"Datos\00\ETA\22Km")
        if os.path.exists(os.path.join(d22, "latlon_000")):
            eta_dir, eta_grid = d22, (278.6, 28, 0.2, -8.6, 28, 0.2)
        else:
            eta_dir, eta_grid = os.path.join(INTERP, r"Datos\00\ETA\32Km"), (278.632, 17, 0.333, -8.712, 18, 0.333)
        ok &= process("ETA", [(fh, os.path.join(eta_dir, "latlon_%03d" % fh)) for fh in range(0, 169, 6)],
                      6, eta_grid, prueba, rh_def="agua") is not False
    if "WRF" in which:
        # WRF 22 km (Mercator, cada 3 h hasta +120 h, lluvia acumulada desde el inicio, HR respecto del agua):
        # se muestrea a 0.2°, la misma malla que el ETA 22 km
        wrf_dir = os.path.join(INTERP, r"Datos\00\WRF\22Km")
        ok &= process("WRF", [(fh, os.path.join(wrf_dir, "WRFPRS_d01.%02d" % fh)) for fh in range(0, 121, 3)],
                      3, (278.6, 28, 0.2, -8.6, 28, 0.2), prueba, rh_def="agua") is not False
    sys.exit(0 if ok else 2)
