"""Deterministic browser cases for the production buffered-subtitle bundle.

The fixture API exposes barriers and cue-ID failures; tests observe public
extension messages and actual player DOM, never mutate background internals.
"""
import base64
import pathlib
import re
import threading
import time


def run_fixture_cases(driver, options_url, state, check, extension_message,
                      wait_job, capabilities, addon, extension_url, out, cue_count):
    report = {}
    options_handle = driver.cmd('/window')
    player_handle = driver.cmd('/window/new', {'type': 'tab'})['handle']

    def switch(handle):
        driver.cmd('/window', {'handle': handle})

    def until(predicate, message, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            time.sleep(.1)
        raise AssertionError(message)

    def configure(tag, **control):
        state['controls'][tag] = control
        state['tag'] = tag

    def records(tag):
        return [row for row in state['requests'] if row['tag'] == tag]

    def open_player(video, enable=True):
        switch(player_handle)
        driver.cmd('/url', {'url': 'https://www.youtube.com/watch?v=' + video})
        driver.wait("document.querySelector('.ytbl-toggle')?.parentElement.classList.contains('ytp-right-controls')")
        driver.wait("document.querySelector('video').duration > 175")
        if enable:
            driver.click('.ytbl-toggle')

    def job_for(video):
        switch(options_handle)
        jobs = extension_message(driver, {'type': 'track:list'})
        return next((job for job in jobs if job['videoId'] == video), None)

    def complete(video, timeout=25):
        job = until(lambda: job_for(video), 'No background job for ' + video)
        return wait_job(driver, job['id'], timeout=timeout)

    def assert_clean_page():
        check('translation diagnostics do not expose page error details or alerts', driver.js("return !document.querySelector('.ytbl-status[data-error=true], .ytbl-toast, .ytbl-error-toast') && !/HTTP|429|401|API Key/.test(document.querySelector('.ytbl-status')?.textContent || '')"))

    # Hold all three startup requests, then release only the first. The first
    # successful segment must render while the remaining requests are in flight.
    first_gate, later_gate = threading.Event(), threading.Event()
    configure('partial', gates=[first_gate, later_gate, later_gate], gate=later_gate)
    open_player('fixture0001', enable=False)
    before = len(state['requests'])
    time.sleep(.3)
    check('no translation API request before enable', len(state['requests']) == before)
    driver.js("document.querySelector('video').play()")
    enabled_at = time.monotonic()
    driver.click('.ytbl-toggle')
    until(lambda: len(records('partial')) == 3, 'Startup did not fill three request slots')
    start_time = driver.js("return document.querySelector('video').currentTime")
    time.sleep(.3)
    check('buffer miss leaves native captions and playback active', driver.js("return !document.querySelector('video').paused && document.querySelector('video').currentTime > arguments[0] && getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility === 'visible'", start_time))
    check('startup sends three substantial segments, not a complete-track request', all(1 < row['count'] < cue_count for row in records('partial')))
    first_gate.set()
    partial_job = until(lambda: (job if (job := job_for('fixture0001')) and 0 < job['translatedCount'] < job['total'] else None), 'First segment was not published before whole-track completion')
    report['mockFirstSavedSeconds'] = round(time.monotonic() - enabled_at, 3)
    partial = extension_message(driver, {'type': 'track:status', 'id': partial_job['id']})
    check('partial public state includes full source and only durable translated rows', len(partial['cues']) == cue_count and len(partial['translations']) == partial['translatedCount'] and partial['revision'] > 0)
    response = driver.async_js("const done=arguments[arguments.length-1];browser.runtime.sendMessage({type:'track:export',id:arguments[0],mode:'bilingual'}).then(done)", partial_job['id'])
    check('partial translations cannot be exported as a complete bilingual SRT', response and response.get('ok') is False)
    switch(player_handle)
    driver.js("document.querySelector('video').currentTime=3.2;document.querySelector('video').pause()")
    driver.wait("document.querySelector('.ytbl-translated')?.textContent === '第二条字幕。' && !document.querySelector('.ytbl-overlay').hidden")
    check('first saved segment renders before the rest of the video has translated', len([r for r in records('partial') if r['completed']]) == 1)
    check('bilingual overlay is embedded in the YouTube player', driver.js("return document.querySelector('.ytbl-overlay').parentElement.id === 'movie_player'"))
    later_gate.set()
    first_complete = complete('fixture0001')
    all_ids = [cue_id for row in records('partial') for cue_id in row['ids']]
    check('segmented completion covers every source cue exactly once', len(all_ids) == cue_count and len(set(all_ids)) == cue_count and first_complete['translatedCount'] == cue_count)
    check('one video never exceeds three in-flight API requests', max(row['active'] for row in records('partial')) == 3)

    # Completed timelines retain the original player behaviors.
    switch(player_handle)
    driver.js("document.querySelector('video').currentTime=6")
    driver.wait("document.querySelector('.ytbl-overlay').hidden")
    check('known subtitle gaps restore native caption visibility', driver.js("return getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility === 'visible'"))
    driver.js("document.querySelector('video').currentTime=150.5")
    driver.wait("document.querySelector('.ytbl-translated').textContent === '远处的字幕。'")
    driver.js("document.querySelector('video').currentTime=8.1;document.querySelector('video').playbackRate=2;document.querySelector('video').play()")
    driver.wait("document.querySelector('video').currentTime > 8.5")
    driver.js("document.querySelector('video').pause()")
    check('2x playback retains cue synchronization', driver.js("return document.querySelector('.ytbl-translated').textContent === '跳转后的字幕。'"))
    driver.js("document.getElementById('movie_player').classList.add('ad-showing')")
    driver.wait("document.querySelector('.ytbl-overlay').hidden")
    driver.js("document.getElementById('movie_player').classList.remove('ad-showing')")
    driver.wait("!document.querySelector('.ytbl-overlay').hidden")
    check('advertisement suppresses and then restores bilingual display', True)
    driver.js("const button=document.createElement('button');button.id='fixture-fullscreen';button.textContent='Fullscreen';button.onclick=()=>document.getElementById('movie_player').requestFullscreen();document.querySelector('.ytp-right-controls').append(button)")
    driver.click('#fixture-fullscreen')
    driver.wait("document.fullscreenElement?.id === 'movie_player'")
    check('overlay stays inside actual Firefox fullscreen element', driver.js("return document.fullscreenElement.contains(document.querySelector('.ytbl-overlay'))"))
    driver.js("document.exitFullscreen()")
    (out / 'bilingual-player.png').write_bytes(base64.b64decode(driver.cmd('/screenshot')))
    cached_count = len(state['requests'])
    driver.js("document.querySelector('video').currentTime=.5")
    driver.wait("document.querySelector('.ytbl-translated').textContent === '你好，世界。'")
    check('cached seeks and player interactions do not translate again', len(state['requests']) == cached_count)
    driver.click('.ytbl-toggle')
    check('disable restores prior native caption state', driver.js("return getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility === 'visible' && document.querySelector('.ytp-subtitles-button').getAttribute('aria-pressed') === 'false'"))

    # With three startup requests held, a seek waits for a slot. The next request
    # starts at the distant target, and the old requests still return normally.
    seek_first, seek_rest = threading.Event(), threading.Event()
    configure('seek', gates=[seek_first, seek_rest, seek_rest], gate=seek_rest)
    open_player('fixture0002')
    until(lambda: len(records('seek')) == 3, 'Seek case did not start three requests')
    driver.js("document.querySelector('video').currentTime=150.5")
    time.sleep(.3)
    check('seek neither cancels in-flight requests nor starts a fourth', len(records('seek')) == 3 and not any(r.get('aborted') for r in records('seek')))
    seek_first.set()
    until(lambda: len(records('seek')) >= 4, 'Seek priority did not consume the next free slot')
    seek_job = job_for('fixture0002')
    source = extension_message(driver, {'type': 'track:status', 'id': seek_job['id']})['cues']
    target_id = next(cue['id'] for cue in source if cue['start'] <= 150.5 < cue['end'])
    check('the next free slot translates the new playback position', target_id in records('seek')[3]['ids'])
    seek_rest.set()
    complete('fixture0002')
    check('old-position requests finish and persist after the seek', all(r['completed'] and not r.get('aborted') for r in records('seek')))

    # Source parsing regressions remain covered independently from segmentation.
    state['caption_mode'] = 'xml'
    configure('xml')
    open_player('fixture0003')
    complete('fixture0003')
    switch(player_handle)
    driver.js("document.querySelector('video').currentTime=.5")
    driver.wait("document.querySelector('.ytbl-original').textContent === 'XML caption.' && document.querySelector('.ytbl-translated').textContent === '测试译文：XML caption.'")
    check('Firefox XML caption extraction works with segmented translation', True)
    state['caption_mode'] = 'json3'

    # A failed first segment automatically retries using the same target IDs.
    configure('retry', failures={'0': 1}, failure_status=429)
    open_player('fixture0004')
    retried = complete('fixture0004', timeout=30)
    attempts = [r for r in records('retry') if '0' in r['ids']]
    check('429 is retried automatically and other segments retain their work', len(attempts) == 2 and [r['status'] for r in attempts] == [429, 200] and retried['translatedCount'] == cue_count)
    successful_ids = [cue_id for row in records('retry') if row['status'] == 200 for cue_id in row['ids']]
    check('automatic retry does not repeat successfully translated cues', len(successful_ids) == len(set(successful_ids)) == cue_count)
    switch(player_handle)
    assert_clean_page()

    configure('retry-exhausted', failures={'0': 3}, failure_status=503)
    open_player('fixture0008')
    exhausted = until(lambda: (job if (job := job_for('fixture0008')) and job['state'] == 'failed' else None), 'Retry budget did not terminate the failed segment', timeout=30)
    failed_attempts = [row for row in records('retry-exhausted') if '0' in row['ids']]
    check('retry budget is exactly two extra attempts and preserves other saved cues', len(failed_attempts) == 3 and 0 < exhausted['translatedCount'] < cue_count)
    switch(player_handle)
    assert_clean_page()
    switch(options_handle)
    saved_before_retry = extension_message(driver, {'type': 'track:status', 'id': exhausted['id']})['translations']
    configure('manual-resume')
    extension_message(driver, {'type': 'track:resume', 'id': exhausted['id']})
    recovered = wait_job(driver, exhausted['id'])
    retried_ids = {cue_id for row in records('manual-resume') for cue_id in row['ids']}
    check('manual resume after exhausted retries fills only the failed gap', recovered['translatedCount'] == cue_count and not retried_ids.intersection(row['id'] for row in saved_before_retry))

    # Two videos may each occupy three slots. Closing A never cancels its task.
    a_gate, b_gate = threading.Event(), threading.Event()
    configure('video-a', gate=a_gate)
    open_player('fixture0005')
    until(lambda: len(records('video-a')) == 3, 'Video A did not fill its slots')
    old_handle = player_handle
    player_handle = driver.cmd('/window/new', {'type': 'tab'})['handle']
    configure('video-b', gate=b_gate)
    open_player('fixture0006')
    until(lambda: len(records('video-b')) == 3, 'Video B did not get independent slots')
    check('two videos can maintain six simultaneous translation requests', state['active'] == 6)
    switch(old_handle)
    driver.cmd('/window', method='DELETE')
    a_gate.set()
    # Keep the same control tag until A finishes so its remaining requests also
    # use a released barrier; B already owns its three immutable requests.
    state['tag'] = 'video-a'
    a_complete = complete('fixture0005')
    check('closing the originating tab still completes and saves video A', a_complete['translatedCount'] == cue_count)
    state['tag'] = 'video-b'
    b_gate.set()
    b_complete = complete('fixture0006')
    switch(player_handle)
    driver.js("document.querySelector('video').currentTime=.5")
    driver.wait("document.querySelector('.ytbl-translated').textContent === '你好，世界。'")
    check('video B retains its own saved translation after A closes', b_complete['translatedCount'] == cue_count)

    # Start another task, keep only the first segment durable, then really stop
    # Firefox. Reinstallation uses the same disposable profile and storage.
    partial_gate = threading.Event()
    configure('restart-before', gates=[None, partial_gate, partial_gate], gate=partial_gate)
    open_player('fixture0007')
    interrupted_job = until(lambda: (job if (job := job_for('fixture0007')) and 0 < job['translatedCount'] < cue_count else None), 'No durable partial task before restart')
    snapshot = extension_message(driver, {'type': 'track:status', 'id': interrupted_job['id']})
    saved_ids = {row['id'] for row in snapshot['translations']}
    driver.call('/session/' + driver.session, method='DELETE')
    driver.session = None
    partial_gate.set()
    until(lambda: state['active'] == 0, 'Old fixture requests did not drain')
    restart_count = len(state['requests'])
    restarted = driver.call('/session', {'capabilities': {'alwaysMatch': capabilities}})
    driver.session = restarted['sessionId']
    driver.cmd('/moz/addon/install', {'path': str(addon), 'temporary': True})
    options_url = extension_url(driver)
    driver.cmd('/url', {'url': options_url})
    options_handle = driver.cmd('/window')
    driver.wait("document.getElementById('model').value === 'fixture-model'")
    restored = extension_message(driver, {'type': 'track:status', 'id': interrupted_job['id']})
    time.sleep(.5)
    check('Firefox restart restores partial rows without starting paid work', restored['state'] == 'paused' and {row['id'] for row in restored['translations']} == saved_ids and len(state['requests']) == restart_count)
    configure('restart-resume')
    extension_message(driver, {'type': 'track:resume', 'id': interrupted_job['id']})
    resumed = wait_job(driver, interrupted_job['id'], timeout=30)
    resumed_ids = [cue_id for row in records('restart-resume') for cue_id in row['ids']]
    check('explicit resume requests only missing cues after Firefox restart', not saved_ids.intersection(resumed_ids) and len(resumed_ids) + len(saved_ids) == cue_count and resumed['translatedCount'] == cue_count)

    exports = []
    for mode in ['original', 'translated', 'bilingual']:
        exported = extension_message(driver, {'type': 'track:export', 'id': interrupted_job['id'], 'mode': mode})
        text = exported['content']
        check(f'{mode} SRT retains complete timing, count and selected languages', len(re.findall(r'(?m)^\d{2,}:\d{2}:\d{2},\d{3} --> ', text)) == cue_count and '00:02:30,000 --> 00:02:32,000' in text and ('Hello world.' in text) == (mode != 'translated') and ('你好，世界。' in text) == (mode != 'original') and (mode != 'bilingual' or 'Hello world.\r\n你好，世界。' in text))
        downloaded = extension_message(driver, {'type': 'track:download', 'id': interrupted_job['id'], 'mode': mode, 'saveAs': False})
        def download_ready():
            rows = driver.async_js("const done=arguments[arguments.length-1];browser.downloads.search({id:arguments[0]}).then(done)", downloaded['downloadId'])
            return rows[0] if rows and rows[0]['state'] == 'complete' else None
        entry = until(download_ready, mode + ' SRT download did not complete')
        check(f'{mode} SRT downloads through Firefox downloads API', pathlib.Path(entry['filename']).read_text(encoding='utf-8').replace('\n', '\r\n') == text)
        exports.append({'mode': mode, 'filename': entry['filename'], 'downloadId': downloaded['downloadId']})
    report['exports'] = exports
    report['backgroundJob'] = {key: resumed[key] for key in ['id', 'state', 'videoId', 'total', 'translatedCount']}
    report['apiPeakConcurrency'] = state['peak']
    report['apiRequests'] = [{key: row[key] for key in ['tag', 'ids', 'count', 'status', 'active', 'completed']} for row in state['requests']]

    cached_before = len(state['requests'])
    player_handle = driver.cmd('/window/new', {'type': 'tab'})['handle']
    open_player('fixture0007')
    driver.wait("document.querySelector('.ytbl-translated').textContent === '你好，世界。'")
    check('completed cache renders after restart without a translation request', len(state['requests']) == cached_before)
    check('mock API uses configured endpoint, model and authorization', all(row['path'] == '/v1/chat/completions' and row['model'] == 'fixture-model' and row['has_test_auth'] for row in state['requests']))
    driver.click('.ytbl-toggle')
    return options_url, report
