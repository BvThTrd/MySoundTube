// -- DOM CACHE --
const _dom = {
  convertForm:   document.getElementById('convertForm'),
  urlInput:      document.getElementById('urlInput'),
  pasteBtn:      document.getElementById('pasteBtn'),
  platformBadge: document.getElementById('platformBadge'),
  fmtRow:        document.getElementById('fmtRow'),
  mp4Option:     document.getElementById('mp4Option'),
  dlBtn:         document.getElementById('dlBtn'),
  dlBtnLabel:    document.getElementById('dlBtnLabel'),
  playlistBar:   document.getElementById('playlistBar'),
  playlistLabel: document.getElementById('playlistLabel'),
  dlAllBtn:      document.getElementById('dlAllBtn'),
  status:        document.getElementById('status'),
  queueSection:  document.getElementById('queueSection'),
  queueCount:    document.getElementById('queueCount'),
  clearBtn:      document.getElementById('clearBtn'),
  dlQueue:       document.getElementById('dlQueue'),
};

// -- SVG ICONS --
function _svg(paths, size) {
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
}
const _SVG_CHECK = _svg('<path d="M20 6 9 17l-5-5"/>', 14);
const _SVG_X = _svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 14);
const _SVG_CLOSE = _svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 16);
const _SVG_TRACES = _svg('<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2"/>', 16);
const _SVG_DOWNLOAD = _svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>', 15);
const _SVG_COPY = _svg('<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>', 14);
const _THUMB_PH = _svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>', 18);

// -- PLATFORM DETECTION --
const _SC_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com', 'm.soundcloud.com']);
const _YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com', 'music.youtube.com']);

function _detectPlatform(url) {
  try {
    const host = new URL(url).hostname;
    if (_SC_HOSTS.has(host)) return 'sc';
    if (_YT_HOSTS.has(host)) return 'yt';
  } catch {}
  return null;
}

function _updatePlatformBadge(url) {
  const badge = _dom.platformBadge;
  const p = _detectPlatform(url);
  badge.hidden = !p;
  if (p) {
    badge.className = 'platform-badge ' + p;
    badge.textContent = p === 'sc' ? 'soundcloud' : 'youtube';
  }
  _updateMp4Availability(p);
}

function _updateMp4Availability(platform) {
  _dom.mp4Option.hidden = platform !== 'yt';
  if (platform !== 'yt' && getFormat() === 'mp4') setFormat('mp3');
}

// -- FORMAT --
const _FORMAT_KEY = 'mysoundtube.format';

function getFormat() {
  return _dom.fmtRow.querySelector('input[name="format"]:checked').value;
}

function setFormat(fmt) {
  const input = _dom.fmtRow.querySelector('input[name="format"][value="' + fmt + '"]');
  if (input) input.checked = true;
}

_dom.fmtRow.addEventListener('change', () => {
  try { localStorage.setItem(_FORMAT_KEY, getFormat()); } catch {}
});

try {
  const saved = localStorage.getItem(_FORMAT_KEY);
  // MP4 only exists for YouTube links, and the page opens without a link
  if (saved && saved !== 'mp4') setFormat(saved);
} catch {}

// -- CONCURRENCY POOL --
const MAX_CONCURRENT = 5;
let _activeCount = 0;
const _pending = []; // { url, fmt, qid, playlistIndex, entry }

function _getItem(id) {
  return document.querySelector('[data-dlid="' + id + '"]');
}

function _syncBusy() {
  document.body.classList.toggle('is-busy', _activeCount > 0);
}

function _updatePendingBadges() {
  _pending.forEach((job, i) => {
    const el = _getItem(job.qid);
    if (el) el.querySelector('.dl-badge').textContent = '#' + (i + 1) + ' in queue';
  });
}

function _onJobFinish(qid, state) {
  if (state) dlUpdate(qid, state);
  _activeCount--;
  _syncBusy();
  if (_pending.length > 0) {
    const job = _pending.shift();
    _updatePendingBadges();
    _runTrack(job);
  }
}

