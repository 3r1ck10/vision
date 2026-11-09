@echo off
rem Actualiza la seccion Sudamerica del visor 3D (25N-60S, 150O-20O) a partir del GFS de
rem D:\interpgrads\Datos\00\GFS\27.5Km. Luego abre sudamerica.html.
setlocal
cd /d "%~dp0"
if not exist crudo_sa mkdir crudo_sa
set PY=D:\miniconda\python.exe
if not exist "%PY%" set PY=python

echo [1/4] GFS Sudamerica (1 grado, cada 6 h)
"%PY%" -I extraer_modelos.py GFS --sa || goto :error

echo [2/4] ECMWF Sudamerica (archivos locales Datos\00\ECMWF\27.5Km; si faltan, data.ecmwf.int)
set PYG=D:\miniconda\envs\grib\python.exe
if exist "%PYG%" (
  "%PYG%" -I ecmwf_abierto.py || echo    Aviso: no se pudo bajar el ECMWF, se mantiene el anterior.
) else (
  echo    Aviso: falta el entorno grib con ecCodes ^(ver LEEME.txt^); se omite el ECMWF.
)

echo [3/4] Relieve, imagen satelital y limites (solo la primera vez)
if not exist "crudo_sa\dem.json" "%PY%" -I dem_tiles.py --sa
if not exist "crudo_sa\satelite.jpg" "%PY%" -I satelite.py --sa
if not exist "crudo_sa\limites.json" "%PY%" -I limites_sa.py

echo [4/4] Empaquetando datos comprimidos para el navegador
"%PY%" -I empaquetar.py --sa || goto :error

echo.
echo Listo. Abriendo el visor de Sudamerica...
start "" "..\sudamerica.html"
goto :eof

:error
echo.
echo Hubo un error. Revisa el mensaje de arriba.
pause
