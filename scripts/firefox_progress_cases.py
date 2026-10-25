"""Progress notices against real Firefox, the production bundle and gated HTTP requests.

No Native Messaging registration or user browser profile is needed.
"""
import base64
import re
import threading
import time


def run_progress_cases(driver, state, check, out, fixture_cues):
    samples = {}
    gates = []

    def records(tag):
        return [row for row in state['requests'] if row['tag'] == tag]

    def until(predicate, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            time.sleep(.1)
        raise AssertionError('Progress fixture condition timed out')

    def sample():
        return driver.js("""const p=document.querySelector('.ytbl-progress');
            const v=document.querySelector('video');
            return {text:p?.textContent,hidden:p?.hidden,time:v?.currentTime,
                nativeVisible:getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility!=='hidden',
                translated:document.querySelector('.ytbl-translated')?.textContent};""")

    def notice(pattern):
        value = sample()
        return value if not value['hidden'] and re.fullmatch(pattern, value['text']) else None

    def elapsed(value):
        match = re.search(r'\d+', value['text'])
        assert match is not None
        return int(match.group())

    def screenshot(name):
        (out / name).write_bytes(base64.b64decode(driver.cmd('/screenshot')))

    def open_player(video):
        driver.cmd('/url', {'url': 'https://www.youtube.com/watch?v=' + video})
        driver.wait("document.querySelector('.ytbl-toggle')?.parentElement.classList.contains('ytp-right-controls')")
        driver.wait("document.querySelector('video').duration > 175")
        driver.click('.ytbl-toggle')
        driver.js("const v=document.querySelector('video');v.playbackRate=.1;v.currentTime=.2;v.play()")

    try:
        first, rest = threading.Event(), threading.Event()
        gates.extend([first, rest])
        state['tag'] = 'progress-start'
        state['controls']['progress-start'] = {'gates': [first, rest, rest]}
        open_player('progress001')
        until(lambda: len(records('progress-start')) == 3)
        initial = until(lambda: notice(r'正在翻译\(\d+\)'))
        check('first actual request displays a timed translation notice with native CC intact', initial['nativeVisible'])
        time.sleep(1.2)
        later = until(lambda: notice(r'正在翻译\(\d+\)'))
        check('translation seconds advance while the remote response is blocked', elapsed(later) > elapsed(initial))
        check('translation timer follows HTTP dispatch rather than first render',
              abs(elapsed(later) - (time.monotonic() - records('progress-start')[0]['started'])) < 1.5)
        samples['startup'] = later
        screenshot('progress-startup.png')
        driver.js("document.querySelector('video').pause()")
        driver.wait("document.querySelector('.ytbl-status')?.textContent.startsWith('已暂停')")
        paused = until(lambda: notice(r'正在翻译\(\d+\)'))
        check('pausing with the initial HTTP request still pending retains the real translation notice',
              paused['nativeVisible'] and abs(elapsed(paused) - (time.monotonic() - records('progress-start')[0]['started'])) < 1.5)
        samples['pausedPending'] = paused
        screenshot('progress-paused-pending.png')
        first.set()
        driver.wait("document.querySelector('.ytbl-translated')?.textContent === '你好，世界。'")
        driver.wait("document.querySelector('.ytbl-progress').hidden")
        check('first usable translation hides progress even with prefetch requests outstanding',
              any(not row['completed'] for row in records('progress-start')[1:]))
        check('the first reply can replace the notice with subtitles while playback remains paused', sample()['translated'] == '你好，世界。')
        driver.js("document.querySelector('video').play()")
        pending = records('progress-start')[1]
        target = fixture_cues[int(pending['ids'][0])][0] / 1000 + .2
        driver.js("document.querySelector('video').currentTime=arguments[0]", target)
        caught_up = until(lambda: notice(r'正在翻译\(\d+\)'))
        check('seeking beyond translated subtitles restores the existing request timer',
              caught_up['nativeVisible'] and abs(elapsed(caught_up) - (time.monotonic() - pending['started'])) < 1.5)
        samples['catchup'] = caught_up
        screenshot('progress-catchup.png')
        driver.js("document.querySelector('video').currentTime=.3")
        driver.wait("document.querySelector('.ytbl-translated')?.textContent === '你好，世界。' && document.querySelector('.ytbl-progress').hidden")
        check('seeking back into available translations hides progress', True)
        driver.js("document.querySelector('video').currentTime=6")
        driver.wait("document.querySelector('.ytbl-progress').hidden && document.querySelector('.ytbl-overlay').hidden")
        check('known subtitle-free gaps do not display translation progress', True)
        driver.click('.ytbl-toggle')
        driver.wait("document.querySelector('.ytbl-progress').hidden")
        check('disabling bilingual subtitles hides progress', True)
        rest.set()
        until(lambda: all(row['completed'] for row in records('progress-start')))

        retry_gate = threading.Event()
        gates.append(retry_gate)
        state['tag'] = 'progress-retry'
        state['controls']['progress-retry'] = {'failures': {'0': 1}, 'gates': [None, None, None], 'gate': retry_gate}
        open_player('progress002')
        until(lambda: len(records('progress-retry')) >= 3 and all(row['completed'] for row in records('progress-retry')[:3]))
        driver.wait("document.querySelector('.ytbl-progress').hidden && document.querySelector('.ytbl-progress').textContent === ''")
        check('backoff does not display a running retry timer or the old waiting-retry notice', True)
        until(lambda: len([row for row in records('progress-retry') if '0' in row['ids']]) == 2)
        retry = until(lambda: notice(r'正在重试（\d+）'))
        request = next(row for row in records('progress-retry') if '0' in row['ids'] and row['status'] == 200)
        check('a dispatched retry uses the retry label and a fresh timer',
              abs(elapsed(retry) - (time.monotonic() - request['started'])) < 1.5)
        time.sleep(1.2)
        retry_later = until(lambda: notice(r'正在重试（\d+）'))
        check('retry seconds advance independently of the earlier failed request and backoff',
              elapsed(retry_later) > elapsed(retry) and abs(elapsed(retry_later) - (time.monotonic() - request['started'])) < 1.5)
        samples['retry'] = retry_later
        screenshot('progress-retry.png')
        retry_gate.set()
        driver.wait("document.querySelector('.ytbl-translated')?.textContent === '你好，世界。' && document.querySelector('.ytbl-progress').hidden")
        check('a successful retry replaces progress with the current bilingual subtitle', True)
        return {'progressNotices': samples, 'nativeRegistrationTouched': False}
    finally:
        for gate in gates:
            gate.set()
