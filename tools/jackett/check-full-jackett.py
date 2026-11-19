#!/usr/bin/env python3
"""Exercise a disposable Jackett, bridge and TorrentKitty-shaped local fixture."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET


FIXTURE = r'''
import http from 'node:http';
const history = [];
const body = '<html><title>Ready</title><table id="archiveResult"><tbody><tr>' +
  '<td class="name">Moli Fixture Release</td><td class="size">1.5 GB</td>' +
  '<td class="date">2026-11-18</td><td class="action"><a href="/details">Details</a>' +
  '<a href="magnet:?xt=urn:btih:0123456789012345678901234567890123456789">Magnet</a>' +
  '</td></tr></tbody></table></html>';
http.createServer((req, res) => {
  if (req.url === '/_health') { res.writeHead(200); res.end('ok'); return; }
  if (req.url === '/_history') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(history)); return; }
  const match = /^\/(cf|dd)\/search\/[^/?]+\//.exec(req.url ?? '');
  if (!match) { res.writeHead(404); res.end('fixture route not found'); return; }
  const mode = match[1];
  const cookie = req.headers.cookie ?? '';
  history.push({ mode, cookie, userAgent: req.headers['user-agent'] ?? '' });
  const allowed = cookie.includes(mode === 'cf' ? 'cf_clearance=fixture-clearance' : 'datadome=fixture-clearance');
  if (allowed) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); return; }
  if (mode === 'cf') {
    res.writeHead(503, { 'content-type': 'text/html', server: 'cloudflare' });
    res.end('<html><title>Just a moment...</title><script>setTimeout(() => {' +
      'document.cookie="cf_clearance=fixture-clearance; path=/"; location.reload();}, 100)</script></html>');
  } else {
    res.writeHead(403, { 'content-type': 'text/html', 'x-dd-b': '1', server: 'datadome' });
    res.end('<html><title>Ready</title><script>var dd={"rt":"i","host":"geo.captcha-delivery.com"};' +
      'setTimeout(() => {document.cookie="datadome=fixture-clearance; path=/";},100)</script></html>');
  }
}).listen(18082, '127.0.0.1');
'''


def command(*args, capture=False, check=True, timeout=60):
    return subprocess.run(args, text=True, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                          stderr=subprocess.PIPE if capture else subprocess.DEVNULL, check=check, timeout=timeout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jackett-dir', type=Path, required=True, help='built pinned Jackett Server net9.0 directory')
    parser.add_argument('--dotnet-root', type=Path, required=True, help='directory containing .NET 9 executable and runtime')
    parser.add_argument('--bridge-image', required=True, help='locally built Moli bridge image')
    parser.add_argument('--runner-image', default='rust:1.96.1-bookworm', help='local image with curl')
    args = parser.parse_args()
    app = args.jackett_dir.resolve(strict=True)
    sdk = args.dotnet_root.resolve(strict=True)
    deps = json.loads((app / 'jackett.deps.json').read_text())
    if 'FlareSolverrSharp/4.0.0-moli.1' not in deps['libraries']:
        raise SystemExit('Jackett build does not reference the patched FlareSolverrSharp package')
    template = (app / 'Definitions/torrentkitty.yml').read_text()
    if 'id: torrentkitty' not in template or 'table#archiveResult' not in template:
        raise SystemExit('Unexpected TorrentKitty definition')
    token = uuid.uuid4().hex[:12]
    app_name = f'moli-jackett-e2e-{token}'
    bridge_name = f'moli-jackett-bridge-{token}'
    api_key = 'fixture' + '0' * 25
    with tempfile.TemporaryDirectory(prefix='moli-jackett-e2e-') as temporary:
        root = Path(temporary)
        config = root / 'config'
        definitions = config / 'cardigann/definitions'
        indexers = config / 'Jackett/Indexers'
        definitions.mkdir(parents=True)
        indexers.mkdir(parents=True)
        (config / 'Jackett/ServerConfig.json').write_text(json.dumps({
            'APIKey': api_key, 'InstanceId': 'fixture-instance', 'Port': 49117,
            'LocalBindAddress': '127.0.0.1', 'AllowExternal': False, 'CacheEnabled': False,
            'FlareSolverrUrl': 'http://127.0.0.1:8191/', 'FlareSolverrMaxTimeout': 12000,
            'UpdateDisabled': True,
        }))
        for mode in ('cf', 'dd'):
            name = f'molitest{mode}'
            definition = template.replace('id: torrentkitty', f'id: {name}', 1)
            definition = definition.replace('name: TorrentKitty', f'name: Moli fixture {mode}', 1)
            definition, count = re.subn(r'(?ms)^links:\n.*?^caps:', f'links:\n  - http://127.0.0.1:18082/{mode}/\n\ncaps:', definition, count=1)
            if count != 1:
                raise SystemExit('Unable to replace fixture links')
            (definitions / f'{name}.yml').write_text(definition)
            (indexers / f'{name}.json').write_text('[]')
        fixture = root / 'fixture.mjs'
        fixture.write_text(FIXTURE)
        for path in [config, config / 'Jackett', definitions.parent, definitions, indexers]:
            path.chmod(0o777)
        fixture.chmod(0o644)
        for path in [config / 'Jackett/ServerConfig.json', *definitions.iterdir(), *indexers.iterdir()]:
            path.chmod(0o666)
        try:
            command('docker', 'run', '-d', '--pull=never', '--network', 'none', '--user', '65534:65534', '--name', app_name,
                    '--mount', f'type=bind,src={sdk},dst=/sdk,readonly', '--mount', f'type=bind,src={app},dst=/app,readonly',
                    '--mount', f'type=bind,src={config},dst=/config', '-e', 'XDG_CONFIG_HOME=/config',
                    '-e', 'DOTNET_CLI_HOME=/tmp/dotnet-home', '-e', 'DOTNET_CLI_TELEMETRY_OPTOUT=1',
                    args.runner_image, '/sdk/dotnet', '/app/jackett.dll', '--NoUpdates', '--ListenPrivate', '--Port', '49117')
            command('docker', 'run', '-d', '--pull=never', '--network', f'container:{app_name}', '--name', bridge_name,
                    '--mount', f'type=bind,src={fixture},dst=/fixture.mjs,readonly', '-e', 'MOLI_MODE=bridge', args.bridge_image)
            command('docker', 'exec', '-d', bridge_name, 'node', '/fixture.mjs')
            for _ in range(60):
                health = command('docker', 'exec', bridge_name, 'node', '-e',
                                 'Promise.all([fetch("http://127.0.0.1:8191/health"),fetch("http://127.0.0.1:18082/_health")]).then(r=>process.exit(r.every(x=>x.ok)?0:1)).catch(()=>process.exit(1))', check=False)
                jackett = command('docker', 'exec', app_name, 'curl', '-fsS', '--max-time', '2', '-o', '/dev/null',
                                  'http://127.0.0.1:49117/health', check=False)
                if health.returncode == 0 and jackett.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError('Disposable Jackett, bridge or fixture did not become healthy')
            for mode in ('cf', 'dd'):
                url = f'http://127.0.0.1:49117/api/v2.0/indexers/molitest{mode}/results/torznab/api?apikey={api_key}&t=search&q=fixture'
                result = command('docker', 'exec', app_name, 'curl', '-fsS', '--max-time', '35', url, capture=True, timeout=45)
                xml = ET.fromstring(result.stdout)
                titles = [node.text or '' for node in xml.findall('.//item/title')]
                if not any('Moli Fixture Release' in title for title in titles):
                    raise RuntimeError(f'{mode} search did not return the fixture release: {result.stdout[:1500]}')
                if '0123456789012345678901234567890123456789' not in result.stdout:
                    raise RuntimeError(f'{mode} search did not return the fixture magnet hash')
            response = command('docker', 'exec', bridge_name, 'node', '-e',
                               'fetch("http://127.0.0.1:18082/_history").then(r=>r.text()).then(console.log)', capture=True)
            history = json.loads(response.stdout)
            for mode, cookie in [('cf', 'cf_clearance=fixture-clearance'), ('dd', 'datadome=fixture-clearance')]:
                entries = [entry for entry in history if entry['mode'] == mode]
                if len(entries) < 3 or cookie in entries[0]['cookie'] or cookie not in entries[-1]['cookie']:
                    raise RuntimeError(f'{mode} fixture did not observe initial request, browser visit and cookie retry')
                if not entries[1]['userAgent'] or entries[-1]['userAgent'] != entries[1]['userAgent']:
                    raise RuntimeError(f'{mode} retry did not use the bridge browser User-Agent')
        except Exception:
            for name in (app_name, bridge_name):
                result = command('docker', 'logs', '--tail', '35', name, capture=True, check=False)
                if result.stdout or result.stderr:
                    print(f'{name} logs:\n{result.stdout}{result.stderr}')
            raise
        finally:
            command('docker', 'rm', '-f', bridge_name, app_name, check=False)
            cleaned = command('docker', 'run', '--rm', '--pull=never', '--network', 'none', '--user', '65534:65534',
                              '--mount', f'type=bind,src={config},dst=/config', args.runner_image,
                              'sh', '-c', 'find /config -mindepth 1 -depth -delete', capture=True, check=False)
            if cleaned.returncode:
                raise RuntimeError(f'Unable to remove disposable Jackett configuration: {cleaned.stderr}')
    print('PASS complete Jackett Torznab searches: Cloudflare navigation and DataDome cookie recovery')


if __name__ == '__main__':
    main()
