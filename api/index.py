"""Vercel entry point: every non-static request is handled by Float's web server (floatapp/server.py).

vercel.json rewrites /<path>?<query> to /api/index?__path=/<path>&<query>; the handler restores the
original path before routing."""
import os
import sys
from urllib.parse import parse_qsl, urlencode, urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from floatapp.server import Handler  # noqa: E402


class handler(Handler):  # Vercel's Python runtime looks for a class named `handler`
    def _restore_path(self):
        url = urlparse(self.path)
        params = parse_qsl(url.query, keep_blank_values=True)
        original = [v for k, v in params if k == "__path"]
        if original:
            rest = [(k, v) for k, v in params if k != "__path"]
            self.path = (original[0] or "/") + ("?" + urlencode(rest) if rest else "")

    def do_GET(self):
        self._restore_path()
        super().do_GET()

    def do_POST(self):
        self._restore_path()
        super().do_POST()
