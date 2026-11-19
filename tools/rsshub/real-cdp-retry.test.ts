// Runs unmocked RSSHub Playwright and retry modules against a local Moli gateway.
// Only configuration, logger, proxy policy, and the original failed HTTP response are fixtures.
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSocks5Fixture } from './socks5-proxy-fixture.mjs';

let temp: string;
let fixture: https.Server;
let proxy: http.Server | https.Server | net.Server;
let gateway: ChildProcess;
let getPlaywrightPage: typeof import('./lib/utils/playwright').getPlaywrightPage;
let retry: typeof import('./lib/utils/playwright-fetch').default;
const requests: Array<{ url?: string; host?: string; method?: string; body: string; header?: string }> = [];
let proxyConnections = 0;
let proxyAuthFailures = 0;
let heldResponseClosed = false;
const requireProxyAuth = process.env.MOLI_TEST_AUTH_PROXY === '1';
const wrongProxyAuth = process.env.MOLI_TEST_WRONG_PROXY_AUTH === '1';
const proxyKind = process.env.MOLI_TEST_PROXY_KIND ?? 'http';
const untrustedProxy = process.env.MOLI_TEST_UNTRUSTED_PROXY === '1';
const proxyPassword = process.env.MOLI_TEST_PERCENT_PROXY_PASSWORD === '1' ? 'p@ss:word%40' : 'p@ss:word';
const proxyAuthorization = `Basic ${Buffer.from(`fixture-user:${proxyPassword}`).toString('base64')}`;

