#!/usr/bin/env python3
"""Run behavioral checks against a FlareSolverr-compatible /v1 endpoint.

The fixture must be reachable by the bridge, not just by this process.
"""
import argparse
import ast
import concurrent.futures
import html
import http.client
import http.server
import json
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlsplit


class Fixture(http.server.BaseHTTPRequestHandler):
    media_hits = 0

    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == '/slow':
            time.sleep(3)
        if self.path == '/challenge':
            body = b'<html><head><title>Just a moment...</title></head><body></body></html>'
        elif self.path == '/denied':
            body = b'<html><head><title>Access denied</title></head><body></body></html>'
        elif self.path == '/media':
            body = b'<html><body><img src="/image.png"></body></html>'
        elif self.path == '/image.png':
            type(self).media_hits += 1
            body = b'not a real image'
        else:
            body = '<html><body>cookie={}; header={}; proxy={}</body></html>'.format(
                html.escape(self.headers.get('Cookie', '')),
                html.escape(self.headers.get('X-Bridge-Test', '')),
                html.escape(self.headers.get('X-Bridge-Proxy', '')),
            ).encode()
        self.send_response(418 if self.path == '/status' else 200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        if self.path == '/set':
            self.send_header('Set-Cookie', 'bridge_session=retained; Path=/; HttpOnly')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        payload = self.rfile.read(int(self.headers.get('Content-Length', '0'))).decode()
        body = ('<html><body>post=' + html.escape(payload) + '; content-type=' +
                html.escape(self.headers.get('Content-Type', '')) + '</body></html>').encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(body)


class Response:
    def __init__(self, data):
        self.data = data

    def json(self):
        return self.data


class FixtureProxy(http.server.BaseHTTPRequestHandler):
    """Forward only the test fixture, and mark requests that reached the proxy."""
    fixture_host = ''
    fixture_port = 0

    def log_message(self, *_args):
        pass

    def do_GET(self):
        target = urlsplit(self.path)
        if target.scheme != 'http' or target.hostname != self.fixture_host or target.port != self.fixture_port:
            self.send_error(403)
            return
        conn = http.client.HTTPConnection('127.0.0.1', self.fixture_port, timeout=10)
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in ('proxy-authorization', 'proxy-connection', 'connection')}
        headers['X-Bridge-Proxy'] = 'reached'
        try:
            conn.request('GET', target.path or '/', headers=headers)
            response = conn.getresponse()
            body = response.read()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in ('connection', 'transfer-encoding', 'server', 'date'):
                    self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)
        finally:
            conn.close()


def call(endpoint, payload, timeout=30):
    request = urllib.request.Request(endpoint, json.dumps(payload).encode(),
                                     {'Content-Type': 'application/json'}, method='POST')
    # Ignore host proxy settings when contacting the local bridge.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        return json.load(error)


def plugin_functions(path, endpoint):
    """Compile the actual pinned plugin helpers with only their required globals."""
    with open(path, encoding='utf-8') as source:
        tree = ast.parse(source.read(), filename=path)
    names = {'_proxy_param', '_merge_solution_cookies', 'fs_call', 'fs_create_session',
             'fs_destroy_session', 'fs_get'}
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    if {node.name for node in functions} != names:
        raise ValueError('plugin helper functions differ from the pinned version')

    class Requests:
        @staticmethod
        def post(url, json, timeout):
            return Response(call(url, json, timeout))

    namespace = {'requests': Requests, '_proxy_url_cache': '', '_fs_user_agents': {},
                 'FS_URL_TEMPLATE': '{flaresolverr_url}', '_get_fs_url': lambda: endpoint}
    module = ast.fix_missing_locations(ast.Module(body=functions, type_ignores=[]))
    exec(compile(module, path, 'exec'), namespace)
    return namespace


