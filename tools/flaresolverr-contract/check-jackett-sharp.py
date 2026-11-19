#!/usr/bin/env python3
"""Exercise Jackett's pinned FlareSolverrSharp handler against a disposable bridge."""
import argparse
import http.server
import subprocess
import threading
from pathlib import Path


class Fixture(http.server.BaseHTTPRequestHandler):
    requests = []
    lock = threading.Lock()

    def log_message(self, *_args):
        pass

    def do_GET(self):
        cookie = self.headers.get('Cookie', '')
        user_agent = self.headers.get('User-Agent', '')
        with self.lock:
            self.requests.append((self.path, cookie, user_agent))
        if self.path in ('/datadome-only/', '/datadome-passive/'):
            body = b'<html><title>Ready</title><body>DataDome fixture</body></html>'
            self.send_response_only(403)
            self.send_header('Server', 'datadome')
            self.send_header('x-dd-b' if self.path == '/datadome-only/' else 'x-datadome', '1')
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == '/datadome-device/':
            allowed = 'datadome=fixture-clearance' in cookie
            body = (b'<html><title>Ready</title><body>jackett retry reached</body></html>' if allowed else
                    b'<html><title>Ready</title><body><script>var dd={"rt":"i","host":"geo.captcha-delivery.com"};'
                    b'setTimeout(() => {document.cookie="datadome=fixture-clearance; path=/";},100);'
                    b'</script></body></html>')
            self.send_response_only(200 if allowed else 403)
            self.send_header('Server', 'datadome')
            if not allowed:
                self.send_header('x-dd-b', '1')
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('X-Fixture-UA', user_agent)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        allowed = 'cf_clearance=fixture-clearance' in cookie
        if self.path == '/wrong-cookie/':
            body = (b'<html><title>Just a moment...</title><body><script>'
                    b'setTimeout(() => { document.cookie="ordinary=not-clearance; path=/"; '
                    b'document.title="Ready"; }, 100)</script></body></html>')
        elif self.path == '/no-clearance/':
            body = (b'<html><title>Just a moment...</title><body><script>'
                    b'setTimeout(() => { document.title="Ready"; }, 100)</script></body></html>')
        elif self.path == '/datadome-cookie/':
            body = (b'<html><title>Just a moment...</title><body><script>'
                    b'setTimeout(() => { document.cookie="datadome=fixture; path=/"; '
                    b'document.title="Ready"; }, 100)</script></body></html>')
        elif allowed:
            body = b'<html><title>Ready</title><body>jackett retry reached</body></html>'
        else:
            body = (b'<html><title>Just a moment...</title><body><script>'
                    b'setTimeout(() => { document.cookie="cf_clearance=fixture-clearance; path=/"; '
                    b'location.reload(); }, 100)</script></body></html>')
        self.send_response(200 if allowed else 503)
        self.send_header('Server', 'cloudflare')
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Fixture-UA', user_agent)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bridge', default='http://127.0.0.1:8191/')
    parser.add_argument('--dotnet', default='dotnet')
    parser.add_argument('--patched-project', type=Path, help='run against a disposable project referencing the patched package')
    args = parser.parse_args()
    fixture = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    fixture.daemon_threads = True
    thread = threading.Thread(target=fixture.serve_forever, daemon=True)
    thread.start()
    project = args.patched_project or Path(__file__).parent / 'jackett-sharp' / 'JackettSharpContract.csproj'
    target = f'http://127.0.0.1:{fixture.server_port}/search/fixture/'
    try:
        subprocess.run([args.dotnet, 'run', '--project', str(project), '--', args.bridge, target], check=True, timeout=90)
        with Fixture.lock:
            requests = list(Fixture.requests)
        if len(requests) < 3 or 'cf_clearance=' in requests[0][1] or 'cf_clearance=fixture-clearance' not in requests[-1][1]:
            raise AssertionError(f'Expected challenge, browser visit, and clearance retry; got {requests!r}')
        if requests[0][2] != 'Jackett-fixture/1.0' or not requests[-1][2].startswith('Mozilla/'):
            raise AssertionError(f'Expected UA handoff; got {requests!r}')
        no_clearance = f'http://127.0.0.1:{fixture.server_port}/no-clearance/'
        subprocess.run([args.dotnet, 'run', '--project', str(project), '--', args.bridge,
                        no_clearance, 'expect-empty'], check=True, timeout=90)
        with Fixture.lock:
            no_clearance_requests = [entry for entry in Fixture.requests if entry[0] == '/no-clearance/']
        if len(no_clearance_requests) != 2:
            raise AssertionError(f'Expected original request and browser visit, without retry; got {no_clearance_requests!r}')
        wrong_cookie = f'http://127.0.0.1:{fixture.server_port}/wrong-cookie/'
        subprocess.run([args.dotnet, 'run', '--project', str(project), '--', args.bridge,
                        wrong_cookie, 'expect-invalid'], check=True, timeout=90)
        with Fixture.lock:
            wrong_cookie_requests = [entry for entry in Fixture.requests if entry[0] == '/wrong-cookie/']
        if len(wrong_cookie_requests) < 3 or 'ordinary=' in wrong_cookie_requests[-1][1]:
            raise AssertionError(f'Expected retry without ordinary cookie; got {wrong_cookie_requests!r}')
        datadome_cookie = f'http://127.0.0.1:{fixture.server_port}/datadome-cookie/'
        subprocess.run([args.dotnet, 'run', '--project', str(project), '--', args.bridge,
                        datadome_cookie, 'expect-invalid'], check=True, timeout=90)
        with Fixture.lock:
            datadome_cookie_requests = [entry for entry in Fixture.requests if entry[0] == '/datadome-cookie/']
        if len(datadome_cookie_requests) < 3:
            raise AssertionError(f'Expected a challenge, browser visit, and retry; got {datadome_cookie_requests!r}')
        has_datadome = 'datadome=fixture' in datadome_cookie_requests[-1][1]
        if has_datadome != bool(args.patched_project):
            raise AssertionError(f'Unexpected DataDome cookie in retry; got {datadome_cookie_requests!r}')
        datadome_only = f'http://127.0.0.1:{fixture.server_port}/datadome-passive/' if args.patched_project else f'http://127.0.0.1:{fixture.server_port}/datadome-only/'
        subprocess.run([args.dotnet, 'run', '--project', str(project), '--', args.bridge,
                        datadome_only, 'expect-unhandled'], check=True, timeout=90)
        with Fixture.lock:
            path = '/datadome-passive/' if args.patched_project else '/datadome-only/'
            datadome_only_requests = [entry for entry in Fixture.requests if entry[0] == path]
        if len(datadome_only_requests) != 1:
            raise AssertionError(f'Expected only the original request, without a bridge visit; got {datadome_only_requests!r}')
        if args.patched_project:
            unresolved = f'http://127.0.0.1:{fixture.server_port}/datadome-only/'
            subprocess.run([args.dotnet, 'run', '--project', str(project), '--', args.bridge,
                            unresolved, 'expect-datadome-timeout'], check=True, timeout=90)
            with Fixture.lock:
                unresolved_requests = [entry for entry in Fixture.requests if entry[0] == '/datadome-only/']
            if len(unresolved_requests) != 2:
                raise AssertionError(f'Expected original request and browser visit, without retry; got {unresolved_requests!r}')
            datadome_device = f'http://127.0.0.1:{fixture.server_port}/datadome-device/'
            subprocess.run([args.dotnet, 'run', '--project', str(project), '--', args.bridge,
                            datadome_device, 'expect-datadome'], check=True, timeout=90)
            with Fixture.lock:
                requests = [entry for entry in Fixture.requests if entry[0] == '/datadome-device/']
            if len(requests) < 3 or 'datadome=' in requests[0][1] or 'datadome=fixture-clearance' not in requests[-1][1]:
                raise AssertionError(f'Expected DataDome challenge, browser visit, and cookie retry; got {requests!r}')
    finally:
        fixture.shutdown()
        fixture.server_close()
        thread.join()


if __name__ == '__main__':
    main()