function _setItemLive(qid, state, badge) {
  const el = _getItem(qid);
  if (!el) return;
  el.className = 'dl-item ' + state;
  el.querySelector('.dl-badge').textContent = badge;
  el.querySelector('.dl-spinner').hidden = false;
}

async function _showTrackInfo(job) {
  const { url, qid, playlistIndex, entry } = job;
  if (playlistIndex) {
    dlSetInfo(qid, entry);
    return;
  }
  try {
    const infoRes = await guardedFetch('/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = infoRes && infoRes.ok ? await infoRes.json().catch(() => null) : null;
    if (data && !data.error) dlSetInfo(qid, data);
    else dlSetFallback(qid, _labelFromUrl(url));
  } catch {
    dlSetFallback(qid, _labelFromUrl(url));
  }
}

async function _runTrack(job) {
  const { url, fmt, qid, playlistIndex } = job;
  _activeCount++;
  _syncBusy();
  _setItemLive(qid, 'fetching', 'fetching…');
  await _showTrackInfo(job);

  // Playlist tracks report errors on their own row: one DRM track must not drown the global status
  const fail = (msg) => {
    dlSetError(qid, msg);
    if (!playlistIndex) setStatus(msg, 'error');
    _onJobFinish(qid, 'error');
  };

  try {
    const res = await guardedFetch('/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format: fmt, playlist_index: playlistIndex })
    });
    if (!res) { _onJobFinish(qid, 'error'); return; }
    const data = await res.json().catch(() => ({}));
    if (data.trace) dlSetTrace(qid, data.trace);
    if (!res.ok || data.error) {
      fail(data.error || 'Download failed (HTTP ' + res.status + ').');
      return;
    }
    dlSetReady(qid, data.token, data.filename);
    _onJobFinish(qid, null);
  } catch (err) {
    fail('Network error: ' + err.message);
  }
}

function _schedule(job) {
  if (_activeCount < MAX_CONCURRENT) {
    _runTrack(job);
  } else {
    _pending.push(job);
    dlSetQueued(job.qid, _pending.length);
  }
}

function enqueueTrack(url, fmt) {
  _schedule({ url, fmt, qid: dlAdd(url, fmt), playlistIndex: null, entry: null });
}

function enqueuePlaylist(url, fmt, entries) {
  // Rows stack newest first: create them from the last track so track 1 is on top, then run them in order
  const jobs = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = { ...entries[i], title: entries[i].title || 'Track ' + (i + 1) };
    const qid = dlAdd(url, fmt);
    dlSetInfo(qid, entry);
    jobs[i] = { url, fmt, qid, playlistIndex: i + 1, entry };
  }
  jobs.forEach(job => _schedule(job));
}

// -- DOWNLOAD QUEUE UI --
let _dlId = 0;

function _esc(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function _labelFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || url);
  } catch { return url; }
}

function _platformQueueBadge(platform) {
  if (platform === 'sc') return '<span class="dl-platform sc">sc</span>';
  if (platform === 'yt') return '<span class="dl-platform yt">yt</span>';
  return '';
}

function _updateQueueMeta() {
  const count = _dom.dlQueue.children.length;
  _dom.queueSection.hidden = count === 0;
  _dom.queueCount.textContent = String(count);
  _dom.clearBtn.hidden = !_dom.dlQueue.querySelector('.dl-item.done, .dl-item.error');
}

async function _copyTrace(item, btn) {
  const text = item.querySelector('.dl-trace-text');
  const label = btn.querySelector('span');
  try {
    await navigator.clipboard.writeText(text.textContent);
    label.textContent = 'copied';
  } catch {
    // The Clipboard API needs HTTPS or localhost: select the text so Ctrl+C works instead
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    label.textContent = 'selected';
  }
  setTimeout(() => { label.textContent = 'copy'; }, 1500);
}