class Contract(unittest.TestCase):
    endpoint = ''
    fixture = ''
    plugin = None
    proxy = None

    def api(self, **payload):
        return call(self.endpoint, payload)

    def ok(self, **payload):
        result = self.api(**payload)
        self.assertEqual(result.get('status'), 'ok', result)
        return result

    def session(self):
        result = self.ok(cmd='sessions.create')
        session = result.get('session')
        self.assertIsInstance(session, str)
        self.assertTrue(session)
        self.addCleanup(lambda: self.api(cmd='sessions.destroy', session=session))
        return session

    def test_lifecycle(self):
        sid = self.session()
        self.assertIn(sid, self.ok(cmd='sessions.list')['sessions'])
        self.ok(cmd='sessions.destroy', session=sid)
        self.assertNotIn(sid, self.ok(cmd='sessions.list')['sessions'])
        self.assertEqual(self.api(cmd='sessions.destroy', session=sid).get('status'), 'error')

    def test_concurrent_create_and_session_isolation(self):
        sid = 'contract_' + uuid.uuid4().hex
        self.addCleanup(lambda: self.api(cmd='sessions.destroy', session=sid))
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.api(cmd='sessions.create', session=sid), range(2)))
        for result in results:
            self.assertEqual(result.get('status'), 'ok', result)
            self.assertEqual(result.get('session'), sid)
        other = self.session()
        self.ok(cmd='request.get', session=other, url=self.fixture + '/set')
        self.ok(cmd='sessions.destroy', session=sid)
        result = self.ok(cmd='request.get', session=other, url=self.fixture + '/echo')
        self.assertIn('bridge_session=retained', html.unescape(result['solution']['response']))

    def test_sessions_keep_cookies_and_are_isolated(self):
        first, second = self.session(), self.session()
        solution = self.ok(cmd='request.get', session=first, url=self.fixture + '/set')['solution']
        self.assertTrue(any(c.get('name') == 'bridge_session' and c.get('value') == 'retained'
                            for c in solution['cookies']))
        a = self.ok(cmd='request.get', session=first, url=self.fixture + '/echo')['solution']['response']
        b = self.ok(cmd='request.get', session=second, url=self.fixture + '/echo')['solution']['response']
        self.assertIn('bridge_session=retained', html.unescape(a))
        self.assertNotIn('bridge_session=retained', html.unescape(b))

    def test_moviepilot_helpers(self):
        fs = self.plugin
        sid = fs['fs_create_session']()
        self.assertTrue(sid)
        self.addCleanup(fs['fs_destroy_session'], sid)
        host = urlsplit(self.fixture).hostname
        cookies = [{'name': 'mp_cookie', 'value': 'mp_value', 'domain': host, 'path': '/'}]
        body = html.unescape(fs['fs_get'](sid, self.fixture + '/set', cookies,
                                         headers={'X-Bridge-Test': 'moviepilot'}))
        self.assertIn('mp_cookie=mp_value', body)
        self.assertIn('moviepilot', body)
        self.assertTrue(any(c.get('name') == 'bridge_session' for c in cookies), cookies)
        self.assertTrue(fs['_fs_user_agents'].get(sid), 'plugin requires returned userAgent')
        fs['fs_destroy_session'](sid)
        self.assertNotIn(sid, self.ok(cmd='sessions.list')['sessions'])

    def test_post_and_status(self):
        sid = self.session()
        result = self.ok(cmd='request.post', session=sid, url=self.fixture + '/post',
                         postData='answer=hello%20world&n=1')['solution']
        response = html.unescape(result['response'])
        self.assertIn('post=answer=hello%20world&n=1', response)
        self.assertIn('application/x-www-form-urlencoded', response)
        result = self.ok(cmd='request.get', session=sid, url=self.fixture + '/status')['solution']
        self.assertEqual(result['status'], 418)

    def test_return_only_cookies(self):
        result = self.ok(cmd='request.get', url=self.fixture + '/set', returnOnlyCookies=True)['solution']
        self.assertTrue(any(c.get('name') == 'bridge_session' for c in result['cookies']))
        self.assertFalse(result.get('response'))

    def test_session_ttl_wait_and_screenshot(self):
        sid = self.session()
        self.ok(cmd='request.get', session=sid, url=self.fixture + '/set')
        time.sleep(0.15)
        start = time.monotonic()
        result = self.ok(cmd='request.get', session=sid, url=self.fixture + '/echo',
                         session_ttl_minutes=0.001, waitInSeconds=0.2, returnScreenshot=True)['solution']
        self.assertGreaterEqual(time.monotonic() - start, 0.18)
        self.assertNotIn('bridge_session=retained', html.unescape(result['response']))
        self.assertTrue(result.get('screenshot', '').startswith('iVBOR'), 'expected PNG screenshot')

    def test_disable_media(self):
        before = Fixture.media_hits
        self.ok(cmd='request.get', url=self.fixture + '/media')
        self.assertGreater(Fixture.media_hits, before, 'fixture image was not loaded in the control request')
        before = Fixture.media_hits
        self.ok(cmd='request.get', url=self.fixture + '/media', disableMedia=True)
        self.assertEqual(Fixture.media_hits, before, 'image loaded despite disableMedia')

    def test_moviepilot_proxy(self):
        if not self.proxy:
            self.skipTest('use --test-proxy and a non-loopback fixture host reachable by the bridge')
        fs = self.plugin
        fs['_proxy_url_cache'] = self.proxy
        self.addCleanup(fs.__setitem__, '_proxy_url_cache', '')
        sid = fs['fs_create_session']()
        self.assertTrue(sid, 'session creation with proxy failed')
        self.addCleanup(fs['fs_destroy_session'], sid)
        body = html.unescape(fs['fs_get'](sid, self.fixture + '/echo', []))
        self.assertIn('proxy=reached', body, 'request did not reach the configured proxy')
        time.sleep(0.15)
        result = self.ok(cmd='request.get', session=sid, session_ttl_minutes=0.001,
                         url=self.fixture + '/echo')['solution']
        self.assertIn('proxy=reached', html.unescape(result['response']), 'session rotation lost its proxy')

    def test_invalid_command_and_timeout(self):
        self.assertEqual(self.api(cmd='invalid.command').get('status'), 'error')
        start = time.monotonic()
        result = self.api(cmd='request.get', url=self.fixture + '/slow', maxTimeout=500)
        self.assertEqual(result.get('status'), 'error', result)
        self.assertLess(time.monotonic() - start, 10)

    def test_detects_challenge_and_denied(self):
        for path in ('/challenge', '/denied'):
            result = self.api(cmd='request.get', url=self.fixture + path, maxTimeout=1000)
            self.assertEqual(result.get('status'), 'error', result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--endpoint', required=True, help='bridge /v1 URL')
    parser.add_argument('--moviepilot-source', required=True, help='pinned sehuatangsignin/captcha_server.py')
    parser.add_argument('--listen', default='127.0.0.1', help='fixture bind address')
    parser.add_argument('--fixture-host', default='127.0.0.1', help='fixture address reachable by bridge')
    parser.add_argument('--fixture-port', type=int, default=0)
    parser.add_argument('--test-proxy', action='store_true', help='also start a fixture-only HTTP proxy')
    args = parser.parse_args()
    server = http.server.ThreadingHTTPServer((args.listen, args.fixture_port), Fixture)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    Contract.endpoint = args.endpoint
    Contract.fixture = f'http://{args.fixture_host}:{server.server_port}'
    Contract.plugin = plugin_functions(args.moviepilot_source, args.endpoint)
    proxy_server = None
    if args.test_proxy:
        FixtureProxy.fixture_host = args.fixture_host
        FixtureProxy.fixture_port = server.server_port
        proxy_server = http.server.ThreadingHTTPServer((args.listen, 0), FixtureProxy)
        proxy_server.daemon_threads = True
        threading.Thread(target=proxy_server.serve_forever, daemon=True).start()
        Contract.proxy = f'http://{args.fixture_host}:{proxy_server.server_port}'
    try:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(Contract)
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        return 0 if result.wasSuccessful() else 1
    finally:
        if proxy_server:
            proxy_server.shutdown()
            proxy_server.server_close()
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    raise SystemExit(main())
