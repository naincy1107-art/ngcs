"""
wsgi.py -- production entry point for Render / gunicorn:   gunicorn wsgi:app
(On your laptop keep using:  python app.py)

Must run with ONE worker: telemetry and Socket.IO state live in this process's memory.
"""
from app import app, socketio  # noqa: F401  (socketio is attached to app)
from telemetry_store import telemetry_store
from websocket_manager import websocket_manager

telemetry_store.reset()        # same as start_backend() in app.py
websocket_manager.start()      # live broadcast thread