beforeAll(async () => {
    const moli = process.env.MOLI_TEST_BINARY;
    if (!moli || !path.isAbsolute(moli)) throw new Error('Set MOLI_TEST_BINARY to an absolute Moli executable path');
    temp = await mkdtemp(path.join(os.tmpdir(), 'moli-rsshub-real-'));
    const key = path.join(temp, 'key.pem');
    const cert = path.join(temp, 'cert.pem');
    const untrustedKey = path.join(temp, 'untrusted-key.pem');
    const untrustedCert = path.join(temp, 'untrusted-cert.pem');
    const wrapper = path.join(temp, 'moli-wrapper');
    const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
        '-subj', '/CN=api.bilibili.com', '-addext', 'subjectAltName=DNS:api.bilibili.com,DNS:oauth.secure.pixiv.net,DNS:www.ups.com,IP:127.0.0.1',
        '-keyout', key, '-out', cert], { stdio: 'ignore' });
    if (openssl.status !== 0) throw new Error('Unable to generate fixture certificate');
    if (untrustedProxy) {
        if (proxyKind !== 'https') throw new Error('Untrusted proxy fixture requires HTTPS');
        const untrusted = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
            '-subj', '/CN=untrusted-proxy', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', untrustedKey, '-out', untrustedCert], { stdio: 'ignore' });
        if (untrusted.status !== 0) throw new Error('Unable to generate untrusted proxy certificate');
    }
    // Reject startup unless RSSHub propagated our fixture-only proxy. This
    // prevents a test configuration mistake from contacting real services.
    await writeFile(wrapper, '#!/bin/sh\nprintf "%s\\n" "$@" > "$MOLI_FIXTURE_LOG"\ncase " $* " in *" --http-proxy $MOLI_FIXTURE_EXPECTED_PROXY "*|*" --http-proxy $MOLI_FIXTURE_EXPECTED_PROXY/ "*) ;; *) exit 90 ;; esac\nexec "$MOLI_TEST_BINARY" "$@" --ca-cert "$MOLI_FIXTURE_CERT"\n', { mode: 0o755 });
    fixture = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            requests.push({ url: req.url, host: req.headers.host, method: req.method, body, header: req.headers['x-rsshub-fixture'] as string | undefined });
            if (req.headers.host === 'www.ups.com' && req.url?.startsWith('/track?')) {
                const rows = '<tr id="stApp_activitydetails_row0"><td id="stApp_activitiesdateTime0">2026-11-15T10:30:00Z</td><td id="stApp_milestoneActivityLocation0"><strong>Delivered</strong>\nSeattle, WA</td></tr>' +
                    '<tr id="stApp_activitydetails_row1"><td id="stApp_activitiesdateTime1">2026-11-14T08:00:00Z</td><td id="stApp_milestoneActivityLocation1">Departed\nPortland, OR</td></tr>';
                const visiblePlaceholder = /tracknum=(?:PLACEHOLDER123|INCOMPLETE123)/.test(req.url);
                const pending = req.url.includes('tracknum=INCOMPLETE123')
                    ? '<tr id="stApp_activitydetails_row0"><td id="stApp_milestoneActivityLocation0">Delivered</td></tr><tr id="stApp_activitydetails_row1"><td>Loading...</td></tr>'
                    : visiblePlaceholder ? '<tr id="stApp_activitydetails_row0"><td>Loading...</td></tr>'
                    : '<tr id="stApp_activitydetails_row0"><td id="stApp_milestoneActivityLocation0">Hidden pending row</td></tr>';
                res.writeHead(200, { 'content-type': 'text/html' });
                res.end(`<title>Fixture tracking</title><button id="st_App_View_Details">Details</button><img src="/blocked-image"><table id="tracking-table"><tbody></tbody></table><table id="static-table"><tbody><tr id="static-row"><td>Static row</td></tr></tbody></table><script>document.getElementById('st_App_View_Details').addEventListener('click', () => { const table = document.getElementById('tracking-table'); table.style.display = ${JSON.stringify(visiblePlaceholder ? '' : 'none')}; table.querySelector('tbody').innerHTML = ${JSON.stringify(pending)}; setTimeout(() => { table.querySelector('tbody').innerHTML = ${JSON.stringify(rows)}; table.style.display = ''; }, ${visiblePlaceholder ? 1500 : 350}); });</script>`);
                return;
            }
            const query = new URL(req.url ?? '/', 'https://fixture.invalid').searchParams;
            if (query.has('hold')) { res.on('close', () => { heldResponseClosed = true; }); return; }
            if (query.has('redirect')) {
                const destination = req.headers.host === 'oauth.secure.pixiv.net' ? 'api.bilibili.com' : 'oauth.secure.pixiv.net';
                res.writeHead(307, { location: `https://${destination}/redirect-target` }).end();
                return;
            }
            if (query.get('source') === 'page') {
                res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'rsshub_fixture=yes; Path=/' });
                res.end('<body>local-tls-fixture<script>document.body.dataset.scriptRan="yes"</script></body>');
                return;
            }
            res.writeHead(201, { 'content-type': 'application/json', 'x-rsshub-fixture': 'response', 'set-cookie': 'rsshub_fixture=yes; Path=/' });
            res.end(JSON.stringify({ source: 'local-tls-fixture', method: req.method, body }));
        });
    });
    await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const fixturePort = (fixture.address() as net.AddressInfo).port;
    if (!['http', 'https', 'socks5'].includes(proxyKind)) throw new Error('Unsupported fixture proxy kind');
    if (proxyKind === 'socks5') {
        proxy = createSocks5Fixture({ fixturePort, allowedHosts: ['api.bilibili.com', 'oauth.secure.pixiv.net', 'www.ups.com'],
            username: 'fixture-user', password: proxyPassword, onConnected: () => { proxyConnections++; }, onAuthFailure: () => { proxyAuthFailures++; } });
    } else {
        const httpProxy = proxyKind === 'https'
            ? https.createServer({ key: await readFile(untrustedProxy ? untrustedKey : key), cert: await readFile(untrustedProxy ? untrustedCert : cert) }, (_req, res) => { res.writeHead(403).end(); })
            : http.createServer((_req, res) => { res.writeHead(403).end(); });
        httpProxy.on('connect', (req, client, head) => {
            if (!['api.bilibili.com:443', 'oauth.secure.pixiv.net:443', 'www.ups.com:443'].includes(req.url ?? '')) { client.destroy(); return; }
            if (requireProxyAuth && req.headers['proxy-authorization'] !== proxyAuthorization) {
                proxyAuthFailures++;
                client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nContent-Length: 0\r\n\r\n');
                return;
            }
            proxyConnections++;
            const upstream = net.connect(fixturePort, '127.0.0.1', () => {
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length) upstream.write(head);
                upstream.pipe(client); client.pipe(upstream);
            });
            upstream.on('error', () => client.destroy());
            client.on('error', () => upstream.destroy());
        });
        proxy = httpProxy;
    }
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as net.AddressInfo).port;
    const reserve = net.createServer();
    await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = (reserve.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reserve.close(() => resolve()));
    const expectedProxy = requireProxyAuth
        ? `${proxyKind}://fixture-user:${wrongProxyAuth ? 'wrong' : encodeURIComponent(proxyPassword)}@127.0.0.1:${proxyPort}`
        : `${proxyKind}://127.0.0.1:${proxyPort}`;
    process.env.MOLI_FIXTURE_EXPECTED_PROXY = expectedProxy;
    process.env.MOLI_FIXTURE_PROXY = process.env.MOLI_TEST_SOCKS5H_ALIAS === '1' && proxyKind === 'socks5'
        ? expectedProxy.replace(/^socks5:/, 'socks5h:') : expectedProxy;
    process.env.MOLI_FIXTURE_HEALTH = `http://127.0.0.1:${port}/health`;
    process.env.MOLI_FIXTURE_CDP = process.env.MOLI_TEST_DIRECT_CDP === '1'
        ? `ws://127.0.0.1:${port}/chromium` : `http://127.0.0.1:${port}`;
    gateway = spawn(process.execPath, [path.join(process.env.MOLI_PROJECT_ROOT!, 'flaresolverr-bridge/cdp-gateway.mjs')], {
        env: { ...process.env, MOLI_BIN: wrapper, MOLI_FIXTURE_CERT: cert, MOLI_FIXTURE_LOG: path.join(temp, 'moli-args'), CDP_PORT: String(port) }, stdio: 'ignore',
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
        try { if ((await fetch(process.env.MOLI_FIXTURE_HEALTH!)).ok) { ready = true; break; } } catch {}
        await delay(50);
    }
    if (!ready) throw new Error('CDP gateway did not start');
    ({ getPlaywrightPage } = await import('./lib/utils/playwright'));
    ({ default: retry } = await import('./lib/utils/playwright-fetch'));
}, 30000);

