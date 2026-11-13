# Local preview server for Blame the Stock (development only, never uploaded).
# Serves the project folder, and accepts POST /__save?path=site/assets/<name>.png
# so a page can save an image it drew (used to make the link-preview picture and icons).
import http.server, os, sys, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALLOWED = ('site/assets/', 'dev/out/')

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != '/__save':
            self.send_error(404); return
        rel = urllib.parse.parse_qs(u.query).get('path', [''])[0]
        rel = os.path.normpath(rel).replace('\\', '/')
        if rel.startswith('..') or not rel.startswith(ALLOWED) or not rel.endswith(('.png', '.svg', '.json', '.txt')):
            self.send_error(403, 'path not allowed'); return
        n = int(self.headers.get('Content-Length', '0'))
        if n <= 0 or n > 8_000_000:
            self.send_error(400, 'bad size'); return
        data = self.rfile.read(n)
        dest = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, 'wb') as f:
            f.write(data)
        self.send_response(200); self.send_header('Content-Type', 'text/plain'); self.end_headers()
        self.wfile.write(f'saved {rel} ({len(data)} bytes)'.encode())

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
