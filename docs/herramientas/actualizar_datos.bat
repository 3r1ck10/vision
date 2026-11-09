@echo off
rem Actualiza los datos del visor 3D a partir de las corridas descargadas en D:\interpgrads\Datos
rem (GFS, ETA y ECMWF 27.5Km). Luego abre index.html.
setlocal
cd /d "%~dp0"
if not exist crudo mkdir crudo
set PY=D:\miniconda\python.exe
if not exist "%PY%" set PY=python

echo [1/5] Puntos de pronostico (puntos_pronosticos.xlsx)
"%PY%" -I puntos.py "D:\interpgrads\puntos_pronosticos.xlsx" || goto :error

echo [2/5] GFS y ETA locales (puede tardar varios minutos)
"%PY%" -I extraer_modelos.py GFS ETA WRF || goto :error

echo [3/5] ECMWF desde los archivos locales Datos\00\ECMWF\27.5Km (o data.ecmwf.int si faltan pasos)
set PYG=D:\miniconda\envs\grib\python.exe
if exist "%PYG%" (
  "%PYG%" -I ecmwf_abierto.py --nor || echo    Aviso: no se pudo procesar ECMWF, se mantiene el anterior.
) else (
  echo    Aviso: falta el entorno grib con ecCodes ^(ver LEEME.txt^); se omite ECMWF.
)

echo [4/5] Relieve (solo la primera vez)
if not exist "crudo\dem.json" "%PY%" -I dem_tiles.py
if not exist "crudo\satelite.jpg" "%PY%" -I satelite.py
if not exist "crudo\limites.json" "%PY%" -I limites.py

echo [5/5] Empaquetando datos comprimidos para el navegador
"%PY%" -I empaquetar.py || goto :error

echo.
echo Listo. Abriendo el visor...
start "" "..\index.html"
goto :eof

:error
echo.
echo Hubo un error. Revisa el mensaje de arriba.
pause
