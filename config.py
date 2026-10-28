"""
config.py
----------
Central configuration file for the Ground Control Station backend.

All configurable values should be placed here.
Other modules must import values from this file instead of hardcoding them.
"""

import os
from pathlib import Path

# GCS-FIX-9: deployment settings come from the environment (unset = previous behaviour).
_origins = [o.strip() for o in os.environ.get("GCS_ALLOWED_ORIGINS", "*").split(",") if o.strip()]
CORS_ORIGINS = "*" if (not _origins or "*" in _origins) else _origins

# =============================================================================
# PROJECT INFORMATION
# =============================================================================

PROJECT_NAME = "IN-SPACe Ground Control Station"

# Official team ID, exactly as the rocket firmware transmits it.
TEAM_ID = "2026 IN-SPACe-045"
# Only packets carrying exactly this team ID are accepted.
ALLOWED_TEAM_IDS = {TEAM_ID}

VERSION = "1.0.0"

DEBUG = False  # GCS-FIX-7


# =============================================================================
# SERVER CONFIGURATION
# =============================================================================

HOST = "127.0.0.1"  # GCS-FIX-7: this PC only (use 0.0.0.0 to allow other devices)

PORT = 5000

SECRET_KEY = os.environ.get("GCS_SECRET_KEY", "julyfeb11")


# =============================================================================
# SOCKET.IO
# =============================================================================

SOCKET_ASYNC_MODE = "threading"

SOCKET_CORS = CORS_ORIGINS


# =============================================================================
# SERIAL COMMUNICATION
# =============================================================================

DEFAULT_BAUDRATE = 9600

SERIAL_TIMEOUT = 1

AUTO_RECONNECT = True

RECONNECT_INTERVAL = 3


# =============================================================================
# TELEMETRY
# =============================================================================

MAX_HISTORY_POINTS = 1000



WEBSOCKET_UPDATE_RATE = 10

# Sanity limits for incoming telemetry (packets outside are rejected).
# Barometric altitude can read wildly off if the flight computer's sea-level
# reference is wrong, so the lower bound is generous.
ALTITUDE_MIN_M = -5000.0



# =============================================================================
# LOGGING
# =============================================================================

LOG_LEVEL = "INFO"

LOG_DIRECTORY = Path("logs")

CSV_DIRECTORY = LOG_DIRECTORY / "csv"

SYSTEM_LOG = LOG_DIRECTORY / "backend.log"


# =============================================================================
# CSV FILE SETTINGS
# =============================================================================

CSV_FILE_PREFIX = "Flight"

# Telemetry log file name = Flight_<TEAM_ID>.csv  (Annexure 2, section II).
# The organisers' <TEAM_ID> is the full ID, so by default the file is
# "Flight_2026 IN-SPACe-045.csv". If they want only the number, set this to "045".
CSV_TEAM_NAME = TEAM_ID

CSV_FILE_EXTENSION = ".csv"


# =============================================================================
# COMMAND SETTINGS
# =============================================================================

COMMAND_TIMEOUT = 2

COMMAND_RETRY_COUNT = 3


# =============================================================================
# DIRECTORIES
# =============================================================================

LOG_DIRECTORY.mkdir(exist_ok=True)

CSV_DIRECTORY.mkdir(exist_ok=True)


# =============================================================================
# MACHINE LEARNING - TERRAIN CLASSIFICATION
# =============================================================================
# INT8-quantized TFLite model for 6-class terrain classification.
# Path to the trained .tflite file (place it inside the models/ folder).

MODELS_DIRECTORY = Path("models")
MODELS_DIRECTORY.mkdir(exist_ok=True)

TERRAIN_MODEL_PATH = MODELS_DIRECTORY / "terrain_model_int8.tflite"

TERRAIN_IMAGE_SIZE = 224

# Class list for the model's outputs (a .tflite file does not embed class names).
# IMPORTANT: this order MUST exactly match the training class order
# (alphabetical dataset subfolders) -- otherwise predictions will silently
# point at the wrong label.
TERRAIN_CLASS_NAMES = [
    "barren",
    "building",
    "grass",
    "road",
    "vegetation",
    "water",
]

# Max upload size accepted for a single inference frame (bytes).
TERRAIN_MAX_UPLOAD_BYTES = 8 * 1024 * 1024  # 8 MB