function _makeItem(id, thumbContent, title, meta, badge, state, fmt, platform) {
  const item = document.createElement('div');
  item.className = 'dl-item ' + state;
  item.dataset.dlid = id;
  item.innerHTML =
    '<div class="dl-thumb">' + thumbContent + '</div>' +
    '<div class="dl-info">' +
      '<div class="dl-title">' + _esc(title) + '</div>' +
      '<div class="dl-meta-row">' +
        '<span class="dl-meta">' + _esc(meta) + '</span>' +
        _platformQueueBadge(platform) +
        (fmt ? '<span class="dl-fmt">' + _esc(fmt) + '</span>' : '') +
      '</div>' +
      '<div class="dl-error" hidden></div>' +
    '</div>' +
    '<div class="dl-side">' +
      '<div class="dl-state">' +
        '<span class="dl-spinner" aria-hidden="true"></span>' +
        '<span class="dl-item-icon" hidden></span>' +
        '<span class="dl-badge">' + badge + '</span>' +
      '</div>' +
      '<div class="dl-actions">' +
        '<a class="dl-download-btn" hidden target="_blank">' + _SVG_DOWNLOAD + '<span>download</span></a>' +
        '<button class="icon-btn dl-trace-btn" type="button" hidden aria-expanded="false" ' +
          'aria-label="Show yt-dlp trace" title="yt-dlp trace">' + _SVG_TRACES + '</button>' +
        '<button class="icon-btn dl-item-close" type="button" aria-label="Remove from queue" title="Remove">' +
          _SVG_CLOSE + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="dl-trace" hidden>' +
      '<div class="dl-trace-bar">' +
        '<span>yt-dlp trace</span>' +
        '<button class="dl-trace-copy" type="button">' + _SVG_COPY + '<span>copy</span></button>' +
      '</div>' +
      '<pre class="dl-trace-text"></pre>' +
    '</div>';

  const traceBtn = item.querySelector('.dl-trace-btn');
  const trace = item.querySelector('.dl-trace');
  traceBtn.addEventListener('click', () => {
    trace.hidden = !trace.hidden;
    traceBtn.setAttribute('aria-expanded', String(!trace.hidden));
    traceBtn.setAttribute('aria-label', trace.hidden ? 'Show yt-dlp trace' : 'Hide yt-dlp trace');
  });
  const copyBtn = item.querySelector('.dl-trace-copy');
  copyBtn.addEventListener('click', () => _copyTrace(item, copyBtn));

  item.querySelector('.dl-item-close').addEventListener('click', () => {
    const idx = _pending.findIndex(j => j.qid === id);
    if (idx !== -1) {
      _pending.splice(idx, 1);
      _updatePendingBadges();
    }
    item.remove();
    _updateQueueMeta();
  });

  _dom.dlQueue.insertBefore(item, _dom.dlQueue.firstChild);
  _updateQueueMeta();
  return item;
}

function _setTitle(item, text) {
  const el = item.querySelector('.dl-title');
  el.textContent = text;
  el.title = text;
}

function dlAdd(url, fmt) {
  const id = ++_dlId;
  _makeItem(id, _THUMB_PH, 'Loading…', '', 'fetching…', 'fetching', fmt, _detectPlatform(url));
  return id;
}

function dlSetQueued(id, pos) {
  const item = _getItem(id);
  if (!item) return;
  item.className = 'dl-item queued';
  item.querySelector('.dl-badge').textContent = '#' + pos + ' in queue';
  item.querySelector('.dl-spinner').hidden = true;
}