afterAll(async () => {
    if (gateway) {
        if (gateway.exitCode === null && gateway.signalCode === null) {
            const exited = new Promise(resolve => gateway.once('exit', resolve));
            gateway.kill('SIGTERM');
            await exited;
        }
    }
    if (proxy) await new Promise<void>(resolve => proxy.close(() => resolve()));
    if (fixture) await new Promise<void>(resolve => fixture.close(() => resolve()));
    if (temp) await rm(temp, { recursive: true, force: true });
});

it.skipIf(process.env.MOLI_TEST_GATEWAY_PROXY_PROBE !== '1')('gateway probe uses the authenticated fixture proxy', async () => {
    const { chromium } = await import('patchright');
    const endpoint = new URL(process.env.MOLI_FIXTURE_CDP!);
    endpoint.searchParams.set('launch', JSON.stringify({ args: [`--proxy-server=${process.env.MOLI_FIXTURE_PROXY}`], headless: true, stealth: true }));
    const browser = await chromium.connectOverCDP(endpoint.href);
    try {
        const page = await browser.contexts()[0].newPage();
        const before = requests.length;
        if (wrongProxyAuth) {
            await expect(page.goto('https://api.bilibili.com/x/web-interface/popular?source=page')).rejects.toThrow();
            expect(proxyAuthFailures).toBeGreaterThan(0);
            expect(requests.length).toBe(before);
        } else {
            await page.goto('https://api.bilibili.com/x/web-interface/popular?source=page');
            expect(await page.content()).toContain('local-tls-fixture');
            expect(proxyConnections).toBeGreaterThan(0);
        }
    } finally { await browser.close(); }
}, 30000);

