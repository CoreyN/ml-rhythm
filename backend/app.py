"""Litestar application entry point."""

from litestar import Litestar
from litestar.config.cors import CORSConfig

from api.routes import audio_ws_handler, health_check

cors_config = CORSConfig(
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app = Litestar(
    route_handlers=[audio_ws_handler, health_check],
    cors_config=cors_config,
)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
