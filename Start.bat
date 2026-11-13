@echo off
REM CreativeStudio AI Pro v2.0.0 — Start (Windows portable / dev)
REM Portable mein bundled node.exe aur bin\ffmpeg.exe use hote hain;
REM dev machine par system Node.js aur system FFmpeg use hote hain.
cd /d %~dp0
REM node.exe ko runtime\ folder mein chhupaya gaya hai taake ghalti se
REM us par click na ho (wo khud click karne par sirf Node.js REPL kholta hai).
if exist runtime\node.exe (
  set "NODE=runtime\node.exe"
) else if exist node.exe (
  set "NODE=node.exe"
) else (
  set "NODE=node"
)
if exist bin\ffmpeg.exe set "PATH=%~dp0bin;%PATH%"
if not exist node_modules (
  echo node_modules nahi mila — pehle npm install chalaiye.
  pause
  exit /b 1
)
echo CreativeStudio AI Pro chal raha hai: http://localhost:4820
echo Band karne ke liye is window mein Ctrl+C dabayein.
start "" http://localhost:4820
"%NODE%" server.js