it('runs RSSHub getPlaywrightPage with its real CDP launch and navigation guards', async () => {
    const url = 'https://api.bilibili.com/x/web-interface/popular?source=page';
    let instance: Awaited<ReturnType<typeof getPlaywrightPage>>;
    try {
        instance = await getPlaywrightPage(url, {
            useConfiguredEndpoint: true, javaScriptEnabled: false,
            onBeforeLoad: page => page.setExtraHTTPHeaders({ 'x-rsshub-fixture': 'page-header' }),
        });
    } catch (error) {
        const launch = { args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-position=0,0', `--proxy-server=${process.env.MOLI_FIXTURE_PROXY}`], headless: true, stealth: true };
        const diagnostic = new URL('/json/version', process.env.MOLI_FIXTURE_HEALTH!);
        diagnostic.searchParams.set('launch', JSON.stringify(launch));
        const response = await fetch(diagnostic);
        const args = await readFile(path.join(temp, 'moli-args'), 'utf8').catch(() => '<wrapper not called>');
        if (requireProxyAuth) throw new Error(`RSSHub authenticated CDP setup failed; gateway status ${response.status}; details omitted`);
        throw new Error(`${String(error)}; gateway response: ${response.status} ${await response.text()}; wrapper args: ${args}`);
    }
    try {
        expect(await instance.page.content()).toContain('local-tls-fixture');
        expect(await instance.page.evaluate(() => navigator.userAgent)).toBe('RSSHub-real-CDP-fixture');
        expect(await instance.page.evaluate(() => document.body.dataset.scriptRan)).toBeUndefined();
        await expect(instance.page.goto('file:///tmp/fixture')).rejects.toThrow(/only web pages/);
        expect((await instance.context.cookies()).some(cookie => cookie.name === 'rsshub_fixture')).toBe(true);
        expect(requests.some(req => req.url === '/x/web-interface/popular?source=page' && req.header === 'page-header')).toBe(true);
    } finally { await instance.destroy(); }
}, 30000);

it.skipIf(!requireProxyAuth || wrongProxyAuth)('does not expose proxy credentials in CDP connection errors', async () => {
    const rejected = http.createServer((_req, res) => res.writeHead(503).end());
    await new Promise<void>(resolve => rejected.listen(0, '127.0.0.1', resolve));
    const original = process.env.MOLI_FIXTURE_CDP;
    try {
        for (const endpoint of [`http://127.0.0.1:${(rejected.address() as net.AddressInfo).port}`,
            `ws://127.0.0.1:${(rejected.address() as net.AddressInfo).port}/chromium`]) {
            process.env.MOLI_FIXTURE_CDP = endpoint;
            let failure: unknown;
            try { await getPlaywrightPage('https://api.bilibili.com/x/web-interface/popular', { useConfiguredEndpoint: true }); }
            catch (error) { failure = error; }
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toMatch(/Unable to connect to Moli CDP/);
            expect((failure as Error).stack).not.toContain('fixture-user');
            expect((failure as Error).stack).not.toContain('p%40ss%3Aword');
            expect((failure as Error).stack).not.toContain('p@ss:word');
        }
    } finally {
        process.env.MOLI_FIXTURE_CDP = original;
        await new Promise<void>(resolve => rejected.close(() => resolve()));
    }
}, 30000);

it.skipIf(!wrongProxyAuth)('does not bypass an authenticated proxy that rejects credentials', async () => {
    const before = requests.length;
    let failure: unknown;
    try { await getPlaywrightPage('https://api.bilibili.com/x/web-interface/popular?source=page', { useConfiguredEndpoint: true }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).stack).not.toContain('fixture-user');
    expect(proxyAuthFailures).toBeGreaterThan(0);
    expect(requests.length).toBe(before);
}, 30000);

it.skipIf(!untrustedProxy)('rejects an untrusted HTTPS proxy without going direct', async () => {
    const before = requests.length;
    await expect(getPlaywrightPage('https://api.bilibili.com/x/web-interface/popular?source=page', { useConfiguredEndpoint: true })).rejects.toThrow();
    expect(requests.length).toBe(before);
}, 30000);

it('runs the real RSSHub UPS route, clicks its details button and parses fixture entries', async () => {
    const { route } = await import('./lib/routes/ups/track');
    const result = await route.handler({ req: { param: () => ({ trackingNumber: 'FIXTURE123' }) } } as any);
    expect(result.title).toBe('UPS Tracking - FIXTURE123');
    expect(result.item).toHaveLength(2);
    expect(result.item[0]).toMatchObject({ title: 'Delivered', guid: 'FIXTURE123-0',
        link: 'https://www.ups.com/track?loc=en_US&tracknum=FIXTURE123' });
    expect(result.item[0].description).toContain('Seattle, WA');
    expect(result.item[0].pubDate.toISOString()).toBe('2026-11-15T10:30:00.000Z');
    expect(result.item[1]).toMatchObject({ title: 'Departed', guid: 'FIXTURE123-1' });
    expect(result.item[1].description).toContain('Portland, OR');
    expect(requests.some(req => req.host === 'www.ups.com' && req.url?.includes('tracknum=FIXTURE123'))).toBe(true);
    expect(requests.some(req => req.url === '/blocked-image')).toBe(false);
}, 20000);

it('does not parse a visible loading row before UPS tracking details arrive', async () => {
    const { route } = await import('./lib/routes/ups/track');
    const result = await route.handler({ req: { param: () => ({ trackingNumber: 'PLACEHOLDER123' }) } } as any);
    expect(result.item).toHaveLength(2);
    expect(result.item[0]).toMatchObject({ title: 'Delivered', guid: 'PLACEHOLDER123-0' });
    expect(result.item[1]).toMatchObject({ title: 'Departed', guid: 'PLACEHOLDER123-1' });
}, 20000);

it('waits for every currently present UPS tracking row to have a status', async () => {
    const { route } = await import('./lib/routes/ups/track');
    const result = await route.handler({ req: { param: () => ({ trackingNumber: 'INCOMPLETE123' }) } } as any);
    expect(result.item).toHaveLength(2);
    expect(result.item[0]).toMatchObject({ title: 'Delivered', guid: 'INCOMPLETE123-0' });
    expect(result.item[1]).toMatchObject({ title: 'Departed', guid: 'INCOMPLETE123-1' });
}, 20000);

it('uses the real RSSHub retry to replay a Bilibili GET through Moli', async () => {
    const request = new Request('https://api.bilibili.com/x/web-interface/popular?pn=1', { headers: { 'x-rsshub-fixture': 'get-header' } });
    const result = await retry(request, async native => {
        expect(native.redirect).toBe('manual');
        return new Response('fixture challenge', { status: 412 });
    });
    expect(result.status).toBe(201);
    expect(result.headers.get('x-rsshub-fixture')).toBe('response');
    expect(await result.json()).toMatchObject({ source: 'local-tls-fixture', method: 'GET' });
    expect(requests.some(req => req.url === '/x/web-interface/popular?pn=1' && req.header === 'get-header')).toBe(true);
    expect(proxyConnections).toBeGreaterThan(0);
}, 30000);

it('replays the real RSSHub Pixiv form without losing its consumed body', async () => {
    const body = 'grant_type=fixture&value=hello%20world';
    const request = new Request('https://oauth.secure.pixiv.net/auth/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-rsshub-fixture': 'post-header' }, body,
    });
    const result = await retry(request, async native => {
        expect(native.redirect).toBe('manual');
        expect(await native.text()).toBe(body);
        return new Response('fixture challenge', { status: 403 });
    });
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({ source: 'local-tls-fixture', method: 'POST', body });
    expect(requests.some(req => req.url === '/auth/token' && req.method === 'POST' && req.body === body && req.header === 'post-header')).toBe(true);
}, 30000);

