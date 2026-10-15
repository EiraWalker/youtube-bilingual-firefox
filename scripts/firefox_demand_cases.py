"""Production Firefox UI, request log and real Native Messaging cache acceptance."""
import base64
import contextlib
import json
import pathlib
import shutil
import sys
import subprocess
import threading
import time
import tempfile
import winreg


@contextlib.contextmanager
def registered_host(root, out):
    directory = out / 'native-host'
    directory.mkdir(exist_ok=True)
    shutil.copyfile(root / 'native/subtitle_cache_host.py', directory / 'subtitle_cache_host.py')
    launcher = directory / 'cache-host.cmd'
    launcher.write_text(f'@echo off\n"{sys.executable}" -I -X utf8 "%~dp0subtitle_cache_host.py"\n', encoding='utf-8')
    manifest = directory / 'local.youtube_bilingual.cache.json'
    manifest.write_text(json.dumps({'name': 'local.youtube_bilingual.cache', 'description': 'Isolated subtitle cache acceptance',
                                   'path': str(launcher), 'type': 'stdio', 'allowed_extensions': ['youtube-bilingual-local@local.extension']}), encoding='utf-8')
    key_path = r'Software\Mozilla\NativeMessagingHosts\local.youtube_bilingual.cache'
    existed, previous, kind = False, None, winreg.REG_SZ
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            existed = True
            try:
                previous, kind = winreg.QueryValueEx(key, '')
            except FileNotFoundError:
                pass
    except FileNotFoundError:
        pass
    try:
        shell = shutil.which('pwsh.exe') or 'powershell.exe'
        subprocess.run([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(root / 'native/install.ps1'),
                        '-InstallDirectory', str(directory), '-PythonExecutable', sys.executable], check=True,
                       capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        yield
    finally:
        try:
            subprocess.run([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(root / 'native/uninstall.ps1'),
                            '-InstallDirectory', str(directory)], check=True, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        finally:
            if existed:
                with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                    if previous is None:
                        try:
                            winreg.DeleteValue(key, '')
                        except FileNotFoundError:
                            pass
                    else:
                        winreg.SetValueEx(key, '', 0, kind, previous)
            else:
                try:
                    winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
                except FileNotFoundError:
                    pass


def run_fixture_cases(driver, options_url, state, check, extension_message,
                      wait_job, capabilities, addon, extension_url, out, cue_count):
    root = pathlib.Path(__file__).resolve().parent.parent
    with registered_host(root, out):
        return run_cases(driver, options_url, state, check, extension_message, capabilities, addon, extension_url, out, cue_count)


def run_cases(driver, options_url, state, check, extension_message, capabilities, addon, extension_url, out, cue_count):
    options_handle = driver.cmd('/window')
    player_handle = driver.cmd('/window/new', {'type': 'tab'})['handle']
    cache_folder = pathlib.Path(tempfile.mkdtemp(prefix='cache-evidence-', dir=out)) / '中文 字幕缓存'

    def switch(handle):
        driver.cmd('/window', {'handle': handle})

    def until(predicate, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            time.sleep(.1)
        raise AssertionError('Fixture condition timed out')

    def records(tag):
        return [row for row in state['requests'] if row['tag'] == tag]

    def configure(tag, **controls):
        state['tag'] = tag
        state['controls'][tag] = controls

    def open_player(video, enable=True):
        switch(player_handle)
        driver.cmd('/url', {'url': 'https://www.youtube.com/watch?v=' + video})
        driver.wait("document.querySelector('.ytbl-cache')?.parentElement.classList.contains('ytp-right-controls')")
        driver.wait("document.querySelector('video').duration > 175")
        if enable:
            driver.click('.ytbl-toggle')

    configure('window')
    open_player('fixture0001', enable=False)
    before = len(state['requests'])
    time.sleep(.3)
    check('opening a paused video does not submit translation requests', len(state['requests']) == before)
    driver.click('.ytbl-toggle')
    time.sleep(.5)
    check('enabling subtitles while paused still sends no translation request', len(state['requests']) == before)
    driver.js("document.querySelector('video').play()")
    until(lambda: len(records('window')) >= 1)
    driver.wait("document.querySelector('.ytbl-status')?.textContent.includes('缓冲就绪')", 20)
    count = len(records('window'))
    time.sleep(1)
    check('buffered playback stops submitting instead of translating the complete track', len(records('window')) == count and sum(row['count'] for row in records('window')) < cue_count)
    check('every startup request stays within the finite forward range', all(int(i) < 26 for row in records('window') for i in row['ids']))
    driver.js("document.querySelector('video').pause();document.querySelector('video').currentTime=3.2")
    driver.wait("document.querySelector('.ytbl-translated')?.textContent === '第二条字幕。'")
    check('cached button is adjacent to bilingual toggle', driver.js("return document.querySelector('.ytbl-toggle').nextElementSibling === document.querySelector('.ytbl-cache')"))
    before = len(state['requests'])
    driver.js("document.querySelector('video').currentTime=150.5")
    time.sleep(.4)
    check('seeking while paused does not request the new range', len(state['requests']) == before)
    driver.js("document.querySelector('video').play()")
    driver.wait("document.querySelector('.ytbl-translated')?.textContent === '远处的字幕。'", 20)
    driver.js("document.querySelector('video').pause()")
    check('resuming after seek translates the new position', len(state['requests']) > before)
    switch(options_handle)
    stored = driver.async_js("const done=arguments[arguments.length-1];browser.storage.local.get(null).then(done)")
    check('ordinary watching persists no source, translation or recovery records', list(stored) == ['settings'])
    jobs = extension_message(driver, {'type': 'track:list'})
    job = next(row for row in jobs if row['videoId'] == 'fixture0001')
    check('leaving the player retains temporary translated rows', job['translatedCount'] > 0)
    check('no subtitles are written to the cache folder by default', not cache_folder.exists())

    driver.js("document.getElementById('cacheFolder').value=arguments[0]", str(cache_folder))
    driver.click('#save')
    driver.wait("document.getElementById('status').textContent.includes('设置已保存')", 20)
    check('settings validate and save the actual native cache directory', driver.js("return document.getElementById('cacheFolder').value") == str(cache_folder))
    switch(player_handle)
    driver.js("document.querySelector('video').currentTime=3.2")
    driver.wait("!document.querySelector('.ytbl-cache').disabled", 20)
    before = len(state['requests'])
    driver.click('.ytbl-cache')
    driver.wait("document.querySelector('.ytbl-cache').textContent === '部分缓存' && !document.querySelector('.ytbl-cache').disabled", 20)
    check('manual caching preserves pause and creates no translation request', driver.js("return document.querySelector('video').paused") and len(state['requests']) == before)
    pointers = list(cache_folder.glob('*/current.json'))
    check('manual cache creates a real versioned snapshot', len(pointers) == 1)
    pointer = json.loads(pointers[0].read_text('utf-8'))
    revision = pointers[0].parent / pointer['revision']
    saved = json.loads((revision / 'subtitles.json').read_text('utf-8'))
    check('actual cache files include full source and partial bilingual SRT', (revision / 'original.srt').is_file() and (revision / 'bilingual.partial.srt').is_file() and len(saved['cues']) == cue_count)
    check('cache is partial and contains no authentication data', 0 < len(saved['translations']) < cue_count and 'fixture-key' not in json.dumps(saved))
    (out / 'demand-player.png').write_bytes(base64.b64decode(driver.cmd('/screenshot')))

    # Hold requests so suspension is tested while replies are still outstanding.
    gate = threading.Event()
    configure('pause', gate=gate)
    open_player('fixture0002')
    driver.js("document.querySelector('video').play()")
    until(lambda: len(records('pause')) == 3)
    driver.js("document.querySelector('video').pause()")
    before = len(records('pause')); gate.set()
    until(lambda: all(row['completed'] for row in records('pause')))
    time.sleep(.5)
    check('paused in-flight results finish without triggering another batch', len(records('pause')) == before)
    switch(options_handle)
    paused_job = next(row for row in extension_message(driver, {'type': 'track:list'}) if row['videoId'] == 'fixture0002')
    check('pause retains received translations in memory', paused_job['translatedCount'] > 0 and paused_job['state'] == 'paused')

    gate = threading.Event(); configure('leave', gate=gate)
    open_player('fixture0003')
    driver.js("document.querySelector('video').play()")
    until(lambda: len(records('leave')) == 3)
    switch(options_handle)
    time.sleep(.2); before = len(records('leave')); gate.set()
    until(lambda: all(row['completed'] for row in records('leave')))
    time.sleep(.5)
    check('hidden player cannot submit more requests when in-flight results return', len(records('leave')) == before)
    switch(player_handle)
    driver.click('.ytbl-toggle')
    before = len(records('leave'))
    driver.js("document.querySelector('video').currentTime=150;document.querySelector('video').play()")
    time.sleep(.5)
    check('disabling bilingual subtitles prevents new requests during playback', len(records('leave')) == before)

    # Same isolated Firefox profile, new browser process/background instance.
    switch(options_handle)
    disk_settings = driver.async_js("const done=arguments[arguments.length-1];browser.storage.local.get('settings').then(done)")
    driver.async_js("const done=arguments[arguments.length-1];browser.storage.local.clear().then(()=>browser.storage.local.set(arguments[0])).then(done)", disk_settings)
    driver.call('/session/' + driver.session, method='DELETE'); driver.session = None
    result = driver.call('/session', {'capabilities': {'alwaysMatch': capabilities}})
    driver.session = result['sessionId']
    driver.cmd('/moz/addon/install', {'path': str(addon), 'temporary': True})
    options_url = extension_url(driver)
    driver.cmd('/url', {'url': options_url})
    driver.wait("document.getElementById('cacheFolder')")
    driver.async_js("const done=arguments[arguments.length-1];browser.storage.local.set(arguments[0]).then(done)", disk_settings)
    driver.cmd('/url', {'url': options_url})
    driver.wait("document.getElementById('cacheFolder').value.length > 0")
    check('new background has no persisted subtitle index or temporary tasks', extension_message(driver, {'type': 'track:list'}) == [])
    options_handle = driver.cmd('/window')
    player_handle = driver.cmd('/window/new', {'type': 'tab'})['handle']
    configure('cold-cache')
    before = len(state['requests'])
    open_player('fixture0001')
    driver.js("document.querySelector('video').currentTime=3.2")
    driver.wait("document.querySelector('.ytbl-translated')?.textContent === '第二条字幕。'", 20)
    check('after browser restart the directory alone restores cached subtitles', len(state['requests']) == before)
    driver.click('.ytbl-cache')
    driver.wait("document.querySelector('.ytbl-cache').textContent === '部分缓存' && !document.querySelector('.ytbl-cache').disabled", 20)
    check('updating a snapshot keeps one stable cache identity', len(list(cache_folder.glob('*/current.json'))) == 1)
    switch(options_handle)
    job = next(row for row in extension_message(driver, {'type': 'track:list'}) if row['videoId'] == 'fixture0001')
    check('cold cache retains the exact saved translated count', job['translatedCount'] == len(saved['translations']))
    return options_url, {'demandCache': {'savedCueCount': len(saved['translations']), 'sourceCueCount': cue_count,
                                      'cacheFolder': str(cache_folder), 'requestCount': len(records('window')),
                                      'nativeRegistrationRestoredOnExit': True}}
