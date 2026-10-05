import json

from fastapi.testclient import TestClient

from app.config import settings
from app.main import create_app


def test_public_model_hosts_by_default():
    data = TestClient(create_app()).get("/api/v1/config").json()
    assert data == {"model_base_url": None, "models_available": []}


def test_self_hosted_mirror_is_served_and_advertised(tmp_path, monkeypatch):
    model = "Qwen2.5-1.5B-Instruct-q4f32_1-MLC"
    files = tmp_path / model / "resolve" / "main"
    files.mkdir(parents=True)
    (files / "mlc-chat-config.json").write_text('{"tokenizer_files": []}')
    (tmp_path / "libs").mkdir()
    (tmp_path / "libs" / "kernel.wasm").write_bytes(b"\0asm")
    (tmp_path / "manifest.json").write_text(json.dumps({"models": [{"id": model, "lib": "kernel.wasm"}]}))
    monkeypatch.setattr(settings, "MODELS_DIR", str(tmp_path))

    client = TestClient(create_app())
    assert client.get("/api/v1/config").json() == {"model_base_url": "/models", "models_available": [model]}
    assert client.get(f"/models/{model}/resolve/main/mlc-chat-config.json").json() == {"tokenizer_files": []}
    assert client.get("/models/libs/kernel.wasm").content == b"\0asm"
    for path in ("/models/..%2F..%2Fapp%2Fconfig.py", "/models/%2e%2e/%2e%2e/app/config.py"):
        assert "SECRET_KEY" not in client.get(path).text
