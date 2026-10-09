"""Test the unmodified Firefox bundle with local YouTube/API fixtures.

Requires Python cryptography, Firefox and geckodriver. The HTTPS fixture proxy
and self-signed certificate exist only in this isolated WebDriver session.
No user profile, system proxy or system certificate store is changed.
The default uses a mock API; --real-api accepts credentials through stdin.
The disposable Firefox profile is removed on exit; downloaded SRT evidence remains.
"""
import argparse
import base64
import datetime
import http.server
import json
import pathlib
import shutil
import socket
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'output' / ('firefox-live' if '--live-only' in sys.argv else 'firefox')
OUT.mkdir(parents=True, exist_ok=True)
ADDON_ID = 'youtube-bilingual-local@local.extension'
STATE = {'requests': [], 'failure': 0, 'caption_mode': 'json3', 'delay': 0}
CHECKS = []


def check(name, condition):
    if not condition:
        raise AssertionError(name)
    CHECKS.append(name)
    print('PASS:', name, flush=True)


class ApiHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        subtitles = json.loads(body['messages'][1]['content'])['subtitles']
        record = {'path': self.path, 'model': body['model'], 'count': len(subtitles), 'ids': [cue['id'] for cue in subtitles], 'texts': [cue['text'] for cue in subtitles], 'completed': False, 'has_test_auth': self.headers.get('Authorization') == 'Bearer fixture-key'}
        STATE['requests'].append(record)
        code = STATE['failure'] or 200
        STATE['failure'] = 0
        delay = STATE['delay']
        STATE['delay'] = 0
        if delay:
            time.sleep(delay)
        translations = {'Hello world.': '你好，世界。', 'Second subtitle.': '第二条字幕。', 'After seeking.': '跳转后的字幕。', 'A distant subtitle.': '远处的字幕。'}
        payload = {'choices': [{'message': {'content': json.dumps({'translations': [{'id': cue['id'], 'text': translations.get(cue['text'], '测试译文：' + cue['text'])} for cue in subtitles]}, ensure_ascii=False)}}]}
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
            record['completed'] = True
        except (BrokenPipeError, ConnectionResetError):
            record['aborted'] = True


