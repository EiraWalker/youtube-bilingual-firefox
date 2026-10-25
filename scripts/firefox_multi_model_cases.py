"""Multi-model races in the runner's isolated, headless Firefox session.

Only synthetic settings and the loopback API fixture are used. The caller owns
WebDriver, the disposable profile, host permission and fixture servers. This
module neither registers Native Messaging nor connects to a user's browser.
"""
import base64
from collections import Counter, defaultdict
import json
import pathlib
import threading
import time
from urllib.parse import urlsplit


FAST = 'fast-model'
QUALITY = 'quality-model'
DISABLED = 'disabled-model'
FIRST_TRANSLATION = '你好，世界。'


def run_multi_model_cases(driver, state, check, out, options_url, api_url, fixture_cues) -> dict:
    """Return on-screen/request evidence; release every fixture gate on failure.

    ApiHandler must support controls[tag]['models'][model] = {gate, prefix}.
    Its 45-second fallback is a safety valve, never an accepted race result:
    every blocked screenshot checks pending requests both before and after.
    """
    endpoint = urlsplit(api_url)
    if (endpoint.scheme != 'http' or endpoint.hostname != '127.0.0.1'
            or endpoint.port is None or endpoint.username is not None
            or endpoint.password is not None or endpoint.path != '/v1'
            or endpoint.query or endpoint.fragment):
        raise ValueError('Multi-model cases require the exact loopback fixture /v1 URL.')
    if not options_url.startswith('moz-extension://') or not options_url.endswith('/options.html'):
        raise ValueError('Multi-model settings must be injected from the extension options page.')
    check('multi-model fixture anchors source ID 0 at time zero',
          bool(fixture_cues) and tuple(fixture_cues[0]) == (0, 'Hello world.'))
    out = pathlib.Path(out)
    out.mkdir(parents=True, exist_ok=True)
    samples, phases, gates, settings_samples = {}, {}, [], []

    def records(tag) -> list[dict]:
        with state['lock']:
            return [dict(row, ids=list(row['ids'])) for row in state['requests'] if row['tag'] == tag]

    def until(predicate, description, timeout=12):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            time.sleep(.1)
        raise AssertionError('Multi-model fixture timed out: ' + description)

    def sample():
        return driver.js("""const v=document.querySelector('#movie_player video');
            const overlay=document.querySelector('.ytbl-overlay');
            const progress=document.querySelector('.ytbl-progress');
            const native=document.querySelector('.ytp-caption-window-container');
            const shown=e=>!!e&&!e.hidden&&getComputedStyle(e).display!=='none'
                &&getComputedStyle(e).visibility!=='hidden'&&e.getClientRects().length>0;
            const enabled=document.querySelector('.ytbl-toggle')?.getAttribute('aria-pressed')==='true';
            return {observedAt:Date.now(),videoId:new URL(location.href).searchParams.get('v'),
                time:v?.currentTime,rate:v?.playbackRate,paused:v?.paused,ended:v?.ended,
                documentVisible:!document.hidden,enabled,overlayHidden:overlay?.hidden,
                overlayVisible:shown(overlay),original:document.querySelector('.ytbl-original')?.textContent,
                translated:document.querySelector('.ytbl-translated')?.textContent,
                progressHidden:progress?.hidden,progressText:progress?.textContent,
                nativeVisible:shown(native),status:document.querySelector('.ytbl-status')?.textContent,
                watching:!!v&&enabled&&!v.paused&&!v.ended&&!document.hidden
                    &&!document.querySelector('#movie_player')?.classList.contains('ad-showing')};""")

    def is_caption(value, model, playing=True):
        prefix = 'FAST:' if model == FAST else 'QUALITY:'
        return (value['overlayVisible'] and value['original'] == fixture_cues[0][1]
                and value['translated'] == prefix + FIRST_TRANSLATION
                and value['progressHidden'] is True and value['enabled']
                and value['paused'] is (not playing) and 0 <= value['time'] < 2
                and (not playing or value['watching']))

    def caption(model, playing=True):
        def current():
            value = sample()
            return value if is_caption(value, model, playing) else None
        return until(current, 'visible current cue from ' + model)

    def blocked(phase, models):
        rows = records(phase['tag'])
        for model in models:
            pending = [row for row in rows if row['model'] == model]
            age = max((time.monotonic() - row['started'] for row in pending), default=99)
            if (phase['gates'][model].is_set() or len(pending) != 3
                    or any(row['completed'] or 'ended' in row for row in pending) or age >= 40):
                raise AssertionError(f"{phase['tag']}: {model} did not remain gated before the 45s fallback")
        return rows

    def capture(name, phase, predicate, pending=()):
        before_rows = blocked(phase, pending)
        before = sample()
        check(name + ': synchronized pre-screenshot UI', predicate(before))
        filename = 'multi-model-' + name + '.png'
        (out / filename).write_bytes(base64.b64decode(driver.cmd('/screenshot')))
        after_rows = blocked(phase, pending)
        after = sample()
        check(name + ': synchronized post-screenshot UI', predicate(after))
        evidence = {'screenshot': filename, 'before': before, 'after': after,
                    'requestsBefore': before_rows, 'requestsAfter': after_rows,
                    'pendingModels': list(pending)}
        samples[name] = evidence
        (out / ('multi-model-' + name + '.json')).write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
        return evidence

    def configure(equal_priority=False):
        driver.cmd('/url', {'url': options_url})
        driver.wait("document.getElementById('settings-form') && typeof browser !== 'undefined'")
        profiles = [
            {'id': 'fixture-fast', 'name': 'Fixture fast', 'apiBaseUrl': api_url,
             'apiKey': 'fixture-key', 'model': FAST, 'enabled': True, 'priority': 2 if equal_priority else 20},
            {'id': 'fixture-quality', 'name': 'Fixture quality', 'apiBaseUrl': api_url,
             'apiKey': 'fixture-key', 'model': QUALITY, 'enabled': True, 'priority': 2 if equal_priority else 1},
            {'id': 'fixture-disabled', 'name': 'Fixture disabled', 'apiBaseUrl': api_url,
             'apiKey': 'fixture-key', 'model': DISABLED, 'enabled': False, 'priority': 1},
        ]
        config = {'models': profiles, 'apiBaseUrl': api_url, 'apiKey': 'fixture-key', 'model': FAST,
                  'targetLanguage': 'zh-CN', 'sourceLanguage': 'en', 'fontSize': 24,
                  'bottomOffset': 70, 'autoEnable': False, 'cacheFolder': ''}
        # Overwrite, do not merge with or inspect any pre-existing API credentials.
        saved = driver.async_js("""const value=arguments[0],done=arguments[arguments.length-1];
            browser.storage.local.set({settings:value}).then(()=>browser.storage.local.get('settings'))
                .then(result=>done({ok:JSON.stringify(result.settings)===JSON.stringify(value)}),
                    ()=>done({ok:false}));""", config)
        check('synthetic multi-model settings are written and read back exactly', saved and saved.get('ok'))
        permitted = driver.async_js("""const done=arguments[arguments.length-1];
            browser.permissions.contains({origins:['http://127.0.0.1/*']}).then(done,()=>done(false));""")
        check('isolated Firefox has permission for the configured loopback API host', permitted is True)
        driver.cmd('/url', {'url': options_url})

        def editors():
            return driver.js("""const cards=[...document.querySelectorAll('#model-list .model-card, #model-list [data-model-id]')];
                const visible=e=>!!e&&!e.hidden&&getComputedStyle(e).display!=='none'
                    &&getComputedStyle(e).visibility!=='hidden'&&e.getClientRects().length>0;
                return cards.map(card=>{
                    const input=field=>card.querySelector(`[data-field="${field}"], [data-model-field="${field}"], input[name="${field}"], input[id$="-${field}"], input#${field}`);
                    const enabled=input('enabled'),priority=input('priority'),model=input('model'),url=input('apiBaseUrl');
                    return {model:model?.value,apiBaseUrl:url?.value,enabled:enabled?.checked,
                        priority:Number(priority?.value),enabledType:enabled?.type,priorityType:priority?.type,
                        visible:visible(enabled)&&visible(priority)&&visible(model)&&visible(url)};
                });""")

        expected = [{key: profile[key] for key in ['model', 'apiBaseUrl', 'enabled', 'priority']} for profile in profiles]

        def loaded():
            rows = editors()
            return rows if (len(rows) == len(expected) and all(
                all(row.get(key) == value for key, value in wanted.items())
                and row['visible'] and row['enabledType'] == 'checkbox' and row['priorityType'] == 'number'
                for row, wanted in zip(rows, expected))) else None

        ui = until(loaded, 'all profile editors, enabled switches and priorities loaded after reload')
        check('reloaded options show actual enabled and priority inputs for all three models', len(ui) == 3)
        settings_samples.append({'equalPriority': equal_priority, 'editors': ui})

    def stop_player():
        driver.js("document.querySelector('video')?.pause()")
        if driver.js("return document.querySelector('.ytbl-toggle')?.getAttribute('aria-pressed') === 'true'"):
            driver.click('.ytbl-toggle')
        driver.wait("document.querySelector('.ytbl-toggle')?.getAttribute('aria-pressed') === 'false' && document.querySelector('.ytbl-progress')?.hidden")

    def start_phase(tag, video):
        model_gates = {FAST: threading.Event(), QUALITY: threading.Event()}
        gates.extend(model_gates.values())
        phase = {'tag': tag, 'videoId': video, 'gates': model_gates}
        with state['lock']:
            state['controls'][tag] = {'models': {
                FAST: {'gate': model_gates[FAST], 'prefix': 'FAST:'},
                QUALITY: {'gate': model_gates[QUALITY], 'prefix': 'QUALITY:'},
            }}
            state['caption_mode'] = 'json3'
            state['tag'] = tag
        driver.cmd('/url', {'url': 'https://www.youtube.com/watch?v=' + video})
        driver.wait("document.querySelector('.ytbl-toggle')?.parentElement.classList.contains('ytp-right-controls')")
        driver.wait("document.querySelector('#movie_player video')?.duration > 175")
        if driver.js("return document.querySelector('.ytbl-toggle').getAttribute('aria-pressed') !== 'true'"):
            driver.click('.ytbl-toggle')
        played = driver.async_js("""const done=arguments[arguments.length-1],v=document.querySelector('#movie_player video');
            v.playbackRate=.1;v.currentTime=.2;v.play().then(()=>done({ok:!v.paused}),()=>done({ok:false}));""")
        check(tag + ': fixture is playing without assuming its clock advances', played and played.get('ok'))
        until(lambda: len(records(tag)) >= 6, tag + ': three simultaneous segments across both models', timeout=15)
        time.sleep(.4)
        rows = blocked(phase, [FAST, QUALITY])
        groups = defaultdict(list)
        for row in rows:
            groups[tuple(row['ids'])].append(row['model'])
        check(tag + ': six HTTP requests are exactly three shared segments times two enabled models',
              len(rows) == 6 and len(groups) == 3
              and all(Counter(models) == Counter([FAST, QUALITY]) for models in groups.values()))
        all_ids = [cue_id for ids in groups for cue_id in ids]
        check(tag + ': segment IDs are disjoint and both models receive the identical first-cue group',
              all(groups) and len(all_ids) == len(set(all_ids))
              and sum('0' in ids for ids in groups) == 1
              and all(isinstance(cue_id, str) and cue_id.isdigit()
                      and int(cue_id) < len(fixture_cues) for cue_id in all_ids))
        check(tag + ': disabled model sends no request and active requests use fixture authentication',
              not any(row['model'] == DISABLED for row in rows)
              and all(row.get('has_test_auth') is True for row in rows))
        phase['initialRequests'] = rows
        phase['initialGroups'] = [{'ids': list(ids), 'models': models} for ids, models in groups.items()]
        phases[tag] = {'videoId': video, 'initialRequests': rows, 'initialGroups': phase['initialGroups']}
        return phase

    def release(phase, model):
        blocked(phase, [model])
        phase['gates'][model].set()
        phase.setdefault('releasedAt', {})[model] = time.monotonic()
        until(lambda: (rows := records(phase['tag'])) and all(
            row['completed'] and 'ended' in row for row in rows if row['model'] == model),
            phase['tag'] + ': released model HTTP responses completed')

    def stable(phase, predicate, description, seconds=1.6, count=None):
        # Two content-script polling/render cycles are required after HTTP ends;
        # checking the old caption immediately would miss a delayed downgrade.
        deadline = time.monotonic() + seconds
        observed = []
        while True:
            value = sample()
            if not predicate(value):
                raise AssertionError(description + ': ' + json.dumps(value, ensure_ascii=False))
            rows = records(phase['tag'])
            if count is not None and len(rows) != count:
                raise AssertionError(f'{description}: expected {count} requests, received {len(rows)}')
            observed.append(value)
            if time.monotonic() >= deadline:
                break
            time.sleep(.25)
        check(description, bool(observed))
        return observed

    def finish_phase(phase):
        stop_player()
        quiet_count, quiet_since = None, time.monotonic()

        def drained():
            nonlocal quiet_count, quiet_since
            rows = records(phase['tag'])
            if len(rows) != quiet_count or not all(row['completed'] and 'ended' in row for row in rows):
                quiet_count, quiet_since = len(rows), time.monotonic()
                return False
            return time.monotonic() - quiet_since >= .4

        until(drained, phase['tag'] + ': all requests drained before changing tags')
        phases[phase['tag']]['finalRequests'] = records(phase['tag'])

    def runtime(message):
        result = driver.async_js("""const done=arguments[arguments.length-1];
            browser.runtime.sendMessage(arguments[0]).then(done,()=>done({ok:false}));""", message)
        if not result or not result.get('ok'):
            raise AssertionError('Multi-model fixture extension message failed: ' + message['type'])
        return result.get('data')

    try:
        configure()
        phase = start_phase('multi-upgrade', 'multirace01')
        waiting = until(lambda: (value if (value := sample())['watching']
                        and not value['progressHidden'] and not value['overlayVisible'] else None),
                        'gated startup progress')
        check('multi-model startup retains native captions while both models wait', waiting['nativeVisible'])
        capture('startup', phase, lambda value: value['watching'] and not value['progressHidden']
                and not value['overlayVisible'] and value['nativeVisible'], [FAST, QUALITY])
        release(phase, FAST)
        first = caption(FAST)
        phases[phase['tag']]['firstVisibleAfterFastReleaseSeconds'] = round(
            time.monotonic() - phase['releasedAt'][FAST], 3)
        check('first valid lower-priority model appears without waiting for the higher-priority model',
              first['watching'] and not phase['gates'][QUALITY].is_set())
        capture('fast-first', phase, lambda value: is_caption(value, FAST), [QUALITY])
        release(phase, QUALITY)
        caption(QUALITY)
        capture('priority-upgrade', phase, lambda value: is_caption(value, QUALITY))
        driver.js("const v=document.querySelector('video');v.pause();v.currentTime=6")
        driver.wait("document.querySelector('.ytbl-overlay').hidden && document.querySelector('video').paused")
        before_seek = len(records(phase['tag']))
        driver.js("document.querySelector('video').currentTime=.2")
        caption(QUALITY, playing=False)
        capture('seek-retains-best', phase, lambda value: is_caption(value, QUALITY, playing=False))
        check('seeking back retains the upgraded best translation without new paused requests',
              len(records(phase['tag'])) == before_seek)
        finish_phase(phase)

        phase = start_phase('multi-no-downgrade', 'multirace02')
        release(phase, QUALITY)
        caption(QUALITY)
        capture('quality-first', phase, lambda value: is_caption(value, QUALITY), [FAST])
        release(phase, FAST)
        phases[phase['tag']]['lateLowerPrioritySamples'] = stable(
            phase, lambda value: is_caption(value, QUALITY), 'late lower-priority result cannot downgrade the caption')
        capture('no-downgrade', phase, lambda value: is_caption(value, QUALITY))
        finish_phase(phase)

        phase = start_phase('multi-paused', 'multirace03')
        driver.js("document.querySelector('video').pause()")
        driver.wait("document.querySelector('video').paused")
        time.sleep(.3)
        before_pause = len(records(phase['tag']))
        release(phase, FAST)
        caption(FAST, playing=False)
        capture('paused-fast-result', phase, lambda value: is_caption(value, FAST, playing=False), [QUALITY])
        release(phase, QUALITY)
        caption(QUALITY, playing=False)
        phases[phase['tag']]['pausedSamples'] = stable(
            phase, lambda value: is_caption(value, QUALITY, playing=False),
            'paused late results remain usable without scheduling more work', count=before_pause)
        check('pause keeps exactly the original six requests while accepting late priority upgrades', before_pause == 6)
        capture('paused-upgrade', phase, lambda value: is_caption(value, QUALITY, playing=False))
        finish_phase(phase)

        phase = start_phase('multi-disabled', 'multirace04')
        driver.click('.ytbl-toggle')
        driver.wait("document.querySelector('.ytbl-toggle').getAttribute('aria-pressed') === 'false' && document.querySelector('.ytbl-progress').hidden && document.querySelector('.ytbl-overlay').hidden")
        driver.js("document.querySelector('video').currentTime=150.2")
        time.sleep(.3)
        before_disable = len(records(phase['tag']))
        hidden = lambda value: (not value['enabled'] and not value['overlayVisible']
                                and value['progressHidden'] is True and value['paused'] is False
                                and value['documentVisible'])
        release(phase, FAST)
        capture('disabled-fast-result', phase, hidden, [QUALITY])
        release(phase, QUALITY)
        phases[phase['tag']]['disabledSamples'] = stable(
            phase, hidden, 'disabled playback and late replies cannot restart translation', count=before_disable)
        check('disable and distant seek keep exactly the initial six requests', before_disable == 6)
        driver.cmd('/url', {'url': options_url})
        driver.wait("document.getElementById('settings-form') && typeof browser !== 'undefined'")
        job = until(lambda: next((row for row in runtime({'type': 'track:list'})
                                 if row['videoId'] == phase['videoId']), None), 'disabled temporary task retained')
        retained = runtime({'type': 'track:status', 'id': job['id']})
        first_row = next((row for row in retained.get('translations', []) if row['id'] == '0'), None)
        check('disabled late responses retain the best first-cue text in memory',
              first_row and first_row['text'] == 'QUALITY:' + FIRST_TRANSLATION
              and retained['translatedCount'] > 0 and retained['state'] == 'paused'
              and len(records(phase['tag'])) == before_disable)
        phases[phase['tag']]['retained'] = {key: retained[key] for key in ['state', 'translatedCount', 'revision']}
        phases[phase['tag']]['retained']['firstTranslation'] = first_row
        # Reopen only our synthetic player, paused: reuse must not authorize a
        # fresh paid request, and the on-screen result must still be the best.
        driver.cmd('/url', {'url': 'https://www.youtube.com/watch?v=' + phase['videoId']})
        driver.wait("document.querySelector('.ytbl-toggle')?.parentElement.classList.contains('ytp-right-controls')")
        driver.wait("document.querySelector('video')?.duration > 175")
        driver.js("const v=document.querySelector('video');v.pause();v.currentTime=.2")
        driver.click('.ytbl-toggle')
        caption(QUALITY, playing=False)
        capture('reenable-retains-best', phase, lambda value: is_caption(value, QUALITY, playing=False))
        check('re-enabling a paused player reuses the best late result without additional HTTP requests',
              len(records(phase['tag'])) == before_disable)
        finish_phase(phase)

        configure(equal_priority=True)
        phase = start_phase('multi-equal-priority', 'multirace05')
        release(phase, FAST)
        caption(FAST)
        capture('equal-priority-first', phase, lambda value: is_caption(value, FAST), [QUALITY])
        release(phase, QUALITY)
        phases[phase['tag']]['lateEqualPrioritySamples'] = stable(
            phase, lambda value: is_caption(value, FAST), 'late equal-priority result cannot replace the first winner')
        capture('equal-priority-preserves-first', phase, lambda value: is_caption(value, FAST))
        finish_phase(phase)

        all_records = [row for tag in phases for row in records(tag)]
        check('disabled profile never sends an HTTP request in any multi-model phase',
              all(row['model'] in {FAST, QUALITY} for row in all_records))
        check('all multi-model requests use only the local fixture completion endpoint',
              all(row['path'] == '/v1/chat/completions' and row.get('has_test_auth') is True
                  for row in all_records))
        return {'multiModel': {'settings': settings_samples, 'phases': phases,
                               'samples': samples, 'requestCount': len(all_records)},
                'nativeRegistrationTouched': False}
    finally:
        for gate in gates:
            gate.set()
