"""Raw-text MT integration checks in the runner's disposable Firefox profile."""
import base64
from collections import Counter
import threading
import time
from urllib.parse import urlsplit


def run_qwen_mt_cases(driver, state, check, out, options_url, api_url):
    endpoint = urlsplit(api_url)
    if endpoint.scheme != 'http' or endpoint.hostname != '127.0.0.1' or endpoint.path != '/v1':
        raise ValueError('MT integration requires the local fixture endpoint')
    gates, phases = [], {}

    def records(tag):
        with state['lock']:
            return [dict(row, ids=list(row['ids'])) for row in state['requests'] if row['tag'] == tag]

    def until(predicate, label, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(.1)
        raise AssertionError('MT fixture timed out: ' + label)

    def sample():
        return driver.js("""const p=document.querySelector('.ytbl-progress');
            return {text:p?.textContent,hidden:p?.hidden,translated:document.querySelector('.ytbl-translated')?.textContent,
              paused:document.querySelector('video')?.paused,
              nativeVisible:getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility!=='hidden'};""")

    def capture(name):
        (out / (name + '.png')).write_bytes(base64.b64decode(driver.cmd('/screenshot')))

    def open_player(video):
        driver.cmd('/url', {'url': 'https://www.youtube.com/watch?v=' + video})
        driver.wait("document.querySelector('.ytbl-toggle')?.parentElement.classList.contains('ytp-right-controls')")
        driver.wait("document.querySelector('video').duration>175")
        driver.click('.ytbl-toggle')
        driver.js("const v=document.querySelector('video');v.playbackRate=.1;v.currentTime=.2;v.play()")

    def finish(tag, gate_list):
        driver.click('.ytbl-toggle')
        driver.wait("document.querySelector('.ytbl-progress').hidden")
        # Give the pause/disable lease and its public status poll time to settle.
        time.sleep(.8)
        before = len(records(tag))
        for gate in gate_list:
            gate.set()
        until(lambda: all('ended' in row for row in records(tag)), 'all blocked replies released')
        time.sleep(.9)
        check(tag + ': disabling accepts late replies without dispatching another cue', len(records(tag)) == before)
        phases[tag] = records(tag)

    driver.cmd('/url', {'url': options_url})
    driver.wait("document.getElementById('settings-form') && typeof browser!=='undefined'")
    config = {'models': [{'id': 'fixture-mt', 'name': 'Fixture MT', 'model': 'qwen-mt-flash',
        'apiBaseUrl': api_url, 'apiKey': 'fixture-key', 'priority': 1, 'enabled': True}],
        'apiBaseUrl': api_url, 'apiKey': 'fixture-key', 'model': 'qwen-mt-flash',
        'targetLanguage': 'zh-CN', 'sourceLanguage': 'en', 'autoEnable': False,
        'fontSize': 24, 'bottomOffset': 70, 'cacheFolder': ''}
    saved = driver.async_js("""const value=arguments[0],done=arguments[arguments.length-1];
        browser.storage.local.set({settings:value}).then(()=>browser.storage.local.get('settings')).then(actual=>done(JSON.stringify(actual.settings)===JSON.stringify(value)));""", config)
    check('MT synthetic settings are written and read back without real credentials', saved is True)
    try:
        first, second, rest = threading.Event(), threading.Event(), threading.Event()
        gates.extend([first, second, rest])
        tag = 'mt-partials'
        state['tag'] = tag
        state['controls'][tag] = {'gate': rest, 'cue_gates': {'0': first, '1': second}, 'prefix': 'MT:'}
        open_player('mtpartial01')
        until(lambda: len(records(tag)) == 3, 'three independent MT segment requests')
        driver.wait("!document.querySelector('.ytbl-progress').hidden && document.querySelector('.ytbl-progress').textContent.startsWith('正在翻译')")
        check('MT first request shows actual progress and preserves native CC', sample()['nativeVisible'])
        first.set()
        until(lambda: any(row['ids'] == ['1'] for row in records(tag)), 'sequential second cue dispatch')
        driver.wait("document.querySelector('.ytbl-translated').textContent==='MT:你好，世界。' && document.querySelector('.ytbl-progress').hidden")
        check('MT first partial displays before the rest of its segment completes', not second.is_set())
        capture('mt-first-partial')
        driver.js("document.querySelector('video').pause()")
        driver.wait("document.querySelector('.ytbl-status')?.textContent.startsWith('已暂停')")
        second.set()
        until(lambda: any(row['ids'] == ['1'] and 'ended' in row for row in records(tag)), 'second partial delivered while paused')
        time.sleep(.9)
        check('MT pause prevents the next raw-cue HTTP call', not any(row['ids'] == ['2'] for row in records(tag)))
        driver.js("document.querySelector('video').currentTime=3.2")
        driver.wait("document.querySelector('.ytbl-translated').textContent==='MT:第二条字幕。'")
        check('MT partial received while paused is immediately reusable', sample()['paused'] is True)
        driver.js("const v=document.querySelector('video');v.currentTime=8.2;v.play()")
        until(lambda: any(row['ids'] == ['2'] for row in records(tag)), 'resume dispatches only next missing cue')
        driver.wait("!document.querySelector('.ytbl-progress').hidden && document.querySelector('.ytbl-progress').textContent.startsWith('正在翻译')")
        counts = Counter(row['ids'][0] for row in records(tag))
        check('MT resume never replays its paid first two partial results', counts['0'] == counts['1'] == 1)
        finish(tag, [first, second, rest])

        rest, current = threading.Event(), threading.Event()
        gates.extend([rest, current])
        tag = 'mt-length-local'
        state['tag'] = tag
        state['controls'][tag] = {'gate': rest, 'cue_gates': {'0': None, '1': None, '2': current},
            'failures': {'1': 1}, 'failure_status': 413, 'prefix': 'MT:'}
        open_player('mtlength001')
        until(lambda: any(row['ids'] == ['1'] and row['status'] == 413 and 'ended' in row for row in records(tag)), 'single-cue length rejection')
        driver.wait("document.querySelector('.ytbl-translated').textContent==='MT:你好，世界。'")
        time.sleep(.9)
        counts = Counter(row['ids'][0] for row in records(tag))
        check('MT single-cue length rejection cannot replay successful partials or recursively split itself', counts['0'] == counts['1'] == 1)
        driver.js("const v=document.querySelector('video');v.currentTime=8.2;v.play()")
        # The immutable prefetch requests can occupy all three segment slots.
        # Let them finish normally, holding only the newly needed cue's reply.
        rest.set()
        until(lambda: any(row['ids'] == ['2'] for row in records(tag)), 'seek past failed cue reaches untouched cue')
        driver.wait("!document.querySelector('.ytbl-progress').hidden && document.querySelector('.ytbl-progress').textContent.startsWith('正在翻译')")
        check('MT failure on an earlier cue does not poison a later untouched cue after seeking', True)
        capture('mt-seek-after-length-failure')
        finish(tag, [rest, current])

        rows = [row for entries in phases.values() for row in entries]
        check('all MT HTTP calls use one raw user cue and top-level translation options', all(row.get('mtProtocolValid') is True and row['count'] == 1 for row in rows))
        check('all MT requests use only the fixture model, completion path and synthetic authentication',
              all(row['model'] == 'qwen-mt-flash' and row['path'] == '/v1/chat/completions' and row['has_test_auth'] for row in rows))
        check('MT keeps no more than three simultaneous segment HTTP requests', max(row['active'] for row in rows) <= 3)
        return {'qwenMtPhases': phases, 'nativeRegistrationTouched': False}
    finally:
        for gate in gates:
            gate.set()
