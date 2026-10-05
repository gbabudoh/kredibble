from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.routers import auth, document, metrics

STATIC_DIR = (Path(__file__).parent / "static").resolve()
REGISTRY_FILE = Path(__file__).parent / "registry" / "registry.json"

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(self)",
}


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.PROJECT_NAME,
        description="Kredibble API: authentication and optional document utilities. "
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

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        for name, value in SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        return response

    app.include_router(auth.router, prefix="/api/v1/auth", tags=["Authentication"])
    app.include_router(document.router, prefix="/api/v1/docs", tags=["Document Parsing"])
    app.include_router(metrics.router, prefix="/api/v1/metrics", tags=["Anonymous Metrics (opt-in)"])

    @app.get("/api/v1/registry")
    async def registry():
        """Schemas, checklists and router weights (non-sensitive config, also bundled in the web client)."""
        if not REGISTRY_FILE.is_file():
            return JSONResponse({"detail": "Registry not exported. Run: python -m app.registry.export"}, status_code=503)
        return FileResponse(REGISTRY_FILE, media_type="application/json", headers={"Cache-Control": "public, max-age=300"})

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