function dlSetInfo(id, info) {
  const item = _getItem(id);
  if (!item) return;
  item.className = 'dl-item downloading';
  _setTitle(item, info.title || 'Unknown');
  const parts = [];
  if (info.uploader) parts.push(info.uploader);
  if (info.duration) parts.push(fmtDuration(info.duration));
  item.querySelector('.dl-meta').textContent = parts.join(' \xb7 ');
  item.querySelector('.dl-badge').textContent = 'converting…';
  if (info.thumbnail) {
    const img = document.createElement('img');
    img.src = info.thumbnail;
    img.alt = '';
    img.width = 44;
    img.height = 44;
    img.loading = 'lazy';
    const thumb = item.querySelector('.dl-thumb');
    thumb.innerHTML = '';
    thumb.appendChild(img);
  }
}

function dlSetFallback(id, label) {
  const item = _getItem(id);
  if (!item) return;
  item.className = 'dl-item downloading';
  _setTitle(item, label);
  item.querySelector('.dl-badge').textContent = 'converting…';
}

function dlUpdate(id, state) {
  const item = _getItem(id);
  if (!item) return;
  item.className = 'dl-item ' + state;
  const badge = item.querySelector('.dl-badge');
  badge.textContent = state === 'done' ? 'downloaded' : 'failed';
  badge.hidden = false;
  item.querySelector('.dl-spinner').hidden = true;
  const icon = item.querySelector('.dl-item-icon');
  icon.innerHTML = state === 'done' ? _SVG_CHECK : _SVG_X;
  icon.hidden = false;
  _updateQueueMeta();
}

function dlSetError(id, message) {
  const item = _getItem(id);
  if (!item) return;
  const el = item.querySelector('.dl-error');
  el.textContent = message;
  el.hidden = false;
}

function dlSetTrace(id, trace) {
  const item = _getItem(id);
  if (!item) return;
  item.querySelector('.dl-trace-text').textContent = trace;
  item.querySelector('.dl-trace-btn').hidden = false;
}

function dlSetReady(id, token, filename) {
  const item = _getItem(id);
  if (!item) return;
  // SoundCloud playlist entries have no title until yt-dlp names the file
  if (/^Track \d+$/.test(item.querySelector('.dl-title').textContent)) {
    _setTitle(item, filename.replace(/\.[^.]+$/, ''));
  }
  item.className = 'dl-item ready';
  item.querySelector('.dl-spinner').hidden = true;
  item.querySelector('.dl-item-icon').hidden = true;
  item.querySelector('.dl-badge').hidden = true;
  const btn = item.querySelector('.dl-download-btn');
  btn.href = '/get-file/' + token;
  btn.download = filename;
  btn.hidden = false;
  btn.addEventListener('click', () => {
    setTimeout(() => {
      btn.hidden = true;
      dlUpdate(id, 'done');
    }, 300);
  }, { once: true });
}

// -- PASTE BUTTON --
if (!window.isSecureContext || !navigator.clipboard) {
  _dom.pasteBtn.title = 'Use Ctrl+V to paste';
}
_dom.pasteBtn.addEventListener('click', async () => {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      const text = await navigator.clipboard.readText();
      _dom.urlInput.value = text.trim();
      _dom.urlInput.dispatchEvent(new Event('input'));
    } catch {
      _dom.urlInput.select();
    }
  } else {
    _dom.urlInput.select();
    document.execCommand('paste');
  }
});

// -- AUTH GUARD --
async function guardedFetch(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) { window.location.href = '/login'; return null; }
  return res;
}

// -- HELPERS --
function setStatus(msg, type) {
  _dom.status.textContent = msg;
  _dom.status.className = 'status visible ' + type;
}
function clearStatus() {
  _dom.status.textContent = '';
  _dom.status.className = 'status';
}
function fmtDuration(secs) {
  if (!secs) return '';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m + ':' + String(s).padStart(2, '0');
}
function getURL() {
  return _dom.urlInput.value.trim();
}

