from pathlib import Path

import json

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.routers import account, auth, document, metrics, usage

STATIC_DIR = (Path(__file__).parent / "static").resolve()
REGISTRY_FILE = Path(__file__).parent / "registry" / "registry.json"

def content_security_policy(model_sources: list[str]) -> str:
    """Strict CSP: only this origin's scripts, no inline script or style, no eval (WebAssembly
    compilation only, which WebLLM needs), and network access limited to this server plus
    the configured model hosts, so injected content cannot load or send data elsewhere."""
    directives = {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'wasm-unsafe-eval'"],
        "worker-src": ["'self'"],
        "connect-src": ["'self'", *model_sources],
        "img-src": ["'self'", "data:"],
        "style-src": ["'self'"],
        "font-src": ["'self'"],
        "object-src": ["'none'"],
        "base-uri": ["'none'"],
        "form-action": ["'none'"],
        "frame-ancestors": ["'none'"],
    }
    return "; ".join(f"{name} {' '.join(values)}" for name, values in directives.items())


SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(self)",
    "Cross-Origin-Opener-Policy": "same-origin",
}


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.PROJECT_NAME,
        description="Kredibble API: accounts, authentication and optional document utilities. "
                    "LLM inference runs in the browser via WebLLM, not on this server.",
        version="1.1.0",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )

    csp = content_security_policy(settings.MODEL_SOURCES)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        for name, value in SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        response.headers.setdefault("Content-Security-Policy", csp)
        return response

    app.include_router(auth.router, prefix="/api/v1/auth", tags=["Authentication"])
    app.include_router(account.router, prefix="/api/v1/account", tags=["Accounts"])
    app.include_router(usage.router, prefix="/api/v1/usage", tags=["Usage limits"])
    app.include_router(document.router, prefix="/api/v1/docs", tags=["Document Parsing"])
    app.include_router(metrics.router, prefix="/api/v1/metrics", tags=["Anonymous Metrics (opt-in)"])

    @app.get("/api/v1/registry")
    async def registry():
        """Schemas, checklists and router weights (non-sensitive config, also bundled in the web client)."""
        if not REGISTRY_FILE.is_file():
            return JSONResponse({"detail": "Registry not exported. Run: python -m app.registry.export"}, status_code=503)
        return FileResponse(REGISTRY_FILE, media_type="application/json", headers={"Cache-Control": "public, max-age=300"})

    models_dir = Path(settings.MODELS_DIR).resolve() if settings.MODELS_DIR else None
    mirrored = []
    if models_dir and (models_dir / "manifest.json").is_file():
        mirrored = [m["id"] for m in json.loads((models_dir / "manifest.json").read_text(encoding="utf-8"))["models"]]
        app.mount("/models", StaticFiles(directory=models_dir), name="models")

    @app.get("/api/v1/config")
    async def client_config():
        """Tells the web client where to download models from (a self-hosted mirror, or public hosts)."""
        return {"model_base_url": "/models" if mirrored else None, "models_available": mirrored}

    @app.get("/api/v1/health")
    async def health_check():
        return {"status": "healthy", "platform": "Kredibble Core Engine", "inference": "client-side (WebLLM)"}

    if STATIC_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

        @app.get("/{full_path:path}", include_in_schema=False)
        async def serve_spa(full_path: str):
            if full_path.startswith("api/"):
                return JSONResponse({"detail": "Not Found"}, status_code=404)
            candidate = (STATIC_DIR / full_path).resolve()
            # Only serve files that are genuinely inside the static directory.
            if full_path and candidate.is_file() and candidate.is_relative_to(STATIC_DIR):
                return FileResponse(candidate)
            index = STATIC_DIR / "index.html"
            if index.is_file():
                return FileResponse(index)
            return JSONResponse({"status": "Kredibble API active. Frontend not built.", "docs": "/docs"})

    return app


app = create_app()

if __name__ == "__main__":
    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=settings.DEBUG)