def create_tls():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'YouTube local test fixture')])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=1))
            .not_valid_after(now + datetime.timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('www.youtube.com')]), critical=False).sign(key, hashes.SHA256()))
    (OUT / 'fixture-cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (OUT / 'fixture-key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(OUT / 'fixture-cert.pem', OUT / 'fixture-key.pem')
    return context


TLS = create_tls()


def read_request(stream):
    first = stream.readline(65536)
    if not first:
        return None
    headers = {}
    while True:
        line = stream.readline(65536)
        if line in (b'\r\n', b'\n', b''):
            break
        name, _, value = line.decode('latin1').partition(':')
        headers[name.lower()] = value.strip()
    return first.decode('latin1').split(), headers


class FixtureProxy(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(15)
        request = read_request(self.rfile)
        if not request:
            return
        parts, _ = request
        if parts[:2] != ['CONNECT', 'www.youtube.com:443']:
            self.wfile.write(b'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            return
        self.wfile.write(b'HTTP/1.1 200 Connection established\r\n\r\n')
        self.wfile.flush()
        try:
            with TLS.wrap_socket(self.connection, server_side=True) as conn:
                stream = conn.makefile('rb')
                inner = read_request(stream)
                if not inner:
                    return
                path = inner[0][1]
                if path.startswith('/fixture.webm'):
                    data = (ROOT / 'tests/fixtures/player.webm').read_bytes()
                    content_type = 'video/webm'
                elif path.startswith('/api/timedtext'):
                    if STATE['caption_mode'] == 'empty':
                        data = b''
                    elif STATE['caption_mode'] == 'xml':
                        data = b'<timedtext><body><p t="0" d="2000">XML caption.</p><p t="3000" d="2000">Second subtitle.</p><p t="8000" d="2000">After seeking.</p><p t="150000" d="2000">A distant subtitle.</p></body></timedtext>'
                    else:
                        data = json.dumps({'events': [{'tStartMs': t, 'dDurationMs': 2000, 'segs': [{'utf8': text}]} for t, text in [(0, 'Hello world.'), (3000, 'Second subtitle.'), (8000, 'After seeking.'), (150000, 'A distant subtitle.')]]}).encode()
                    content_type = 'application/json'
                else:
                    data = (ROOT / 'tests/fixtures/youtube.html').read_bytes()
                    content_type = 'text/html; charset=utf-8'
                conn.sendall(f'HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n'.encode() + data)
        except (OSError, ssl.SSLError):
            pass


class ThreadingProxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Driver:
    def __init__(self, port):
        self.base = f'http://127.0.0.1:{port}'
        self.session = None
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, path, data=None, method=None):
        payload = json.dumps(data).encode() if data is not None else None
        request = urllib.request.Request(self.base + path, data=payload, method=method or ('POST' if payload else 'GET'), headers={'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=90) as response:
                value = json.load(response)['value']
        except urllib.error.HTTPError as error:
            value = json.load(error)['value']
        if isinstance(value, dict) and isinstance(value.get('error'), str) and 'message' in value:
            raise RuntimeError(value['error'] + ': ' + value.get('message', ''))
        return value

    def cmd(self, path, data=None, method=None):
        return self.call('/session/' + self.session + path, data, method)

    def js(self, script, *args):
        return self.cmd('/execute/sync', {'script': script, 'args': list(args)})

    def async_js(self, script, *args):
        return self.cmd('/execute/async', {'script': script, 'args': list(args)})

    def click(self, selector):
        element = self.cmd('/element', {'using': 'css selector', 'value': selector})
        return self.cmd('/element/' + element['element-6066-11e4-a52e-4f735466cecf'] + '/click', {})

    def wait(self, expression, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = self.js('return ' + expression)
            if value:
                return value
            time.sleep(.15)
        raise AssertionError('Timed out: ' + expression + ' | ' + str(self.js('return document.body.innerText.slice(-1400)')))


def extension_url(driver):
    driver.cmd('/moz/context', {'context': 'chrome'})
    uuid = driver.js("return JSON.parse(Services.prefs.getCharPref('extensions.webextensions.uuids'))[arguments[0]]", ADDON_ID)
    driver.cmd('/moz/context', {'context': 'content'})
    return f'moz-extension://{uuid}/options.html'


def extension_message(driver, message):
    response = driver.async_js("const done=arguments[arguments.length-1];browser.runtime.sendMessage(arguments[0]).then(done,error=>done({ok:false,error:error.message}))", message)
    if not response or not response.get('ok'):
        raise AssertionError('Extension request failed: ' + str(response))
    return response.get('data')


def wait_job(driver, job_id, state='complete', timeout=15):
    deadline = time.monotonic() + timeout
    result = None
    while time.monotonic() < deadline:
        result = extension_message(driver, {'type': 'track:status', 'id': job_id})
        if result and result.get('state') == state:
            return result
        time.sleep(.15)
    raise AssertionError('Background job did not reach ' + state + ': ' + str(result))


def save_and_authorize(driver):
    driver.click('#save')
    # Approve only this isolated Firefox session's optional-host prompt.
    driver.cmd('/moz/context', {'context': 'chrome'})
    for _ in range(40):
        if driver.js("return !!document.querySelector('#addon-webext-permissions-notification:not([hidden]) .popup-notification-primary-button')"):
            driver.js("document.querySelector('#addon-webext-permissions-notification .popup-notification-primary-button').click()")
            break
        time.sleep(.1)
    driver.cmd('/moz/context', {'context': 'content'})
    driver.wait("document.getElementById('status').textContent.includes('已保存')")


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--live', action='store_true', help='Also attempt a public YouTube page through the real network.')
    args.add_argument('--live-only', action='store_true', help='Skip the already verified local player cases.')
    args.add_argument('--video', default='dQw4w9WgXcQ', help='Public YouTube video ID used by the live probe.')
    args.add_argument('--real-api', action='store_true', help='Read private API configuration from stdin; only valid with --live-only.')
    args.add_argument('--firefox', default=r'C:\Program Files\Mozilla Firefox\firefox.exe')
    args.add_argument('--geckodriver', default=str(ROOT / '.tools/geckodriver/geckodriver.exe'))
    options = args.parse_args()
    if options.live_only:
        options.live = True
    if options.real_api and not options.live_only:
        args.error('--real-api requires --live-only')
    real_api = json.loads(sys.stdin.readline()) if options.real_api else None
    api = http.server.ThreadingHTTPServer(('127.0.0.1', 0), ApiHandler)
    proxy = ThreadingProxy(('127.0.0.1', 0), FixtureProxy)
    for server in [api, proxy]:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    addon = OUT / 'firefox-under-test.zip'
    with zipfile.ZipFile(addon, 'w', zipfile.ZIP_DEFLATED) as archive:
        for file in (ROOT / 'build/firefox').iterdir():
            if file.is_file():
                archive.write(file, file.name)
    port = free_port()
    log = open(OUT / 'geckodriver.log', 'w', encoding='utf-8')
    creationflags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, 'CREATE_NO_WINDOW') else 0
    process = subprocess.Popen([options.geckodriver, '--port', str(port), '--allow-system-access'], stdout=log, stderr=log, creationflags=creationflags)
    driver = Driver(port)
    profile = pathlib.Path(tempfile.mkdtemp(prefix='isolated-profile-', dir=OUT))
    download_dir = pathlib.Path(tempfile.mkdtemp(prefix='downloads-', dir=OUT))
    capabilities = {'browserName': 'firefox', 'acceptInsecureCerts': True,
        'moz:firefoxOptions': {'binary': options.firefox, 'args': ['-headless', '-profile', str(profile)], 'prefs': {
            'network.proxy.type': 1, 'network.proxy.ssl': '127.0.0.1', 'network.proxy.ssl_port': proxy.server_address[1],
            'network.proxy.http': '127.0.0.1', 'network.proxy.http_port': proxy.server_address[1], 'network.proxy.no_proxies_on': 'localhost,127.0.0.1',
            'network.http.http3.enable': False, 'browser.download.folderList': 2,
            'browser.download.dir': str(download_dir), 'browser.download.useDownloadDir': True,
            'browser.download.alwaysOpenPanel': False,
        }}}
    report = {'checks': CHECKS, 'live': {'attempted': False}}
    try:
        for _ in range(100):
            try:
                driver.call('/status')
                break
            except (OSError, RuntimeError):
                time.sleep(.1)
        result = driver.call('/session', {'capabilities': {'alwaysMatch': capabilities}})
        driver.session = result['sessionId']
        report['firefoxVersion'] = result['capabilities']['browserVersion']
        driver.cmd('/window/rect', {'width': 1200, 'height': 850})
        installed = driver.cmd('/moz/addon/install', {'path': str(addon), 'temporary': True})
        check('production bundle installs in Firefox', installed == ADDON_ID)
        options_url = extension_url(driver)
        driver.cmd('/url', {'url': options_url})
        driver.wait("document.getElementById('apiBaseUrl').value.includes('openai')")
        config = real_api or {'apiBaseUrl': f'http://127.0.0.1:{api.server_address[1]}/v1', 'apiKey': 'fixture-key', 'model': 'fixture-model', 'targetLanguage': 'zh-CN'}
        driver.js("for (const [key,value] of Object.entries(arguments[0])) document.getElementById(key).value=value", config)
        report['translationService'] = { 'real': options.real_api, 'endpoint': config['apiBaseUrl'], 'model': config['model'] }
        save_and_authorize(driver)
        check('settings UI saves API and grants configured host', True)
        driver.click('#test')
        driver.wait("document.getElementById('status').textContent.includes('连接成功')")
        check('test connection uses Firefox background fetch to configured API', True if options.real_api else STATE['requests'][-1]['has_test_auth'])
        if not options.real_api:
            test_before = len(STATE['requests'])
            for index in range(2):
                driver.click('#test')
                deadline = time.monotonic() + 10
                while len(STATE['requests']) < test_before + index + 1 and time.monotonic() < deadline:
                    time.sleep(.1)
                driver.wait("document.getElementById('status').textContent.includes('连接成功')")
            check('each repeated test-connection click makes a new API request', len(STATE['requests']) == test_before + 2)
        if options.real_api:
            driver.cmd('/url', {'url': 'https://www.youtube.com/watch?v=fixture0001'})
            driver.wait("document.querySelector('.ytbl-toggle')?.parentElement.classList.contains('ytp-right-controls')")
            driver.wait("document.querySelector('video').duration > 10")
            driver.click('.ytbl-toggle')
            driver.wait("document.querySelector('.ytbl-status').textContent.includes('已翻译') && !document.querySelector('.ytbl-overlay').hidden && document.querySelector('.ytbl-translated').textContent !== '翻译中…'", 55)
            report['realApiPlayer'] = driver.js("return {original:document.querySelector('.ytbl-original').textContent,translated:document.querySelector('.ytbl-translated').textContent,embedded:document.querySelector('.ytbl-overlay').parentElement.id==='movie_player'}")
            check('real API produces Chinese bilingual subtitles inside Firefox player', report['realApiPlayer']['embedded'] and report['realApiPlayer']['original'] == 'Hello world.')
            (OUT / 'real-api-player.png').write_bytes(base64.b64decode(driver.cmd('/screenshot')))
            driver.click('.ytbl-toggle')
        if not options.live_only:
            driver.cmd('/url', {'url': 'https://www.youtube.com/watch?v=fixture0001'})
            driver.wait("document.querySelector('.ytbl-toggle')")
            driver.wait("document.querySelector('.ytbl-toggle').parentElement.classList.contains('ytp-right-controls')")
            check('delayed YouTube controls receive the extension button', True)
            driver.wait("document.querySelector('video').duration > 160")
            before = len(STATE['requests'])
            time.sleep(.8)
            check('no translation request before enable', len(STATE['requests']) == before)
            STATE['delay'] = 3
            driver.js("document.querySelector('video').play()")
            driver.click('.ytbl-toggle')
            driver.wait("document.querySelector('.ytbl-progress')?.textContent === '正在翻译' && !document.querySelector('.ytbl-progress').hidden")
            driver.wait("document.querySelector('.ytp-caption-segment').textContent === 'Hello world.'")
            start_time = driver.js("return document.querySelector('video').currentTime")
            time.sleep(.35)
            check('whole-track wait shows progress and keeps native CC and playback active', driver.js("return !document.querySelector('video').paused && document.querySelector('video').currentTime > arguments[0] && getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility === 'visible' && document.querySelector('.ytbl-overlay').hidden", start_time))
            driver.js("document.querySelector('video').pause();document.querySelector('video').currentTime=.5")
            driver.wait("document.querySelector('.ytbl-translated')?.textContent === '你好，世界。'")
            driver.wait("document.querySelector('.ytbl-status').textContent.includes('4 / 4')")
            check('one API request translates the complete track including the distant cue', len(STATE['requests']) == before + 1 and STATE['requests'][-1]['count'] == 4 and 'A distant subtitle.' in STATE['requests'][-1]['texts'])
            check('auto mode follows native caption language instead of first sorted track', driver.js("return document.getElementById('movie_player').getOption('captions','track').languageCode === 'en'"))
            driver.js("document.querySelector('.ytbl-track').value='.ja';document.querySelector('.ytbl-track').dispatchEvent(new Event('change'))")
            driver.wait("document.getElementById('movie_player').getOption('captions','track').languageCode === 'ja' && document.querySelector('.ytbl-translated').textContent === '你好，世界。' && document.querySelector('.ytbl-status').textContent.includes('4 / 4')")
            after_japanese = len(STATE['requests'])
            driver.js("document.querySelector('.ytbl-track').value='.en';document.querySelector('.ytbl-track').dispatchEvent(new Event('change'))")
            driver.wait("document.getElementById('movie_player').getOption('captions','track').languageCode === 'en' && document.querySelector('.ytbl-translated').textContent === '你好，世界。'")
            check('source track selector translates each language once and reuses completed English', after_japanese == before + 2 and len(STATE['requests']) == after_japanese)

            STATE['delay'] = 4
            retry_before = len(STATE['requests'])
            driver.js("document.querySelector('.ytbl-retry').click()")
            driver.wait("!document.querySelector('.ytbl-progress').hidden && document.querySelector('.ytbl-progress').textContent === '正在翻译'")
            check('retranslation removes old bilingual overlay and shows native CC plus progress', driver.js("return document.querySelector('.ytbl-overlay').hidden && getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility === 'visible' && document.querySelector('.ytp-caption-segment').textContent === 'Hello world.'"))
            driver.js("document.getElementById('movie_player').classList.add('ad-showing');document.querySelector('.ytp-subtitles-button').setAttribute('aria-pressed','false')")
            driver.wait("document.querySelector('.ytbl-progress').hidden")
            driver.js("document.getElementById('movie_player').classList.remove('ad-showing')")
            driver.wait("document.querySelector('.ytp-subtitles-button').getAttribute('aria-pressed') === 'true' && !document.querySelector('.ytbl-progress').hidden && document.querySelector('.ytbl-overlay').hidden")
            check('advertisement ending while translation is pending restores native caption source', True)
            driver.wait("document.querySelector('.ytbl-status').textContent.includes('4 / 4')")
            check('retranslation including an ad transition issues exactly one whole-track API request', len(STATE['requests']) == retry_before + 1)

            # Revoke only the test API host in the disposable profile. A force
            # submission must fail visibly without continuing to show old data.
            player_handle = driver.cmd('/window')
            permission_handle = driver.cmd('/window/new', {'type': 'tab'})['handle']
            driver.cmd('/window', {'handle': permission_handle})
            driver.cmd('/url', {'url': options_url})
            driver.wait("document.getElementById('model').value === 'fixture-model'")
            removed = driver.async_js("const done=arguments[arguments.length-1];browser.permissions.remove({origins:['http://127.0.0.1/*']}).then(done)")
            check('test can revoke its API permission in the isolated profile', removed)
            driver.cmd('/window', {'handle': player_handle})
            permission_before = len(STATE['requests'])
            driver.js("document.querySelector('.ytbl-retry').click()")
            driver.wait("document.querySelector('.ytbl-status').textContent.includes('授权')")
            driver.wait("document.querySelector('.ytbl-overlay').hidden && getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility === 'visible'")
            check('rejected retranslation restores native CC without stale bilingual content or API call', len(STATE['requests']) == permission_before and driver.js("return document.querySelector('.ytbl-overlay').hidden && getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility === 'visible'"))
            driver.cmd('/window', {'handle': permission_handle})
            save_and_authorize(driver)
            driver.cmd('/window', method='DELETE')
            driver.cmd('/window', {'handle': player_handle})
            driver.js("document.querySelector('.ytbl-retry').click()")
            driver.wait("document.querySelector('.ytbl-status').textContent.includes('4 / 4')")
            check('explicit retry after API authorization restores the complete bilingual track', len(STATE['requests']) == permission_before + 1)
            after_japanese = len(STATE['requests'])
            check('MAIN fetch capture translates JSON3 into embedded bilingual overlay', driver.js("return document.querySelector('.ytbl-overlay').parentElement.id === 'movie_player' && document.querySelector('.ytbl-original').textContent === 'Hello world.'"))
            driver.wait("!document.querySelector('.ytbl-overlay').hidden && document.getElementById('movie_player').classList.contains('ytbl-rendering')")
            check('native captions hidden during bilingual display', driver.js("return getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility === 'hidden'"))
            driver.js("document.querySelector('video').currentTime = 6")
            driver.wait("document.querySelector('.ytbl-overlay').hidden")
            check('subtitle gap clears overlay', True)
            check('native captions remain visible when bilingual overlay has no text', driver.js("return getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility === 'visible'"))
            driver.js("document.querySelector('video').currentTime = 150.5")
            driver.wait("document.querySelector('.ytbl-translated').textContent === '远处的字幕。'")
            driver.js("document.querySelector('video').currentTime = .5")
            driver.wait("document.querySelector('.ytbl-translated').textContent === '你好，世界。'")
            check('distant forward and backward seek use the already complete timeline', len(STATE['requests']) == after_japanese)
            driver.js("const old=document.querySelector('video');const replacement=document.createElement('video');replacement.src='/fixture.webm';replacement.preload='auto';document.querySelector('.ytp-subtitles-button').setAttribute('aria-pressed','false');document.querySelector('.ytp-subtitles-button').setAttribute('aria-disabled','true');old.replaceWith(replacement);setTimeout(()=>document.querySelector('.ytp-subtitles-button').setAttribute('aria-disabled','false'),600)")
            driver.wait("document.querySelector('.ytp-subtitles-button').getAttribute('aria-pressed') === 'true' && document.querySelector('video').duration > 160")
            driver.wait("document.querySelector('.ytbl-translated').textContent === '你好，世界。'")
            check('same-video element replacement and delayed CC readiness recover automatically', True)
            driver.js("document.querySelector('video').currentTime = 8.1; document.querySelector('video').playbackRate = 2; document.querySelector('video').play()")
            driver.wait("document.querySelector('video').currentTime > 8.6")
            driver.js("document.querySelector('video').pause()")
            paused_time = driver.js("return document.querySelector('video').currentTime")
            time.sleep(.3)
            check('native playback, 2x speed and pause keep subtitles synchronized', abs(driver.js("return document.querySelector('video').currentTime") - paused_time) < .02 and driver.js("return document.querySelector('.ytbl-translated').textContent === '跳转后的字幕。'"))
            driver.js("document.querySelector('video').currentTime = .5")
            driver.js("document.getElementById('movie_player').classList.add('ad-showing')")
            driver.wait("document.querySelector('.ytbl-overlay').hidden")
            driver.js("document.getElementById('movie_player').classList.remove('ad-showing')")
            driver.wait("!document.querySelector('.ytbl-overlay').hidden")
            check('advertisement suppresses overlay and resumes after ad', True)
            driver.js("const b=document.createElement('button');b.id='fixture-fullscreen';b.textContent='Fullscreen';b.onclick=()=>document.getElementById('movie_player').requestFullscreen();document.querySelector('.ytp-right-controls').append(b)")
            driver.click('#fixture-fullscreen')
            driver.wait("document.fullscreenElement?.id === 'movie_player'")
            check('overlay remains inside actual Firefox fullscreen element', driver.js("return document.fullscreenElement.contains(document.querySelector('.ytbl-overlay'))"))
            driver.js("document.exitFullscreen()")
            check('seeks, video rebinding, 2x playback, pause, ads and fullscreen send no extra API requests', len(STATE['requests']) == after_japanese)
            (OUT / 'bilingual-player.png').write_bytes(base64.b64decode(driver.cmd('/screenshot')))
            driver.click('.ytbl-toggle')
            check('disable restores native caption visibility and prior CC state', driver.js("return getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility === 'visible' && document.querySelector('.ytp-subtitles-button').getAttribute('aria-pressed') === 'false'"))
            STATE['caption_mode'] = 'xml'
            driver.js("history.pushState({},'', '/watch?v=fixture0002'); document.dispatchEvent(new Event('yt-navigate-finish'))")
            driver.click('.ytbl-toggle')
            driver.wait("document.querySelector('.ytbl-original').textContent === 'XML caption.' && document.querySelector('.ytbl-translated').textContent === '测试译文：XML caption.'")
            check('Firefox DOMParser reads YouTube XML timed captions', True)
            STATE['caption_mode'] = 'json3'
            driver.js("history.pushState({},'', '/watch?v=fixture0003'); document.dispatchEvent(new Event('yt-navigate-finish'))")
            driver.wait("document.querySelector('.ytbl-status').textContent.includes('4 / 4')")
            check('YouTube SPA navigation resets and reattaches current video', driver.js("return document.querySelectorAll('.ytbl-toggle').length === 1"))
            driver.click('.ytbl-toggle')
            STATE['caption_mode'] = 'empty'
            driver.js("window.fixtureLiveOnly=true;history.pushState({},'', '/watch?v=fixture0004'); document.dispatchEvent(new Event('yt-navigate-finish'))")
            no_source_before = len(STATE['requests'])
            driver.click('.ytbl-toggle')
            driver.wait("document.querySelector('.ytbl-status').textContent.includes('字幕') && !document.querySelector('.ytbl-status').textContent.includes('正在') && document.querySelector('.ytp-caption-segment').textContent === 'Live caption only.'", 25)
            time.sleep(.8)
            check('unavailable whole-track source sends no API request and never translates native DOM fragments', len(STATE['requests']) == no_source_before and driver.js("return document.querySelector('.ytbl-overlay').hidden && getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility === 'visible'"))
            STATE['caption_mode'] = 'json3'
            driver.click('.ytbl-toggle')
            driver.js("window.fixtureLiveOnly=false;history.pushState({},'', '/watch?v=fixture0005'); document.dispatchEvent(new Event('yt-navigate-finish'))")
            STATE['failure'] = 429
            driver.click('.ytbl-toggle')
            driver.wait("document.querySelector('.ytbl-status').textContent.includes('429')")
            before = len(STATE['requests'])
            time.sleep(1)
            check('API error stops requests and exposes retry', len(STATE['requests']) == before and driver.js("return !document.querySelector('.ytbl-panel').hidden"))
            driver.js("document.querySelector('.ytbl-retry').click()")
            driver.wait("document.querySelector('.ytbl-status').textContent.includes('4 / 4')")
            check('explicit retry recovers from API error', True)
            driver.click('.ytbl-toggle')

            # Navigate away during a slow translation; the persistent background
            # must finish rather than cancelling ownership with the player page.
            STATE['delay'] = 4
            driver.cmd('/url', {'url': 'https://www.youtube.com/watch?v=fixture0006'})
            driver.wait("document.querySelector('.ytbl-toggle')?.parentElement.classList.contains('ytp-right-controls')")
            driver.click('.ytbl-toggle')
            driver.wait("document.querySelector('.ytbl-progress')?.textContent === '正在翻译'")
            driver.cmd('/url', {'url': options_url})
            jobs = extension_message(driver, {'type': 'track:list'})
            navigation_job = next(job for job in jobs if job['videoId'] == 'fixture0006')
            wait_job(driver, navigation_job['id'])
            check('navigation away does not cancel the full-track background translation', STATE['requests'][-1]['completed'])

            # Close the originating tab while another options tab is still open.
            options_handle = driver.cmd('/window')
            handle = driver.cmd('/window/new', {'type': 'tab'})['handle']
            driver.cmd('/window', {'handle': handle})
            STATE['delay'] = 4
            driver.cmd('/url', {'url': 'https://www.youtube.com/watch?v=fixture0007'})
            driver.wait("document.querySelector('.ytbl-toggle')?.parentElement.classList.contains('ytp-right-controls')")
            driver.click('.ytbl-toggle')
            driver.wait("document.querySelector('.ytbl-progress')?.textContent === '正在翻译'")
            driver.cmd('/window', method='DELETE')
            driver.cmd('/window', {'handle': options_handle})
            jobs = extension_message(driver, {'type': 'track:list'})
            closed_job = next(job for job in jobs if job['videoId'] == 'fixture0007')
            complete = wait_job(driver, closed_job['id'])
            check('closing the video tab lets background finish and save all translations', complete['translatedCount'] == 4 and len(complete['translations']) == 4)
            report['backgroundJob'] = {key: complete[key] for key in ['id', 'state', 'videoId', 'total', 'translatedCount']}

            exports = []
            for mode in ['original', 'translated', 'bilingual']:
                result = extension_message(driver, {'type': 'track:export', 'id': closed_job['id'], 'mode': mode})
                text = result['content']
                check(f'{mode} SRT export retains distant timing and selected language', '00:02:30,000 --> 00:02:32,000' in text and ('Hello world.' in text) == (mode != 'translated') and ('你好，世界。' in text) == (mode != 'original') and (mode != 'bilingual' or 'Hello world.\r\n你好，世界。' in text))
                downloaded = extension_message(driver, {'type': 'track:download', 'id': closed_job['id'], 'mode': mode, 'saveAs': False})
                deadline = time.monotonic() + 10
                entry = None
                while time.monotonic() < deadline:
                    rows = driver.async_js("const done=arguments[arguments.length-1];browser.downloads.search({id:arguments[0]}).then(done)", downloaded['downloadId'])
                    entry = rows[0] if rows else None
                    if entry and entry['state'] == 'complete':
                        break
                    time.sleep(.1)
                check(f'{mode} SRT downloads through the actual Firefox downloads API', entry and entry['state'] == 'complete' and pathlib.Path(entry['filename']).read_text(encoding='utf-8').replace('\n', '\r\n') == text)
                exports.append({'mode': mode, 'filename': entry['filename'], 'downloadId': downloaded['downloadId']})
            report['exports'] = exports

            cached_before = len(STATE['requests'])
            driver.cmd('/url', {'url': 'https://www.youtube.com/watch?v=fixture0007'})
            driver.wait("document.querySelector('.ytbl-toggle')?.parentElement.classList.contains('ytp-right-controls')")
            driver.click('.ytbl-toggle')
            driver.wait("document.querySelector('.ytbl-status').textContent.includes('4 / 4')")
            check('reopening the video reuses the saved full-track result without API calls', len(STATE['requests']) == cached_before)
            check('player exposes SRT mode selection and export action', driver.js("return [...document.querySelector('.ytbl-export-mode').options].map(o=>o.value).sort().join(',') === 'bilingual,original,translated' && !document.querySelector('.ytbl-export').disabled"))

            # A real Firefox shutdown/restart reuses this test's own profile.
            # The temporary unsigned add-on is reinstalled, as in manual loading.
            driver.call('/session/' + driver.session, method='DELETE')
            driver.session = None
            restarted = driver.call('/session', {'capabilities': {'alwaysMatch': capabilities}})
            driver.session = restarted['sessionId']
            driver.cmd('/moz/addon/install', {'path': str(addon), 'temporary': True})
            options_url = extension_url(driver)
            driver.cmd('/url', {'url': options_url})
            driver.wait("document.getElementById('model').value === 'fixture-model'")
            restored = wait_job(driver, closed_job['id'])
            check('Firefox restart restores the completed track and saved API configuration', restored['translatedCount'] == 4 and len(restored['cues']) == 4)
            driver.cmd('/url', {'url': 'https://www.youtube.com/watch?v=fixture0007'})
            driver.wait("document.querySelector('.ytbl-toggle')?.parentElement.classList.contains('ytp-right-controls')")
            driver.click('.ytbl-toggle')
            driver.wait("document.querySelector('.ytbl-status').textContent.includes('4 / 4')")
            check('cached subtitles render after Firefox restart with no translation request', len(STATE['requests']) == cached_before)
            check('mock requests use configured Chat Completions endpoint and model', all(r['path'] == '/v1/chat/completions' and r['model'] == 'fixture-model' for r in STATE['requests']))
            driver.click('.ytbl-toggle')
        if options.live:
            report['live']['attempted'] = True
            driver.cmd('/moz/context', {'context': 'chrome'})
            driver.js("Services.prefs.setIntPref('network.proxy.type', 0)")
            driver.cmd('/moz/context', {'context': 'content'})
            try:
                driver.cmd('/url', {'url': 'https://www.youtube.com/watch?v=' + options.video})
                driver.wait("document.querySelector('.ytbl-toggle')", 30)
                driver.wait("document.querySelector('.ytbl-toggle')?.parentElement.classList.contains('ytp-right-controls')", 15)
                if driver.js("return document.querySelector('#movie_player video')?.paused"):
                    driver.click('.ytp-play-button')
                report['live']['title'] = driver.js('return document.title')
                report['live']['controlPresent'] = True
                report['live']['tracks'] = driver.js("return [...document.querySelector('.ytbl-track').options].map(o=>o.textContent)")
                if driver.js("return document.querySelector('.ytbl-toggle').getAttribute('aria-pressed') !== 'true'"):
                    driver.click('.ytbl-toggle')
                driver.wait("document.querySelector('.ytbl-toggle').getAttribute('aria-pressed') === 'true'")
                ad_deadline = time.monotonic() + 65
                while time.monotonic() < ad_deadline and driver.js("return document.getElementById('movie_player').classList.contains('ad-showing')"):
                    if driver.js("return document.querySelector('#movie_player video')?.paused"):
                        driver.click('.ytp-play-button')
                    time.sleep(.5)
                if not driver.js("return document.getElementById('movie_player').classList.contains('ad-showing')"):
                    driver.js("document.querySelector('#movie_player video').currentTime = 20")
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline and not driver.js("return document.querySelector('.ytbl-translated')?.textContent && document.querySelector('.ytbl-translated').textContent !== '翻译中…'"):
                        time.sleep(.5)
                report['live']['status'] = driver.js("return document.querySelector('.ytbl-status')?.textContent")
                report['live']['originalVisible'] = driver.js("return document.querySelector('.ytbl-original')?.textContent")
                report['live']['translatedVisible'] = driver.js("return document.querySelector('.ytbl-translated')?.textContent")
                report['live']['player'] = driver.js("return {time:document.querySelector('#movie_player video')?.currentTime,cc:document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'),ad:document.getElementById('movie_player').classList.contains('ad-showing'),native:[...document.querySelectorAll('.ytp-caption-segment')].map(e=>e.textContent).join(' '),error:document.querySelector('.ytp-error-content')?.textContent}")
                report['live']['subtitleVerified'] = bool(report['live']['originalVisible'] and report['live']['translatedVisible'] and report['live']['translatedVisible'] != '翻译中…' and not report['live']['player']['ad'])
                print('LIVE:', json.dumps(report['live'], ensure_ascii=False), flush=True)
                (OUT / 'live-youtube.png').write_bytes(base64.b64decode(driver.cmd('/screenshot')))
                driver.click('.ytbl-toggle')
                if not report['live']['originalVisible']:
                    if driver.js("return document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') !== 'true'"):
                        driver.click('.ytp-subtitles-button')
                    driver.js("document.querySelector('#movie_player video').currentTime = 20")
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline and not driver.js("return document.querySelector('.ytp-caption-segment')?.textContent"):
                        time.sleep(.5)
                    report['live']['nativeBaseline'] = driver.js("return {text:[...document.querySelectorAll('.ytp-caption-segment')].map(e=>e.textContent).join(' '),cc:document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'),track:(()=>{const t=document.getElementById('movie_player').getOption('captions','track');return t?{languageCode:t.languageCode,kind:t.kind,name:t.name}:null})(),captionResponses:performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/timedtext')).map(e=>({bytes:e.decodedBodySize}))}")
                    print('NATIVE BASELINE:', json.dumps(report['live']['nativeBaseline'], ensure_ascii=False), flush=True)
            except (RuntimeError, AssertionError) as error:
                report['live']['error'] = str(error)[:1500]
        report['passed'] = True
    except Exception as error:
        report['passed'] = False
        report['error'] = str(error)
        if driver.session:
            try:
                (OUT / 'failure.png').write_bytes(base64.b64decode(driver.cmd('/screenshot')))
            except Exception:
                pass
        raise
    finally:
        report['apiRequestCount'] = len(STATE['requests'])
        (OUT / ('live-probe.json' if options.live_only else 'report.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        if driver.session:
            try:
                driver.call('/session/' + driver.session, method='DELETE')
            except Exception:
                pass
        process.terminate()
        process.wait(timeout=10)
        log.close()
        api.shutdown(); proxy.shutdown()
        # This is the exact profile created by this invocation, never a user
        # profile or a directory discovered from external input. Remove it so
        # a real-API probe cannot leave credentials in ignored output files.
        safe_profile = profile.resolve()
        if safe_profile.parent != OUT.resolve() or not safe_profile.name.startswith('isolated-profile-'):
            raise RuntimeError('Refusing to clean a profile outside this isolated test directory.')
        for attempt in range(20):
            try:
                shutil.rmtree(safe_profile)
                break
            except FileNotFoundError:
                break
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(.1)
        report['isolatedProfileRemoved'] = not safe_profile.exists()
        (OUT / ('live-probe.json' if options.live_only else 'report.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