// -- PLAYLIST HELPERS --
function isPlaylistURL(url) {
  if (/soundcloud\.com\/[^/]+\/sets\//.test(url)) return true;
  try {
    const u = new URL(url);
    if (_YT_HOSTS.has(u.hostname)) {
      return u.pathname === '/playlist' || u.searchParams.has('list');
    }
  } catch {}
  return false;
}

// A watch?v=...&list=... link is both a track and a playlist; a set or /playlist link is only a playlist
function _isPurePlaylist(url) {
  if (/soundcloud\.com\/[^/]+\/sets\//.test(url)) return true;
  try { return new URL(url).pathname === '/playlist'; } catch { return false; }
}

let _playlistInfoTimer = null;
let _playlist = null; // { url, promise } of the last /playlist-info request

async function _fetchPlaylistInfo(url) {
  const res = await guardedFetch('/playlist-info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  if (!res) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || 'Could not load the playlist.');
  return data;
}

function loadPlaylistInfo(url) {
  if (!_playlist || _playlist.url !== url) {
    const promise = _fetchPlaylistInfo(url);
    _playlist = { url, promise };
    // A failed load must not stay cached: the next attempt retries
    promise.catch(() => { if (_playlist && _playlist.promise === promise) _playlist = null; });
  }
  const { promise } = _playlist;
  _dom.playlistBar.hidden = false;
  _dom.playlistLabel.textContent = 'loading playlist…';
  promise.then(
    data => {
      if (!data || getURL() !== url) return;
      const n = data.track_count;
      _dom.playlistLabel.textContent = `${data.title} — ${n} track${n !== 1 ? 's' : ''}`;
    },
    err => { if (getURL() === url) _dom.playlistLabel.textContent = err.message; }
  );
  return promise;
}

async function convertPlaylist(url) {
  clearTimeout(_playlistInfoTimer);
  const fmt = getFormat();
  _dom.dlBtn.disabled = true;
  _dom.dlAllBtn.disabled = true;
  let data;
  try {
    data = await loadPlaylistInfo(url);
  } catch (err) {
    setStatus(err.message, 'error');
    return;
  } finally {
    _dom.dlBtn.disabled = false;
    _dom.dlAllBtn.disabled = false;
  }
  if (!data) return;
  if (!data.entries.length) { setStatus('This playlist is empty.', 'error'); return; }
  enqueuePlaylist(url, fmt, data.entries);
}

// -- URL INPUT + PLAYLIST DETECTION --
_dom.urlInput.addEventListener('input', () => {
  const url = getURL();
  clearStatus();
  _updatePlatformBadge(url);
  const playlist = isPlaylistURL(url);
  const purePlaylist = playlist && _isPurePlaylist(url);
  _dom.dlBtnLabel.textContent = purePlaylist ? 'convert all' : 'convert';
  _dom.dlAllBtn.hidden = purePlaylist;
  clearTimeout(_playlistInfoTimer);
  if (playlist) _playlistInfoTimer = setTimeout(() => loadPlaylistInfo(url), 400);
  else _dom.playlistBar.hidden = true;
});

// -- CONVERT --
_dom.convertForm.addEventListener('submit', e => {
  e.preventDefault();
  const url = getURL();
  if (!url) {
    setStatus('Paste a SoundCloud or YouTube link first.', 'error');
    _dom.urlInput.focus();
    return;
  }
  clearStatus();
  if (_isPurePlaylist(url)) convertPlaylist(url);
  else enqueueTrack(url, getFormat());
});

_dom.dlAllBtn.addEventListener('click', () => {
  const url = getURL();
  if (!url) { setStatus('Paste a SoundCloud or YouTube playlist link first.', 'error'); return; }
  clearStatus();
  convertPlaylist(url);
});

_dom.clearBtn.addEventListener('click', () => {
  _dom.dlQueue.querySelectorAll('.dl-item.done, .dl-item.error').forEach(el => el.remove());
  _updateQueueMeta();
});

// Desktop: ready to paste right away. Touch: focusing would pop the keyboard over the page
if (window.matchMedia('(pointer: fine)').matches) _dom.urlInput.focus();
