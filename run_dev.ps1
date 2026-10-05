# Kredibble local development launcher (Windows PowerShell)
$ErrorActionPreference = "Stop"
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host " Kredibble - local development" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Cyan

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js/npm is required to build the web client (https://nodejs.org)." -ForegroundColor Red
    exit 1
}

Write-Host "[1/2] Building web client..." -ForegroundColor Cyan
Push-Location "$PSScriptRoot\frontend"
try {
    if (-not (Test-Path node_modules)) { npm install }
    npm run build
} finally {
    Pop-Location
}

# DEBUG=true allows an ephemeral SECRET_KEY for local work only.
$env:DEBUG = "true"
$env:PYTHONPATH = "$PSScriptRoot\backend"

Write-Host "[2/2] Starting API on http://127.0.0.1:8000" -ForegroundColor Cyan
Write-Host "App:      http://127.0.0.1:8000" -ForegroundColor Yellow
Write-Host "API docs: http://127.0.0.1:8000/docs" -ForegroundColor Yellow
Write-Host "Tip: for hot reload of the UI, run 'npm run dev' in frontend/ and open http://localhost:5173/static/" -ForegroundColor DarkGray

python -m uvicorn app.main:app --app-dir "$PSScriptRoot\backend" --host 127.0.0.1 --port 8000 --reload
