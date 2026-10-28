"""
test_sandbox.py -- imported FIRST by the test files (GCS-FIX-8).

Redirects the flight CSV and the command-audit CSV to a temporary folder for the lifetime of
the test process, so running the tests can never touch the real files in logs/.
"""
import atexit
import shutil
import tempfile
from pathlib import Path

import csv_logger as _csv_module          # the module (csv_logger.csv_logger is the instance)

_TMP = Path(tempfile.mkdtemp(prefix="gcs_test_"))
atexit.register(shutil.rmtree, _TMP, ignore_errors=True)

_csv_module.csv_logger.path = _TMP / _csv_module.CSV_PATH.name
_csv_module.COMMAND_AUDIT_PATH = _TMP / _csv_module.COMMAND_AUDIT_PATH.name

assert _csv_module.csv_logger.path.parent == _TMP, "test sandbox failed to redirect the flight CSV"
assert _csv_module.COMMAND_AUDIT_PATH.parent == _TMP, "test sandbox failed to redirect the audit CSV"