it('returns the original response when a replay redirects, without leaking headers to the next origin', async () => {
    const request = new Request('https://api.bilibili.com/x/web-interface/popular?redirect=1', {
        headers: { 'x-rsshub-fixture': 'private-fixture-value' },
    });
    const result = await retry(request, async () => new Response('original challenge', { status: 412 }));
    expect(result.status).toBe(412);
    expect(await result.text()).toBe('original challenge');
    expect(requests.some(req => req.url === '/x/web-interface/popular?redirect=1' && req.header === 'private-fixture-value')).toBe(true);
    expect(requests.some(req => req.url === '/redirect-target')).toBe(false);
}, 30000);

it('does not forward a replayed OAuth form across a 307 redirect', async () => {
    const body = 'grant_type=fixture&secret=fake-value';
    const request = new Request('https://oauth.secure.pixiv.net/auth/token?redirect=1', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-rsshub-fixture': 'private-form' }, body,
    });
    const result = await retry(request, async () => new Response('original challenge', { status: 403 }));
    expect(result.status).toBe(403);
    expect(await result.text()).toBe('original challenge');
    expect(requests.some(req => req.url === '/auth/token?redirect=1' && req.body === body && req.header === 'private-form')).toBe(true);
    expect(requests.some(req => req.url === '/redirect-target')).toBe(false);
}, 30000);

it('aborts a live replay and closes its fixture connection', async () => {
    const controller = new AbortController();
    const request = new Request('https://api.bilibili.com/x/web-interface/popular?hold=1', { signal: controller.signal });
    const result = retry(request, async () => new Response('original challenge', { status: 412 }));
    try {
        for (let i = 0; i < 100 && !requests.some(req => req.url === '/x/web-interface/popular?hold=1'); i++) await delay(50);
        expect(requests.some(req => req.url === '/x/web-interface/popular?hold=1')).toBe(true);
    } finally { controller.abort(); }
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    for (let i = 0; i < 100 && !heldResponseClosed; i++) await delay(50);
    expect(heldResponseClosed).toBe(true);
    expect((await fetch(process.env.MOLI_FIXTURE_HEALTH!)).ok).toBe(true);
}, 30000);

it.skipIf(process.env.MOLI_TEST_AUTH_PROXY_PATCH !== '1')('rejects unsupported authenticated proxy protocols without going direct', async () => {
    const original = process.env.MOLI_FIXTURE_PROXY;
    const before = requests.length;
    try {
        for (const scheme of ['socks4', 'socks4a']) {
            process.env.MOLI_FIXTURE_PROXY = `${scheme}://fixture-user:p%40ss%3Aword@127.0.0.1:12345`;
            vi.resetModules();
            const isolated = await import('./lib/utils/playwright');
            await expect(isolated.getPlaywrightPage('https://api.bilibili.com/x/web-interface/popular', { useConfiguredEndpoint: true }))
                .rejects.toThrow(/HTTP, HTTPS and SOCKS5 authenticated proxies/i);
        }
        expect(requests.length).toBe(before);
    } finally { process.env.MOLI_FIXTURE_PROXY = original; }
}, 30000);
