"""Test-wide setup, run before any test module imports the app."""

import os

# Tests talk to the app as http://testserver, which the default host check
# (IP addresses, localhost, *.ts.net) would refuse. test_security.py checks
# the host check itself.
os.environ.setdefault("ALLOWED_HOSTS", "*")
