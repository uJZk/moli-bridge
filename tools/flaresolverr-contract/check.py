#!/usr/bin/env python3
"""Run behavioral checks against a FlareSolverr-compatible /v1 endpoint.

The fixture must be reachable by the bridge, not just by this process.
"""
import argparse
import ast
import base64
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
    post_counts = {}
    clearance_hits = {}
    unsafe_hits = 0
    slow_image_hits = 0
    direct_echo_hits = 0

    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == '/echo' and self.headers.get('X-Bridge-Proxy') != 'reached':
            type(self).direct_echo_hits += 1
        if self.path == '/slow-image':
            type(self).slow_image_hits += 1
        if self.path == '/normal-reload':
            reloaded = 'reload_seen=yes' in self.headers.get('Cookie', '')
            self.send_response(201 if reloaded else 200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Set-Cookie', 'reload_seen=yes; Path=/')
            if reloaded:
                self.send_header('X-Reload-Final', 'yes')
            self.end_headers()
            self.wfile.write(b'<title>Ready</title><body>reload final</body>' if reloaded else
                             b'<title>Ready</title><script>setTimeout(() => location.reload(), 350)</script>')
            return
        if self.path in ('/slow', '/slow-image'):
            time.sleep(3)
        if self.path == '/challenge':
            body = b'<html><head><title>Just a moment...</title></head><body></body></html>'
        elif self.path in ('/header-cf', '/header-aws-challenge', '/header-aws-captcha', '/header-ordinary'):
            body = b'<html><title>Working</title><body>header-only fixture</body></html>'
        elif self.path == '/header-cf-redirect':
            body = (b'<html><title>Working</title><body>'
                    b'<script>setTimeout(() => location.href="/redirect-final", 100)</script></body></html>')
        elif self.path in ('/cf-clearance-recovery', '/cf-clearance-stale'):
            type(self).clearance_hits[self.path] = type(self).clearance_hits.get(self.path, 0) + 1
            if self.path == '/cf-clearance-recovery' and 'cf_clearance=fresh' in self.headers.get('Cookie', ''):
                body = b'<html><title>Ready</title><body>clearance recovery succeeded</body></html>'
            else:
                script = (b'<script>setTimeout(() => { document.cookie="cf_clearance=fresh; path=/"; }, 100)</script>'
                          if self.path == '/cf-clearance-recovery' else b'')
                body = b'<html><title>Just a moment...</title><body>' + script + b'</body></html>'
        elif self.path == '/anubis-transient':
            body = (b'<html><head><title>Ready</title></head><body>'
                    b'<script id="anubis_challenge" type="application/json">'
                    b'{"rules":{"algorithm":"fast"},"challenge":{"id":"a","randomData":"b"}}</script>'
                    b'<script>setTimeout(() => {document.getElementById("anubis_challenge").remove();'
                    b'document.body.append(" challenge cleared");}, 500)</script>'
                    b'</body></html>')
        elif self.path in ('/ddos-clearance-recovery', '/ddos-clearance-stale'):
            type(self).clearance_hits[self.path] = type(self).clearance_hits.get(self.path, 0) + 1
            if self.path == '/ddos-clearance-recovery' and '__ddg2_fixture=fresh' in self.headers.get('Cookie', ''):
                body = b'<html><title>Ready</title><body>ddos clearance recovered</body></html>'
            else:
                script = (b'<script>setTimeout(() => {document.cookie="__ddg2_fixture=fresh; path=/";}, 100)</script>'
                          if self.path == '/ddos-clearance-recovery' else b'')
                body = b'<html><title>Please wait</title><h1 id="ddg-l10n-title">Checking</h1>' + script + b'</html>'
        elif self.path in ('/ddos-guard-wall', '/ddos-guard-transient', '/ddos-guard-ordinary'):
            if self.path == '/ddos-guard-ordinary':
                body = b'<html><title>Ready</title><p>Protected by ddos-guard.net</p></html>'
            else:
                clear = (b'<script>setTimeout(() => {document.getElementById("ddg-l10n-title").remove();'
                         b'document.body.append(" challenge cleared");}, 500)</script>'
                         if self.path == '/ddos-guard-transient' else b'')
                body = b'<html><title>Ready</title><body><h1 id="ddg-l10n-title">Checking</h1>' + clear + b'</body></html>'
        elif self.path == '/challenge-nav-failure':
            body = (b'<html><head><title>Just a moment...</title></head><body>'
                    b'<script>setTimeout(() => location.href = "http://127.0.0.1:1/", 100)</script></body></html>')
        elif self.path == '/turnstile-iframe':
            body = (b'<html><head><title>Ready</title></head><body>'
                    b'<input type="hidden" name="cf-turnstile-response" value="">'
                    b'<iframe src="/cdn-cgi/challenge-platform/shadow"></iframe>'
                    b'<script>window.addEventListener("message", (event) => {'
                    b'if (event.data === "fixture-verified") {'
                    b'document.querySelector("input").value="iframe-token";'
                    b'document.querySelector("iframe").remove(); } });</script></body></html>')
        elif self.path == '/turnstile-generic':
            body = (b'<html><head><title>Ready</title></head><body>'
                    b'<input type="hidden" name="csrf" tabindex="4">'
                    b'<input type="hidden" name="cf-turnstile-response" value="">'
                    b'<button id="first" onclick="document.querySelector(\'[name=cf-turnstile-response]\').value=\'wrong\'">First</button>'
                    b'<button id="second" onclick="document.querySelector(\'[name=cf-turnstile-response]\').value=\'generic-token\'">Verify</button>'
                    b'</body></html>')
        elif self.path in ('/turnstile-fixture', '/turnstile-unresolved'):
            action = ('document.querySelector("input").value="fixture-token"'
                      if self.path == '/turnstile-fixture' else 'void(0)')
            body = (f'<html><head><title>Ready</title></head><body>'
                    f'<input type="hidden" name="cf-turnstile-response" value="">'
                    f'<input type="button" value="Verify you are human" onclick="{html.escape(action, quote=True)}"></body></html>' ).encode()
        elif self.path == '/challenge-unrelated-iframe':
            body = (b'<html><title>Just a moment...</title><body>'
                    b'<iframe src="/unrelated-frame"></iframe></body></html>')
        elif self.path == '/unrelated-frame':
            body = (b'<html><body><input type="checkbox" '
                    b'onclick="fetch(&quot;/unsafe-hit&quot;)"></body></html>')
        elif self.path == '/unsafe-hit':
            type(self).unsafe_hits += 1
            body = b'ok'
        elif self.path in ('/challenge-iframe', '/challenge-shadow-iframe'):
            frame = 'shadow' if self.path == '/challenge-shadow-iframe' else 'fixture'
            body = (b'<html><head><title>Just a moment...</title></head><body>'
                    + f'<iframe src="/cdn-cgi/challenge-platform/{frame}"></iframe>'.encode()
                    + b'<script>window.addEventListener("message", (event) => {'
                    b'if (event.data === "fixture-verified") { document.title="Ready"; '
                    b'document.querySelector("iframe").remove(); document.body.append(" iframe verified"); }'
                    b'});</script></body></html>')
        elif self.path == '/cdn-cgi/challenge-platform/fixture':
            body = (b'<html><body><label>Verify '
                    b'<input type="checkbox" onclick="parent.postMessage(&quot;fixture-verified&quot;,&quot;*&quot;)">'
                    b'</label></body></html>')
        elif self.path == '/cdn-cgi/challenge-platform/shadow':
            body = (b'<html><body><div id="host"></div><script>'
                    b'const root=document.getElementById("host").attachShadow({mode:"open"});'
                    b'root.innerHTML="<input type=checkbox>";'
                    b'root.querySelector("input").addEventListener("click",'
                    b'()=>parent.postMessage("fixture-verified","*"));'
                    b'</script></body></html>')
        elif self.path == '/challenge-verify':
            body = (b'<html><head><title>Just a moment...</title></head><body>'
                    b'<input type=\"button\" value=\"Verify you are human\" '
                    b'onclick=\"document.title=&quot;Ready&quot;; this.remove(); '
                    b'document.body.append(&quot;verification clicked&quot;)\">'
                    b'</body></html>')
        elif self.path == '/challenge-redirect':
            body = (b'<html><head><title>Just a moment...</title></head><body>'
                    b'<script>setTimeout(() => location.href = \"/redirect-final\", 100)</script></body></html>')
        elif self.path == '/normal-redirect':
            body = (b'<html><head><title>Ready</title></head><body>initial document'
                    b'<script>setTimeout(() => location.href = \"/redirect-final\", 350)</script></body></html>')
        elif self.path == '/normal-late-redirect':
            body = (b'<html><head><title>Ready</title></head><body>initial document'
                    b'<script>setTimeout(() => location.href = \"/redirect-final\", 1000)</script></body></html>')
        elif self.path == '/meta-refresh-injected':
            body = (b'<html><title>Ready</title><script>setTimeout(() => {'
                    b'const m = document.createElement("meta"); m.httpEquiv = "refresh";'
                    b'm.content = "1;url=/redirect-final"; document.head.append(m); }, 300)</script>'
                    b'<body>intermediate</body></html>')
        elif self.path in ('/meta-refresh', '/meta-refresh-slow', '/meta-refresh-error', '/meta-loop-a', '/meta-loop-b'):
            delay = '5' if self.path == '/meta-refresh-slow' else ('0.3' if self.path.startswith('/meta-loop-') else '1')
            destination = {'/meta-refresh-error': 'http://127.0.0.1:1/',
                           '/meta-loop-a': '/meta-loop-b', '/meta-loop-b': '/meta-loop-a'}.get(self.path, '/redirect-final')
            body = (f'<html><head><title>Ready</title><meta http-equiv="refresh" '
                    f'content="{delay};url={destination}"></head><body>intermediate</body></html>').encode()
        elif self.path in ('/normal-chain-first', '/normal-chain-second', '/normal-redirect-loop'):
            destination = {'/normal-chain-first': '/normal-chain-second',
                           '/normal-chain-second': '/redirect-final',
                           '/normal-redirect-loop': '/normal-redirect-loop'}[self.path]
            body = (f'<html><title>Ready</title><body>intermediate'
                    f'<script>setTimeout(() => location.href = "{destination}", 350)</script></body></html>').encode()
        elif self.path in ('/early-redirect', '/early-redirect-error'):
            destination = '/redirect-final' if self.path == '/early-redirect' else 'http://127.0.0.1:1/'
            body = (f'<html><head><title>Just a moment...</title></head><body>'
                    f'<img src="/slow-image"><script>setTimeout(() => location.href = "{destination}", 100)</script>'
                    f'</body></html>').encode()
        elif self.path == '/redirect-final':
            time.sleep(0.15)
            body = b'<html><head><title>Ready</title></head><body>final document</body></html>'
        elif self.path == '/denied':
            body = b'<html><head><title>Access denied</title></head><body></body></html>'
        elif self.path == '/media':
            body = b'<html><body><img src="/image.png"></body></html>'
        elif self.path == '/image.png':
            type(self).media_hits += 1
            body = b'not a real image'
        else:
            body = '<html><body>cookie={}; header={}; proxy={}; path={}</body></html>'.format(
                html.escape(self.headers.get('Cookie', '')),
                html.escape(self.headers.get('X-Bridge-Test', '')),
                html.escape(self.headers.get('X-Bridge-Proxy', '')),
                html.escape(self.path),
            ).encode()
        status = {'/status': 418, '/redirect-final': 201, '/header-cf': 403,
                  '/header-cf-redirect': 403, '/header-aws-challenge': 202,
                  '/header-aws-captcha': 405}.get(self.path, 200)
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        if self.path in ('/header-cf', '/header-cf-redirect'):
            self.send_header('CF-Mitigated', 'challenge')
        if self.path in ('/header-aws-challenge', '/header-aws-captcha', '/header-ordinary'):
            self.send_header('X-Amzn-Waf-Action', 'challenge' if self.path == '/header-aws-challenge' else 'captcha')
        if self.path == '/redirect-final':
            self.send_header('Set-Cookie', 'redirect_final=yes; Path=/')
            self.send_header('X-Redirect-Final', 'yes')
        if self.path == '/set':
            self.send_header('Set-Cookie', 'bridge_session=retained; Path=/; HttpOnly')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        payload = self.rfile.read(int(self.headers.get('Content-Length', '0'))).decode()
        if self.path == '/post-ddos-clearance-no-retry':
            type(self).post_counts[self.path] = type(self).post_counts.get(self.path, 0) + 1
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(b'<html><title>DDoS-Guard</title><script>'
                             b'setTimeout(() => {document.cookie="__ddg2_fixture=fresh; path=/";}, 100)'
                             b'</script></html>')
            return
        if self.path == '/post-meta-refresh':
            type(self).post_counts[self.path] = type(self).post_counts.get(self.path, 0) + 1
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(b'<html><title>Submitted</title><meta http-equiv="refresh" content="1;url=/redirect-final"></html>')
            return
        if self.path == '/post-clearance-no-retry':
            type(self).post_counts[self.path] = type(self).post_counts.get(self.path, 0) + 1
            body = (b'<html><title>Just a moment...</title><body><script>'
                    b'setTimeout(() => { document.cookie="cf_clearance=fresh; path=/"; }, 100)'
                    b'</script></body></html>')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path in ('/post-repeat-ok', '/post-repeat-challenge', '/post-repeat-html'):
            path = self.path
            type(self).post_counts[path] = type(self).post_counts.get(path, 0) + 1
            count = type(self).post_counts[path]
            rejected = path in ('/post-repeat-challenge', '/post-repeat-html') and count == 1
            if count == 1:
                title = 'Just a moment...' if rejected else 'Submitted'
                marker = '<script>window._cf_chl_opt={}</script>' if path == '/post-repeat-html' else ''
                body = (f'<html><title>{title}</title><body>{marker}<form method="POST" action="{path}">'
                        '<input name="answer" value="again"></form>'
                        '<script>setTimeout(() => document.forms[0].submit(), 150)</script>'
                        '</body></html>').encode()
            else:
                body = b'<html><title>Done</title><body>retry complete</body></html>'
            self.send_response(403 if rejected else 200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            if rejected and path == '/post-repeat-challenge':
                self.send_header('CF-Mitigated', 'challenge')
            self.end_headers()
            self.wfile.write(body)
            return
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
    expected_authorization = None
    authorized_hits = 0

    def log_message(self, *_args):
        pass

    def do_GET(self):
        target = urlsplit(self.path)
        if target.scheme != 'http' or target.hostname != self.fixture_host or target.port != self.fixture_port:
            self.send_error(403)
            return
        if self.expected_authorization is not None:
            if self.headers.get('Proxy-Authorization') != self.expected_authorization:
                self.send_response(407)
                self.send_header('Proxy-Authenticate', 'Basic realm="fixture"')
                self.end_headers()
                return
            type(self).authorized_hits += 1
        conn = http.client.HTTPConnection('127.0.0.1', self.fixture_port, timeout=10)
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in ('proxy-authorization', 'proxy-connection', 'connection')}
        headers['X-Bridge-Proxy'] = 'reached'
        try:
            path = target.path or '/'
            if target.query:
                path += '?' + target.query
            conn.request('GET', path, headers=headers)
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
        fragment_result = self.ok(cmd='request.post', session=sid, url=self.fixture + '/post#fragment',
                                  postData='fragment=ok')['solution']
        self.assertIn('post=fragment=ok', html.unescape(fragment_result['response']))
        empty_result = self.ok(cmd='request.post', session=sid, url=self.fixture + '/post', postData='')['solution']
        self.assertIn('post=', html.unescape(empty_result['response']))
        result = self.ok(cmd='request.get', session=sid, url=self.fixture + '/status')['solution']
        self.assertEqual(result['status'], 418)

    def test_request_body_validation_precedes_session_creation(self):
        sid = 'contract_invalid_' + uuid.uuid4().hex
        for payload in (
            {'cmd': 'request.get', 'postData': 'unexpected'},
            {'cmd': 'request.get', 'postData': ''},
            {'cmd': 'request.get', 'postData': 0},
            {'cmd': 'request.post'},
            {'cmd': 'request.post', 'postData': 7},
        ):
            result = self.api(url=self.fixture + '/post', session=sid, **payload)
            self.assertEqual(result.get('status'), 'error', result)
            self.assertIn('postData', result.get('message', ''))
            self.assertNotIn(sid, self.ok(cmd='sessions.list')['sessions'])
        result = self.ok(cmd='request.get', url=self.fixture + '/echo', postData=None)
        self.assertIn('solution', result)

    def test_post_replay_after_success_is_blocked(self):
        path = '/post-repeat-ok'
        Fixture.post_counts[path] = 0
        result = self.api(cmd='request.post', url=self.fixture + path, postData='answer=first',
                          waitInSeconds=1, maxTimeout=5000)
        self.assertEqual(result.get('status'), 'error', result)
        self.assertIn('POST replay blocked', result.get('message', ''))
        self.assertEqual(Fixture.post_counts[path], 1)

    def test_post_replay_after_explicit_challenge(self):
        path = '/post-repeat-challenge'
        Fixture.post_counts[path] = 0
        result = self.ok(cmd='request.post', url=self.fixture + path, postData='answer=first',
                         maxTimeout=8000)
        self.assertEqual(Fixture.post_counts[path], 2)
        self.assertIn('retry complete', result['solution']['response'])

    def test_post_replay_after_html_challenge(self):
        path = '/post-repeat-html'
        Fixture.post_counts[path] = 0
        result = self.ok(cmd='request.post', url=self.fixture + path, postData='answer=first',
                         maxTimeout=8000)
        self.assertEqual(Fixture.post_counts[path], 2)
        self.assertIn('retry complete', result['solution']['response'])

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

    def test_proxy_preserves_query_parameters(self):
        if not self.proxy:
            self.skipTest('use --test-proxy and a non-loopback fixture host reachable by the bridge')
        sid = self.ok(cmd='sessions.create', proxy={'url': self.proxy})['session']
        self.addCleanup(lambda: self.api(cmd='sessions.destroy', session=sid))
        result = self.ok(cmd='request.get', session=sid,
                         url=self.fixture + '/echo?query=a%2Bb&n=2')['solution']
        body = html.unescape(result['response'])
        self.assertIn('proxy=reached', body)
        self.assertIn('path=/echo?query=a%2Bb&n=2', body)

    def test_moviepilot_proxy_authentication_survives_rotation(self):
        if not self.proxy:
            self.skipTest('use --test-proxy and a non-loopback fixture host reachable by the bridge')
        fs = self.plugin
        auth_proxy = self.proxy.replace('://', '://fixture-user:p%40ss%3Aword@', 1)
        fs['_proxy_url_cache'] = auth_proxy
        self.addCleanup(fs.__setitem__, '_proxy_url_cache', '')
        FixtureProxy.expected_authorization = 'Basic ' + base64.b64encode(b'fixture-user:p@ss:word').decode()
        FixtureProxy.authorized_hits = 0
        self.addCleanup(setattr, FixtureProxy, 'expected_authorization', None)
        sid = fs['fs_create_session']()
        self.assertTrue(sid, 'session creation with authenticated proxy failed')
        self.addCleanup(fs['fs_destroy_session'], sid)
        body = html.unescape(fs['fs_get'](sid, self.fixture + '/echo', []))
        self.assertIn('proxy=reached', body, 'authenticated proxy was not used')
        time.sleep(0.15)
        result = self.ok(cmd='request.get', session=sid, session_ttl_minutes=0.001,
                         url=self.fixture + '/echo')['solution']
        self.assertIn('proxy=reached', html.unescape(result['response']), 'rotation lost proxy authentication')
        self.assertGreaterEqual(FixtureProxy.authorized_hits, 2)

    def test_proxy_separate_credentials_survive_rotation(self):
        if not self.proxy:
            self.skipTest('use --test-proxy and a non-loopback fixture host reachable by the bridge')
        FixtureProxy.expected_authorization = 'Basic ' + base64.b64encode(b'fixture%40user:p@ss:word%40').decode()
        FixtureProxy.authorized_hits = 0
        self.addCleanup(setattr, FixtureProxy, 'expected_authorization', None)
        sid = self.ok(cmd='sessions.create', proxy={'url': self.proxy, 'username': 'fixture%40user',
                                                    'password': 'p@ss:word%40'})['session']
        self.addCleanup(lambda: self.api(cmd='sessions.destroy', session=sid))
        first = self.ok(cmd='request.get', session=sid, url=self.fixture + '/echo')['solution']
        self.assertIn('proxy=reached', html.unescape(first['response']))
        time.sleep(0.15)
        rotated = self.ok(cmd='request.get', session=sid, session_ttl_minutes=0.001,
                          url=self.fixture + '/echo')['solution']
        self.assertIn('proxy=reached', html.unescape(rotated['response']))
        self.assertGreaterEqual(FixtureProxy.authorized_hits, 2)

    def test_proxy_wrong_credentials_do_not_bypass_proxy(self):
        if not self.proxy:
            self.skipTest('use --test-proxy and a non-loopback fixture host reachable by the bridge')
        FixtureProxy.expected_authorization = 'Basic ' + base64.b64encode(b'fixture-user:correct').decode()
        FixtureProxy.authorized_hits = 0
        before = Fixture.direct_echo_hits
        self.addCleanup(setattr, FixtureProxy, 'expected_authorization', None)
        sid = self.ok(cmd='sessions.create', proxy={'url': self.proxy, 'username': 'fixture-user',
                                                    'password': 'wrong'})['session']
        self.addCleanup(lambda: self.api(cmd='sessions.destroy', session=sid))
        result = self.api(cmd='request.get', session=sid, url=self.fixture + '/echo', maxTimeout=5000)
        if result.get('status') == 'ok':
            self.assertEqual(result['solution']['status'], 407, result)
            self.assertNotIn('proxy=reached', html.unescape(result['solution'].get('response', '')))
        else:
            self.assertTrue(result.get('message'), result)
        self.assertEqual(FixtureProxy.authorized_hits, 0)
        self.assertEqual(Fixture.direct_echo_hits, before, 'authentication failure must not reach the origin directly')

    def test_queued_timeout_preserves_active_session(self):
        sid = self.session()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            active = pool.submit(self.api, cmd='request.get', session=sid,
                                 url=self.fixture + '/echo', waitInSeconds=1, maxTimeout=5000)
            time.sleep(0.3)
            queued = self.api(cmd='request.get', session=sid, url=self.fixture + '/echo', maxTimeout=150)
            self.assertEqual(queued.get('status'), 'error', queued)
            self.assertIn('timeout', queued.get('message', '').lower())
            result = active.result()
            self.assertEqual(result.get('status'), 'ok', result)
        self.assertIn(sid, self.ok(cmd='sessions.list')['sessions'])
        self.ok(cmd='request.get', session=sid, url=self.fixture + '/echo')

    def test_expired_busy_session_does_not_interrupt_active_request(self):
        sid = self.session()
        self.ok(cmd='request.get', session=sid, url=self.fixture + '/set')
        time.sleep(0.15)
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            active = pool.submit(self.api, cmd='request.get', session=sid,
                                 url=self.fixture + '/echo', waitInSeconds=1, maxTimeout=5000)
            time.sleep(0.3)
            rotation = self.api(cmd='request.get', session=sid, url=self.fixture + '/echo',
                                session_ttl_minutes=0.001, maxTimeout=5000)
            self.assertEqual(rotation.get('status'), 'error', rotation)
            self.assertIn('busy', rotation.get('message', '').lower())
            result = active.result()
            self.assertEqual(result.get('status'), 'ok', result)
            self.assertIn('bridge_session=retained', html.unescape(result['solution']['response']))
        self.assertIn(sid, self.ok(cmd='sessions.list')['sessions'])
        rotated = self.ok(cmd='request.get', session=sid, url=self.fixture + '/echo',
                          session_ttl_minutes=0.001)['solution']
        self.assertNotIn('bridge_session=retained', html.unescape(rotated['response']))

    def test_active_timeout_retires_session(self):
        sid = self.session()
        result = self.api(cmd='request.get', session=sid, url=self.fixture + '/challenge', maxTimeout=400)
        self.assertEqual(result.get('status'), 'error', result)
        self.assertIn('timeout', result.get('message', '').lower())
        self.assertNotIn(sid, self.ok(cmd='sessions.list')['sessions'])

    def test_invalid_command_and_timeout(self):
        self.assertEqual(self.api(cmd='invalid.command').get('status'), 'error')
        start = time.monotonic()
        result = self.api(cmd='request.get', url=self.fixture + '/slow', maxTimeout=500)
        self.assertEqual(result.get('status'), 'error', result)
        self.assertLess(time.monotonic() - start, 10)

    def test_turnstile_token_fixture_and_timeout(self):
        solution = self.ok(cmd='request.get', url=self.fixture + '/turnstile-fixture',
                           tabs_till_verify=1, maxTimeout=8000)['solution']
        self.assertEqual(solution.get('turnstile_token'), 'fixture-token')
        frame_solution = self.ok(cmd='request.get', url=self.fixture + '/turnstile-iframe',
                                 tabs_till_verify=1, maxTimeout=8000)['solution']
        self.assertEqual(frame_solution.get('turnstile_token'), 'iframe-token')
        generic = self.ok(cmd='request.get', url=self.fixture + '/turnstile-generic',
                          tabs_till_verify=2, maxTimeout=8000)['solution']
        self.assertEqual(generic.get('turnstile_token'), 'generic-token')
        self.assertIn('name="csrf" tabindex="4"', generic['response'])
        self.assertIn('name="cf-turnstile-response" value=""', generic['response'])
        missing = self.ok(cmd='request.get', url=self.fixture + '/echo',
                          tabs_till_verify=1)['solution']
        self.assertIsNone(missing.get('turnstile_token'))
        result = self.api(cmd='request.get', url=self.fixture + '/turnstile-unresolved',
                          tabs_till_verify=1, maxTimeout=800)
        self.assertEqual(result.get('status'), 'error', result)
        self.assertIn('timeout', result.get('message', '').lower())
        invalid = self.api(cmd='request.get', url=self.fixture + '/echo', tabs_till_verify=-1)
        self.assertEqual(invalid.get('status'), 'error', invalid)

    def test_unrelated_iframe_is_not_automatically_clicked(self):
        before = Fixture.unsafe_hits
        result = self.api(cmd='request.get', url=self.fixture + '/challenge-unrelated-iframe',
                          maxTimeout=7000)
        self.assertEqual(result.get('status'), 'error', result)
        self.assertIn('timeout', result.get('message', '').lower())
        self.assertEqual(Fixture.unsafe_hits, before)

    def test_challenge_iframe_open_shadow_checkbox(self):
        solution = self.ok(cmd='request.get', url=self.fixture + '/challenge-shadow-iframe',
                           maxTimeout=15000)['solution']
        self.assertIn('iframe verified', solution['response'])
        self.assertNotIn('<iframe', solution['response'])

    def test_challenge_iframe_checkbox(self):
        solution = self.ok(cmd='request.get', url=self.fixture + '/challenge-iframe',
                           maxTimeout=15000)['solution']
        self.assertIn('iframe verified', solution['response'])
        self.assertNotIn('<iframe', solution['response'])

    def test_challenge_verify_button(self):
        solution = self.ok(cmd='request.get', url=self.fixture + '/challenge-verify',
                           maxTimeout=15000)['solution']
        self.assertIn('verification clicked', solution['response'])

    def test_new_clearance_cookie_recovers_one_get(self):
        path = '/cf-clearance-recovery'
        Fixture.clearance_hits[path] = 0
        solution = self.ok(cmd='request.get', url=self.fixture + path, maxTimeout=15000)['solution']
        self.assertEqual(Fixture.clearance_hits[path], 2)
        self.assertIn('clearance recovery succeeded', solution['response'])
        self.assertTrue(any(c.get('name') == 'cf_clearance' and c.get('value') == 'fresh'
                            for c in solution['cookies']))

    def test_existing_clearance_does_not_authorize_get_recovery(self):
        path = '/cf-clearance-stale'
        Fixture.clearance_hits[path] = 0
        result = self.api(cmd='request.get', url=self.fixture + path, maxTimeout=6500,
                          cookies=[{'name': 'cf_clearance', 'value': 'stale'}])
        self.assertEqual(result.get('status'), 'error', result)
        self.assertIn('timeout', result.get('message', '').lower())
        self.assertEqual(Fixture.clearance_hits[path], 1)

    def test_new_clearance_does_not_replay_post(self):
        path = '/post-clearance-no-retry'
        Fixture.post_counts[path] = 0
        result = self.api(cmd='request.post', url=self.fixture + path, postData='answer=first', maxTimeout=6500)
        self.assertEqual(result.get('status'), 'error', result)
        self.assertIn('timeout', result.get('message', '').lower())
        self.assertEqual(Fixture.post_counts[path], 1)

    def test_header_only_challenges_are_not_returned_as_success(self):
        for path in ('/header-cf', '/header-aws-challenge'):
            with self.subTest(path=path):
                result = self.api(cmd='request.get', url=self.fixture + path, maxTimeout=800)
                self.assertEqual(result.get('status'), 'error', result)
                self.assertIn('timeout', result.get('message', '').lower())
        captcha = self.api(cmd='request.get', url=self.fixture + '/header-aws-captcha', maxTimeout=5000)
        self.assertEqual(captcha.get('status'), 'error', captcha)
        self.assertIn('captcha', captcha.get('message', '').lower())
        ordinary = self.ok(cmd='request.get', url=self.fixture + '/header-ordinary')['solution']
        self.assertEqual(ordinary['status'], 200)

    def test_header_only_challenge_redirect_returns_final_page(self):
        solution = self.ok(cmd='request.get', url=self.fixture + '/header-cf-redirect',
                           maxTimeout=8000)['solution']
        self.assertEqual(solution['status'], 201)
        self.assertTrue(solution['url'].endswith('/redirect-final'), solution)
        self.assertIn('final document', solution['response'])

    def test_anubis_html_challenge_is_not_reported_as_success(self):
        solution = self.ok(cmd='request.get', url=self.fixture + '/anubis-transient',
                           maxTimeout=8000)['solution']
        self.assertIn('challenge cleared', solution['response'])
        self.assertNotIn('id="anubis_challenge"', solution['response'])

    def test_challenge_navigation_failure_is_reported(self):
        result = self.api(cmd='request.get', url=self.fixture + '/challenge-nav-failure', maxTimeout=5000)
        self.assertEqual(result.get('status'), 'error', result)
        self.assertIn('navigation failed', result.get('message', '').lower())

    def test_challenge_navigation_returns_final_document(self):
        solution = self.ok(cmd='request.get', url=self.fixture + '/challenge-redirect',
                           maxTimeout=15000)['solution']
        self.assertTrue(solution['url'].endswith('/redirect-final'), solution)
        self.assertEqual(solution['status'], 201)
        self.assertEqual(solution['headers'].get('x-redirect-final'), 'yes')
        self.assertIn('final document', solution['response'])
        self.assertTrue(any(c.get('name') == 'redirect_final' and c.get('value') == 'yes'
                            for c in solution['cookies']))

    def test_normal_title_navigation_returns_final_document(self):
        solution = self.ok(cmd='request.get', url=self.fixture + '/normal-redirect',
                           maxTimeout=10000)['solution']
        self.assertTrue(solution['url'].endswith('/redirect-final'), solution)
        self.assertEqual(solution['status'], 201)
        self.assertEqual(solution['headers'].get('x-redirect-final'), 'yes')
        self.assertIn('final document', solution['response'])
        self.assertTrue(any(c.get('name') == 'redirect_final' and c.get('value') == 'yes'
                            for c in solution['cookies']))

    def test_meta_refresh_returns_final_document(self):
        solution = self.ok(cmd='request.get', url=self.fixture + '/meta-refresh', maxTimeout=8000)['solution']
        self.assertTrue(solution['url'].endswith('/redirect-final'), solution)
        self.assertEqual(solution['status'], 201)
        self.assertEqual(solution['headers'].get('x-redirect-final'), 'yes')
        self.assertIn('final document', solution['response'])
        self.assertTrue(any(c.get('name') == 'redirect_final' and c.get('value') == 'yes'
                            for c in solution['cookies']))

    def test_dynamically_inserted_meta_refresh_returns_final_document(self):
        solution = self.ok(cmd='request.get', url=self.fixture + '/meta-refresh-injected', maxTimeout=8000)['solution']
        self.assertTrue(solution['url'].endswith('/redirect-final'), solution)
        self.assertEqual(solution['status'], 201)
        self.assertEqual(solution['headers'].get('x-redirect-final'), 'yes')
        self.assertIn('final document', solution['response'])

    def test_ddos_guard_wall_is_not_reported_as_success(self):
        result = self.api(cmd='request.get', url=self.fixture + '/ddos-guard-wall', maxTimeout=1500)
        self.assertEqual(result['status'], 'error')
        self.assertIn('timeout', result.get('message', '').lower())

    def test_ddos_guard_wall_clears_before_return(self):
        solution = self.ok(cmd='request.get', url=self.fixture + '/ddos-guard-transient', maxTimeout=8000)['solution']
        self.assertIn('challenge cleared', solution['response'])
        self.assertNotIn('id="ddg-l10n-title"', solution['response'])

    def test_new_ddos_clearance_recovers_one_get(self):
        before = Fixture.clearance_hits.get('/ddos-clearance-recovery', 0)
        solution = self.ok(cmd='request.get', url=self.fixture + '/ddos-clearance-recovery', maxTimeout=15000)['solution']
        self.assertIn('ddos clearance recovered', solution['response'])
        self.assertEqual(Fixture.clearance_hits.get('/ddos-clearance-recovery', 0) - before, 2)

    def test_existing_ddos_clearance_does_not_trigger_recovery(self):
        before = Fixture.clearance_hits.get('/ddos-clearance-stale', 0)
        result = self.api(cmd='request.get', url=self.fixture + '/ddos-clearance-stale', maxTimeout=2200,
                          cookies=[{'name': '__ddg2_fixture', 'value': 'old'}])
        self.assertEqual(result['status'], 'error')
        self.assertIn('timeout', result.get('message', '').lower())
        self.assertEqual(Fixture.clearance_hits.get('/ddos-clearance-stale', 0) - before, 1)

    def test_new_ddos_clearance_does_not_replay_post(self):
        before = Fixture.post_counts.get('/post-ddos-clearance-no-retry', 0)
        result = self.api(cmd='request.post', url=self.fixture + '/post-ddos-clearance-no-retry',
                          postData='value=one', maxTimeout=10000)
        self.assertEqual(result['status'], 'error')
        self.assertIn('timeout', result.get('message', '').lower())
        self.assertEqual(Fixture.post_counts.get('/post-ddos-clearance-no-retry', 0) - before, 1)

    def test_ddos_guard_passive_mention_is_ordinary_page(self):
        solution = self.ok(cmd='request.get', url=self.fixture + '/ddos-guard-ordinary', maxTimeout=8000)['solution']
        self.assertIn('Protected by ddos-guard.net', solution['response'])

    def test_meta_refresh_respects_request_timeout(self):
        result = self.api(cmd='request.get', url=self.fixture + '/meta-refresh-slow', maxTimeout=1500)
        self.assertEqual(result['status'], 'error')
        self.assertIn('timeout', result.get('message', '').lower())

    def test_meta_refresh_navigation_failure_is_reported(self):
        result = self.api(cmd='request.get', url=self.fixture + '/meta-refresh-error', maxTimeout=8000)
        self.assertEqual(result['status'], 'error')
        self.assertRegex(result.get('message', '').lower(), r'navigation|net::err')

    def test_meta_refresh_loop_times_out(self):
        result = self.api(cmd='request.get', url=self.fixture + '/meta-loop-a', maxTimeout=2200)
        self.assertEqual(result['status'], 'error')
        self.assertIn('timeout', result.get('message', '').lower())

    def test_post_meta_refresh_does_not_replay_submission(self):
        before = Fixture.post_counts.get('/post-meta-refresh', 0)
        solution = self.ok(cmd='request.post', url=self.fixture + '/post-meta-refresh', postData='value=one', maxTimeout=8000)['solution']
        self.assertTrue(solution['url'].endswith('/redirect-final'), solution)
        self.assertEqual(solution['status'], 201)
        self.assertEqual(Fixture.post_counts.get('/post-meta-refresh', 0) - before, 1)

    def test_normal_title_chained_navigation_returns_final_document(self):
        solution = self.ok(cmd='request.get', url=self.fixture + '/normal-chain-first',
                           maxTimeout=10000)['solution']
        self.assertTrue(solution['url'].endswith('/redirect-final'), solution)
        self.assertEqual(solution['status'], 201)
        self.assertEqual(solution['headers'].get('x-redirect-final'), 'yes')
        self.assertIn('final document', solution['response'])

    def test_wait_in_seconds_covers_later_navigation(self):
        solution = self.ok(cmd='request.get', url=self.fixture + '/normal-late-redirect',
                           waitInSeconds=1.5, maxTimeout=10000)['solution']
        self.assertTrue(solution['url'].endswith('/redirect-final'), solution)
        self.assertEqual(solution['status'], 201)
        self.assertIn('final document', solution['response'])

    def test_normal_title_reload_returns_final_document(self):
        solution = self.ok(cmd='request.get', url=self.fixture + '/normal-reload',
                           maxTimeout=10000)['solution']
        self.assertTrue(solution['url'].endswith('/normal-reload'), solution)
        self.assertEqual(solution['status'], 201)
        self.assertEqual(solution['headers'].get('x-reload-final'), 'yes')
        self.assertIn('reload final', solution['response'])
        self.assertTrue(any(c.get('name') == 'reload_seen' and c.get('value') == 'yes'
                            for c in solution['cookies']))

    def test_continuous_normal_title_reload_times_out(self):
        result = self.api(cmd='request.get', url=self.fixture + '/normal-redirect-loop', maxTimeout=2000)
        self.assertEqual(result.get('status'), 'error', result)
        self.assertIn('timeout', result.get('message', '').lower())

    def test_navigation_during_initial_load_returns_final_document(self):
        hits = Fixture.slow_image_hits
        solution = self.ok(cmd='request.get', url=self.fixture + '/early-redirect',
                           maxTimeout=10000)['solution']
        self.assertGreater(Fixture.slow_image_hits, hits, 'slow resource was not requested')
        self.assertTrue(solution['url'].endswith('/redirect-final'), solution)
        self.assertEqual(solution['status'], 201)
        self.assertEqual(solution['headers'].get('x-redirect-final'), 'yes')
        self.assertIn('final document', solution['response'])
        self.assertTrue(any(c.get('name') == 'redirect_final' and c.get('value') == 'yes'
                            for c in solution['cookies']))

    def test_navigation_failure_during_initial_load_is_reported(self):
        result = self.api(cmd='request.get', url=self.fixture + '/early-redirect-error', maxTimeout=8000)
        self.assertEqual(result.get('status'), 'error', result)
        self.assertRegex(result.get('message', '').lower(), r'navigation|net::err')

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
    parser.add_argument('--test', action='append', default=[], help='run a named Contract test (repeatable)')
    args = parser.parse_args()
    for name in args.test:
        if not name.startswith('test_') or not callable(getattr(Contract, name, None)):
            parser.error(f'unknown Contract test: {name}')
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
        suite = (unittest.TestSuite(Contract(name) for name in args.test) if args.test
                 else unittest.defaultTestLoader.loadTestsFromTestCase(Contract))
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
