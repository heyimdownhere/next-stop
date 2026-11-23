"""Test-wide setup, run before any test module imports the app."""

import os

# Tests talk to the app as http://testserver, which the default host check
# (IP addresses, localhost, *.ts.net) would refuse. test_security.py checks
# the host check itself.
os.environ.setdefault("ALLOWED_HOSTS", "*")
# The shared app is hit by many tests in a row from one address; test_security.py
# checks the spam limit on its own apps.
os.environ.setdefault("CLIENT_REQUESTS_PER_MINUTE", "0")
