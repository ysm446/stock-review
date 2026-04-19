from http.server import BaseHTTPRequestHandler, HTTPServer
import json


class Handler(BaseHTTPRequestHandler):
    def _send(self, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send({"ok": True, "service": "stock-review-backend"})
            return
        if self.path == "/portfolio-template":
            self._send(
                {
                    "holdings": [{"ticker": "AAPL", "shares": 10, "price": 200}],
                    "watchlist": [{"ticker": "MSFT", "rating": "A"}],
                }
            )
            return
        self.send_error(404, "Not Found")


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", 8765), Handler)
    print("Mock backend listening on http://127.0.0.1:8765")
    server.serve_forever()
