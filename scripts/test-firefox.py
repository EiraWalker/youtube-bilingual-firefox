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
import re
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
from xml.sax.saxutils import escape
import zipfile

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'output' / ('firefox-live' if '--live-only' in sys.argv else 'firefox')
OUT.mkdir(parents=True, exist_ok=True)
ADDON_ID = 'youtube-bilingual-local@local.extension'
FIXTURE_CUES = sorted(
    [(0, 'Hello world.'), (3000, 'Second subtitle.'), (8000, 'After seeking.'),
     (150000, 'A distant subtitle.')]
    + [(second * 1000, f'Fixture caption {second}: ' + 'buffered words ' * 8)
       for second in list(range(20, 150, 5)) + list(range(155, 180, 5))])
STATE = {'requests': [], 'caption_mode': 'json3', 'tag': 'setup', 'controls': {},
         'active': 0, 'peak': 0, 'lock': threading.Lock()}
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
        mt = body['model'].startswith('qwen-mt-')
        mt_protocol_valid = False
        if mt:
            text = body['messages'][0]['content']
            # MT sends raw text, not IDs. Resolve identity only from this known
            # synthetic fixture corpus so the server can gate individual cues.
            cue_id = next((str(index) for index, (_, source) in enumerate(FIXTURE_CUES) if source == text), 'mt-test')
            subtitles = [{'id': cue_id, 'text': text}]
            mt_protocol_valid = (len(body['messages']) == 1 and body['messages'][0]['role'] == 'user'
                and body.get('stream') is False
                and body.get('translation_options') == {'source_lang': 'auto', 'target_lang': 'Chinese'})
        else:
            subtitles = json.loads(body['messages'][1]['content'])['subtitles']
        with STATE['lock']:
            tag = STATE['tag']
            control = STATE['controls'].get(tag, {})
            control = {**control, **control.get('models', {}).get(body.get('model'), {})}
            index = sum(record['tag'] == tag for record in STATE['requests'])
            code = 200
            ids = [cue['id'] for cue in subtitles]
            failures = control.get('failures', {})
            for cue_id in ids:
                if failures.get(cue_id, 0):
                    failures[cue_id] -= 1
                    code = control.get('failure_status', 429)
                    break
            delays = control.get('delays', [])
            delay = delays[index] if index < len(delays) else control.get('delay', .05)
            gates = control.get('gates', [])
            gate = gates[index] if index < len(gates) else control.get('gate')
            if ids[0] in control.get('cue_gates', {}):
                gate = control['cue_gates'][ids[0]]
            STATE['active'] += 1
            STATE['peak'] = max(STATE['peak'], STATE['active'])
            record = {'path': self.path, 'model': body['model'], 'count': len(subtitles),
                      'ids': ids, 'completed': False, 'status': code, 'tag': tag,
                      'started': time.monotonic(), 'active': STATE['active'],
                      'has_test_auth': self.headers.get('Authorization') == 'Bearer fixture-key'}
            STATE['requests'].append(record)
            if mt:
                record['mtProtocolValid'] = mt_protocol_valid
        if gate:
            gate.wait(45)
        if delay:
            time.sleep(delay)
        translations = {'Hello world.': '你好，世界。', 'Second subtitle.': '第二条字幕。', 'After seeking.': '跳转后的字幕。', 'A distant subtitle.': '远处的字幕。'}
        # Exercise compatible providers that return numeric IDs for numeric source IDs.
        content = (control.get('prefix', '') + translations.get(subtitles[0]['text'], '测试译文：' + subtitles[0]['text'])) if mt else json.dumps({'translations': [{'id': int(cue['id']) if cue['id'].isdigit() else cue['id'], 'text': control.get('prefix', '') + translations.get(cue['text'], '测试译文：' + cue['text'])} for cue in subtitles]}, ensure_ascii=False)
        payload = {'choices': [{'message': {'content': content}}]}
        data = json.dumps(payload, ensure_ascii=False).encode()
        try:
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            if code == 429:
                self.send_header('Retry-After', '1')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            record['completed'] = True
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            record['aborted'] = True
        finally:
            with STATE['lock']:
                record['ended'] = time.monotonic()
                STATE['active'] -= 1


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
                        data = ('<timedtext><body>' + ''.join(
                            f'<p t="{t}" d="2000">{escape("XML caption." if t == 0 else text)}</p>'
                            for t, text in FIXTURE_CUES) + '</body></timedtext>').encode()
                    else:
                        data = json.dumps({'events': [{'tStartMs': t, 'dDurationMs': 2000, 'segs': [{'utf8': text}]} for t, text in FIXTURE_CUES]}).encode()
                    content_type = 'application/json'
                else:
                    html = (ROOT / 'tests/fixtures/youtube.html').read_text(encoding='utf-8')
                    native = [[t / 1000, t / 1000 + 2, text] for t, text in FIXTURE_CUES]
                    html = html.replace("[[0, 2, 'Hello world.'], [3, 5, 'Second subtitle.'], [8, 10, 'After seeking.'], [150, 152, 'A distant subtitle.']]", json.dumps(native))
                    data = html.encode()
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
    summary = {key: result.get(key) for key in ['id', 'state', 'total', 'translatedCount']} if result else None
    raise AssertionError('Background job did not reach ' + state + ': ' + str(summary))


def add_live_timing_evidence(live, task):
    """Keep ready-range latency distinct from the first on-screen caption.

    All absolute timestamps use the browser's Date.now clock. The legacy
    firstUsableSeconds field remains the observed on-screen latency; it must
    not silently become a backend-only number that excludes source retrieval.
    """
    metrics = dict(task.get('metrics', {}))
    live['backendMetrics'] = metrics
    live['sourceTrack'] = task.get('track')
    cues = task.get('cues', [])
    position = live.get('playbackPositionAtEnable', 0)
    relevant = next((cue for cue in cues if cue['end'] > position), None)
    live['sourceTiming'] = {
        'cueCount': len(cues),
        'firstCueStart': cues[0]['start'] if cues else None,
        'lastCueEnd': cues[-1]['end'] if cues else None,
        'firstRelevantCueStart': relevant['start'] if relevant else None,
        'firstRelevantCueEnd': relevant['end'] if relevant else None,
        'startedInSubtitleGap': bool(relevant and relevant['start'] > position),
        'sourceSecondsUntilNextCueAtEnable': max(0, relevant['start'] - position) if relevant else None,
    }
    def elapsed(start, end):
        return round((end - start) / 1000, 3) if isinstance(start, (int, float)) and isinstance(end, (int, float)) and start > 0 and end >= start else None
    enabled = live.get('enabledAtEpochMs')
    started = metrics.get('startedAt')
    ready = metrics.get('firstUsableAt')
    live['phaseTimingsSeconds'] = {
        'enableToTaskStart': elapsed(enabled, started),
        'taskStartToFirstSaved': elapsed(started, metrics.get('firstSavedAt')),
        'taskStartToFirstRangeReady': elapsed(started, ready),
        'enableToFirstSaved': elapsed(enabled, metrics.get('firstSavedAt')),
        'enableToFirstRangeReady': elapsed(enabled, ready),
        'enableToFirstOnscreen': elapsed(enabled, live.get('firstOnscreenAtEpochMs')),
        'rangeReadyToFirstOnscreen': elapsed(ready, live.get('firstOnscreenAtEpochMs')),
    }
    live['firstRangeReadySeconds'] = live['phaseTimingsSeconds']['enableToFirstRangeReady']
    live['firstRangeReadyWithin20Seconds'] = live['firstRangeReadySeconds'] <= 20 if live['firstRangeReadySeconds'] is not None else None
    live['firstUsableMetric'] = 'onscreen_current_cue'
    live['rangeReadyMetric'] = 'backend_current_or_next_source_cue_after_durable_save'


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
    global OUT
    args = argparse.ArgumentParser()
    args.add_argument('--live', action='store_true', help='Also attempt a public YouTube page through the real network.')
    args.add_argument('--live-only', action='store_true', help='Skip the already verified local player cases.')
    args.add_argument('--progress-only', action='store_true', help='Test timed player progress without registering the native cache host.')
    args.add_argument('--multi-model-only', action='store_true', help='Test parallel model racing and priority upgrades without registering the native cache host.')
    args.add_argument('--qwen-mt-only', action='store_true', help='Test raw-text MT protocol, partial delivery and cue-local recovery with the local HTTP fixture.')
    args.add_argument('--video', default='dQw4w9WgXcQ', help='Public YouTube video ID used by the live probe.')
    args.add_argument('--real-api', action='store_true', help='Read private API configuration from stdin; only valid with --live-only.')
    args.add_argument('--first-only', action='store_true', help='Measure first usable subtitles, explicitly cancel the task, and skip whole-track exports; requires --live-only.')
    args.add_argument('--report-tag', default='', help='Separate evidence under output using a letters/digits/hyphens tag.')
    args.add_argument('--firefox', default=r'C:\Program Files\Mozilla Firefox\firefox.exe')
    args.add_argument('--geckodriver', default=str(ROOT / '.tools/geckodriver/geckodriver.exe'))
    options = args.parse_args()
    if options.report_tag:
        if not re.fullmatch(r'[\w-]+', options.report_tag):
            args.error('--report-tag must contain only letters, digits, underscores or hyphens')
        OUT = OUT / options.report_tag
        OUT.mkdir(parents=True, exist_ok=True)
    if options.live_only:
        options.live = True
    if (options.progress_only or options.multi_model_only or options.qwen_mt_only) and options.live:
        args.error('Local-only cases cannot be combined with a live probe')
    if sum([options.progress_only, options.multi_model_only, options.qwen_mt_only]) > 1:
        args.error('Choose one local-only browser case')
    if options.real_api and not options.live_only:
        args.error('--real-api requires --live-only')
    if options.first_only and not options.live_only:
        args.error('--first-only requires --live-only')
    try:
        real_api = json.loads(sys.stdin.readline()) if options.real_api else None
    except (ValueError, TypeError):
        args.error('Private API configuration must be valid JSON on stdin.')
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
        'moz:firefoxOptions': {'binary': options.firefox, 'args': ['-headless', '-no-remote', '-new-instance', '-profile', str(profile)], 'prefs': {
            'network.proxy.type': 1, 'network.proxy.ssl': '127.0.0.1', 'network.proxy.ssl_port': proxy.server_address[1],
            'network.proxy.http': '127.0.0.1', 'network.proxy.http_port': proxy.server_address[1], 'network.proxy.no_proxies_on': 'localhost,127.0.0.1',
            'network.http.http3.enable': False, 'browser.download.folderList': 2,
            'browser.download.dir': str(download_dir), 'browser.download.useDownloadDir': True,
            'browser.download.alwaysOpenPanel': False,
        }}}
    report = {'checks': CHECKS, 'live': {'attempted': False, 'firstOnly': options.first_only}}
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
        driver.wait("document.getElementById('apiBaseUrl')?.value.includes('openai')")
        config = real_api or {'apiBaseUrl': f'http://127.0.0.1:{api.server_address[1]}/v1', 'apiKey': 'fixture-key', 'model': 'fixture-model', 'targetLanguage': 'zh-CN'}
        driver.js("for (const [key,value] of Object.entries(arguments[0])) document.getElementById(key).value=value", config)
        report['translationService'] = { 'real': options.real_api, 'endpoint': config['apiBaseUrl'], 'model': config['model'] }
        save_and_authorize(driver)
        report['live']['sourceLanguageSetting'] = driver.js("return document.getElementById('sourceLanguage')?.value || 'auto'")
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
        if options.multi_model_only:
            from firefox_multi_model_cases import run_multi_model_cases
            report.update(run_multi_model_cases(driver, STATE, check, OUT, options_url, config['apiBaseUrl'], FIXTURE_CUES))
        elif options.qwen_mt_only:
            from firefox_qwen_mt_cases import run_qwen_mt_cases
            report.update(run_qwen_mt_cases(driver, STATE, check, OUT, options_url, config['apiBaseUrl']))
        elif options.progress_only:
            from firefox_progress_cases import run_progress_cases
            report.update(run_progress_cases(driver, STATE, check, OUT, FIXTURE_CUES))
        elif not options.live_only:
            from firefox_demand_cases import run_fixture_cases
            options_url, buffered_report = run_fixture_cases(
                driver, options_url, STATE, check, extension_message, wait_job,
                capabilities, addon, extension_url, OUT, len(FIXTURE_CUES))
            report.update(buffered_report)
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
                # Let page navigation and initial auto-enable settle before toggling.
                time.sleep(1)
                driver.wait("document.querySelector('.ytbl-toggle')?.parentElement.classList.contains('ytp-right-controls')", 20)
                driver.wait("document.querySelector('.ytbl-track')?.options[0]?.value", 20)
                translation_started = time.monotonic()
                playback_started = driver.js("return document.querySelector('#movie_player video')?.currentTime || 0")
                report['live']['playbackPositionAtEnable'] = playback_started
                report['live']['sourceSelectionAtEnable'] = driver.js("const select=document.querySelector('.ytbl-track');let native=null;try{const track=document.getElementById('movie_player').getOption('captions','track');native=track?{language:track.languageCode||null,automatic:track.kind==='asr'}:null}catch{}return {value:select?.value,label:select?.selectedOptions[0]?.textContent,native}")
                report['live']['enabledAtEpochMs'] = driver.js('return Date.now()')
                if driver.js("return document.querySelector('.ytbl-toggle').getAttribute('aria-pressed') !== 'true'"):
                    driver.click('.ytbl-toggle')
                driver.wait("document.querySelector('.ytbl-toggle').getAttribute('aria-pressed') === 'true'", 3)
                ad_deadline = time.monotonic() + 65
                while time.monotonic() < ad_deadline and driver.js("return document.getElementById('movie_player').classList.contains('ad-showing')"):
                    if driver.js("return document.querySelector('#movie_player video')?.paused"):
                        driver.click('.ytp-play-button')
                    time.sleep(.5)
                if not driver.js("return document.getElementById('movie_player').classList.contains('ad-showing')"):
                    # Measure the cue at the actual advancing playback position.
                    # A completed segment already behind the viewer is not a
                    # usable first result, and this probe must not pause/rewind
                    # playback to make an old translation appear successful.
                    deadline = time.monotonic() + (620 if options.real_api else 60)
                    next_progress = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        sample = driver.js("const video=document.querySelector('#movie_player video');return {observedAt:Date.now(),time:video?.currentTime,paused:video?.paused,visible:!document.querySelector('.ytbl-overlay')?.hidden,original:document.querySelector('.ytbl-original')?.textContent,translated:document.querySelector('.ytbl-translated')?.textContent,ad:document.getElementById('movie_player').classList.contains('ad-showing')}")
                        if sample['visible'] and sample['original'] and sample['translated'] and sample['translated'] != '翻译中…' and not sample['ad'] and not sample['paused']:
                            report['live']['firstUsableSeconds'] = round(time.monotonic() - translation_started, 3)
                            report['live']['firstUsablePosition'] = sample['time']
                            report['live']['firstOnscreenAtEpochMs'] = sample['observedAt']
                            report['live']['firstUsableWithin20Seconds'] = report['live']['firstUsableSeconds'] <= 20
                            report['live']['playbackAdvanced'] = sample['time'] > playback_started
                            break
                        if time.monotonic() >= next_progress:
                            print('LIVE PROGRESS:', driver.js("return document.querySelector('.ytbl-status')?.textContent"), flush=True)
                            next_progress = time.monotonic() + 15
                        time.sleep(.5)
                report['live']['status'] = driver.js("return document.querySelector('.ytbl-status')?.textContent")
                report['live']['originalVisible'] = driver.js("return document.querySelector('.ytbl-original')?.textContent")
                report['live']['translatedVisible'] = driver.js("return document.querySelector('.ytbl-translated')?.textContent")
                report['live']['player'] = driver.js("return {time:document.querySelector('#movie_player video')?.currentTime,cc:document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'),ad:document.getElementById('movie_player').classList.contains('ad-showing'),native:[...document.querySelectorAll('.ytp-caption-segment')].map(e=>e.textContent).join(' '),error:document.querySelector('.ytp-error-content')?.textContent}")
                report['live']['subtitleVerified'] = bool(report['live'].get('firstUsableSeconds') is not None and report['live'].get('playbackAdvanced'))
                print('LIVE:', json.dumps(report['live'], ensure_ascii=False), flush=True)
                (OUT / 'live-youtube.png').write_bytes(base64.b64decode(driver.cmd('/screenshot')))
                driver.click('.ytbl-toggle')
                if report['live']['subtitleVerified']:
                    driver.cmd('/url', {'url': options_url})
                    jobs = extension_message(driver, {'type': 'track:list'})
                    job = next((j for j in jobs if j['videoId'] == options.video), None)
                    check('live video exposes temporary partial or complete translated rows', job and job['translatedCount'] > 0)
                    if options.first_only:
                        partial = extension_message(driver, {'type': 'track:status', 'id': job['id']})
                        check('first-only probe verifies temporary translations before cancellation', len(partial.get('translations', [])) == partial['translatedCount'] and 0 < partial['translatedCount'] <= partial['total'])
                        report['live']['backgroundJob'] = {key: partial[key] for key in ['state', 'videoId', 'total', 'translatedCount']}
                        report['live']['metrics'] = partial.get('metrics', {})
                        add_live_timing_evidence(report['live'], partial)
                        cancelled = extension_message(driver, {'type': 'track:cancel', 'id': job['id']})
                        check('first-only probe explicitly cancels remaining translation work', cancelled['state'] in ['cancelled', 'complete'])
                        report['live']['cancellation'] = {key: cancelled[key] for key in ['state', 'total', 'translatedCount']}
                        report['live']['exportsSkipped'] = True
                    else:
                        partial = extension_message(driver, {'type': 'track:status', 'id': job['id']})
                        check('live video preserves available translations after disabling display',
                              partial['total'] > 0 and partial['translatedCount'] > 0)
                        report['live']['backgroundJob'] = {key: partial[key] for key in ['state', 'videoId', 'total', 'translatedCount']}
                        report['live']['metrics'] = partial.get('metrics', {})
                        add_live_timing_evidence(report['live'], partial)
                        exported = extension_message(driver, {'type': 'track:export', 'id': job['id'], 'mode': 'original'})
                        check('live original SRT retains the full acquired source timeline', len(re.findall(r'(?m)^\d{2,}:\d{2}:\d{2},\d{3} --> ', exported['content'])) == partial['total'])
                    if not options.real_api:
                        report['live']['mockTranslationRequestCount'] = len(STATE['requests'])
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
            if options.live_only:
                check('public YouTube buffered bilingual subtitles are verified during continuing playback', report['live'].get('subtitleVerified', False) and not report['live'].get('error'))
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
