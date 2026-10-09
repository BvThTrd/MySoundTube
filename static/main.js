// -- DOM CACHE --
const _dom = {
  urlInput:     document.getElementById('urlInput'),
  playlistBar:  document.getElementById('playlistBar'),
  playlistLabel:document.getElementById('playlistLabel'),
  dlAllBtn:     document.getElementById('dlAllBtn'),
  dlQueue:      document.getElementById('dlQueue'),
  status:       document.getElementById('status'),
  fmtRow:       document.getElementById('fmtRow'),
  pasteBtn:      document.getElementById('pasteBtn'),
  dlBtn:         document.getElementById('dlBtn'),
  waveform:      document.getElementById('waveform'),
  platformBadge: document.getElementById('platformBadge'),
};

// -- SVG ICONS --
const _SVG_CHECK =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none">' +
  '<path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const _SVG_TRACES =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none">' +
  '<rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.8"/>' +
  '<path d="M7 9l3 3-3 3M12 15h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const _SVG_X =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none">' +
  '<path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

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
  if (p === 'sc') {
    badge.textContent = 'SoundCloud';
    badge.style.cssText = 'display:inline-block;color:#FF5500;background:rgba(255,85,0,0.1);border-color:rgba(255,85,0,0.25)';
  } else if (p === 'yt') {
    badge.textContent = 'YouTube';
    badge.style.cssText = 'display:inline-block;color:#FF0000;background:rgba(255,0,0,0.1);border-color:rgba(255,0,0,0.25)';
  } else {
    badge.style.display = 'none';
  }
  _updateMp4Availability(p);
}

function _updateMp4Availability(platform) {
  const mp4Btn = document.querySelector('.fmt-btn[data-fmt="mp4"]');
  if (!mp4Btn) return;
  if (platform === 'yt') {
    mp4Btn.style.display = '';
  } else {
    mp4Btn.style.display = 'none';
    if (selectedFormat === 'mp4') {
      document.querySelectorAll('.fmt-btn').forEach(b => b.classList.remove('active'));
      const mp3Btn = document.querySelector('.fmt-btn[data-fmt="mp3"]');
      if (mp3Btn) mp3Btn.classList.add('active');
      selectedFormat = 'mp3';
    }
  }
}

// -- CONCURRENCY POOL --
const MAX_CONCURRENT = 5;
let _activeCount = 0;
const _pending = []; // { url, fmt, qid, playlistIndex, entry }

function _getItem(id) {
  return document.querySelector('[data-dlid="' + id + '"]');
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
  el.querySelector('.dl-spinner').style.display = '';
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
  _setItemLive(qid, 'fetching', 'Fetching…');
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

const _THUMB_PH =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none">' +
  '<circle cx="12" cy="12" r="10" stroke="#2E3D52" stroke-width="1.5"/>' +
  '<path d="M9 8l8 4-8 4V8z" fill="#5A6880"/></svg>';

function _platformQueueBadge(platform) {
  if (platform === 'sc') return '<span class="dl-platform sc">SC</span>';
  if (platform === 'yt') return '<span class="dl-platform yt">YT</span>';
  return '';
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
        (fmt ? '<span class="dl-fmt' + (platform ? ' ' + platform : '') + '">' + _esc(fmt.toUpperCase()) + '</span>' : '') +
      '</div>' +
      '<div class="dl-error" style="display:none"></div>' +
    '</div>' +
    '<div class="dl-status-col">' +
      '<div class="dl-spinner"></div>' +
      '<div class="dl-item-icon" style="display:none"></div>' +
      '<div class="dl-badge">' + badge + '</div>' +
      '<div class="dl-actions">' +
        '<a class="dl-download-btn" style="display:none" target="_blank">Download</a>' +
        '<button class="dl-trace-btn" style="display:none" title="yt-dlp traces (debug)">' + _SVG_TRACES + '</button>' +
      '</div>' +
    '</div>' +
    '<button class="dl-item-close" title="Dismiss">\xd7</button>' +
    '<pre class="dl-trace" style="display:none"></pre>';

  const traceBtn = item.querySelector('.dl-trace-btn');
  traceBtn.addEventListener('click', () => {
    const pre = item.querySelector('.dl-trace');
    const open = pre.style.display === 'none';
    pre.style.display = open ? '' : 'none';
    traceBtn.classList.toggle('active', open);
  });

  item.querySelector('.dl-item-close').addEventListener('click', () => {
    const idx = _pending.findIndex(j => j.qid === id);
    if (idx !== -1) {
      _pending.splice(idx, 1);
      _updatePendingBadges();
    }
    item.remove();
    if (!_dom.dlQueue.children.length) _dom.dlQueue.classList.remove('has-items');
  });

  _dom.dlQueue.insertBefore(item, _dom.dlQueue.firstChild);
  _dom.dlQueue.classList.add('has-items');
  return item;
}

function dlAdd(url, fmt) {
  const id = ++_dlId;
  _makeItem(id, _THUMB_PH, 'Loading…', '', 'Fetching…', 'fetching', fmt, _detectPlatform(url));
  return id;
}

function dlSetQueued(id, pos) {
  const item = _getItem(id);
  if (!item) return;
  item.className = 'dl-item queued';
  item.querySelector('.dl-badge').textContent = '#' + pos + ' in queue';
  item.querySelector('.dl-spinner').style.display = 'none';
}

function dlSetInfo(id, info) {
  const item = _getItem(id);
  if (!item) return;
  item.className = 'dl-item downloading';
  item.querySelector('.dl-title').textContent = info.title || 'Unknown';
  const parts = [];
  if (info.uploader) parts.push(info.uploader);
  if (info.duration) parts.push(fmtDuration(info.duration));
  item.querySelector('.dl-meta').textContent = parts.join(' \xb7 ');
  item.querySelector('.dl-badge').textContent = 'Converting…';
  if (info.thumbnail) {
    const img = document.createElement('img');
    img.src = info.thumbnail;
    img.alt = '';
    const thumb = item.querySelector('.dl-thumb');
    thumb.innerHTML = '';
    thumb.appendChild(img);
  }
}

function dlSetFallback(id, label) {
  const item = _getItem(id);
  if (!item) return;
  item.className = 'dl-item downloading';
  item.querySelector('.dl-title').textContent = label;
  item.querySelector('.dl-badge').textContent = 'Converting…';
}

function dlUpdate(id, state) {
  const item = _getItem(id);
  if (!item) return;
  item.className = 'dl-item ' + state;
  item.querySelector('.dl-badge').textContent = state === 'done' ? 'Done' : 'Failed';
  item.querySelector('.dl-spinner').style.display = 'none';
  const icon = item.querySelector('.dl-item-icon');
  icon.style.display = 'flex';
  icon.innerHTML = state === 'done' ? _SVG_CHECK : _SVG_X;
}

function dlSetError(id, message) {
  const item = _getItem(id);
  if (!item) return;
  const el = item.querySelector('.dl-error');
  el.textContent = message;
  el.title = message;
  el.style.display = '';
}

function dlSetTrace(id, trace) {
  const item = _getItem(id);
  if (!item) return;
  item.querySelector('.dl-trace').textContent = trace;
  item.querySelector('.dl-trace-btn').style.display = '';
}

function dlSetReady(id, token, filename) {
  const item = _getItem(id);
  if (!item) return;
  // SoundCloud playlist entries have no title until yt-dlp names the file
  const title = item.querySelector('.dl-title');
  if (/^Track \d+$/.test(title.textContent)) title.textContent = filename.replace(/\.[^.]+$/, '');
  item.className = 'dl-item ready';
  item.querySelector('.dl-spinner').style.display = 'none';
  item.querySelector('.dl-item-icon').style.display = 'none';
  item.querySelector('.dl-badge').style.display = 'none';
  const btn = item.querySelector('.dl-download-btn');
  btn.href = '/get-file/' + token;
  btn.download = filename;
  btn.style.display = '';
  btn.addEventListener('click', () => {
    setTimeout(() => {
      btn.style.display = 'none';
      item.className = 'dl-item done';
      const icon = item.querySelector('.dl-item-icon');
      icon.style.display = 'flex';
      icon.innerHTML = _SVG_CHECK;
      const badge = item.querySelector('.dl-badge');
      badge.textContent = 'Downloaded';
      badge.style.display = '';
    }, 300);
  }, { once: true });
}

// -- WAVEFORM BARS --
const HEIGHTS = [8,14,20,28,22,16,24,30,18,12,26,20,14,22,16,10,24,20,14,18];
HEIGHTS.forEach((h, i) => {
  const b = document.createElement('div');
  b.className = 'bar';
  b.style.height = h + 'px';
  b.style.animationDelay = (i * 0.06) + 's';
  _dom.waveform.appendChild(b);
});

// -- STATE --
let selectedFormat = 'mp3';

// -- FORMAT BUTTONS --
_dom.fmtRow.addEventListener('click', e => {
  const btn = e.target.closest('.fmt-btn');
  if (!btn) return;
  document.querySelectorAll('.fmt-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  selectedFormat = btn.dataset.fmt;
});

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

// -- DOWNLOAD (single track) --
_dom.dlBtn.addEventListener('click', () => {
  const url = getURL();
  if (!url) { setStatus('Paste a SoundCloud or YouTube URL first.', 'error'); return; }
  clearStatus();
  enqueueTrack(url, selectedFormat);
});

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
  _dom.playlistBar.classList.add('visible');
  _dom.playlistLabel.textContent = 'Loading playlist info...';
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

// -- URL INPUT + PLAYLIST DETECTION --
_dom.urlInput.addEventListener('input', () => {
  const v = _dom.urlInput.value.trim();
  clearStatus();
  _updatePlatformBadge(v);
  if (isPlaylistURL(v)) {
    _dom.dlAllBtn.style.display = '';
    clearTimeout(_playlistInfoTimer);
    _playlistInfoTimer = setTimeout(() => loadPlaylistInfo(v), 400);
  } else {
    _dom.playlistBar.classList.remove('visible');
    _dom.dlAllBtn.style.display = 'none';
  }
});

// -- CONVERT ALL (playlist) --
_dom.dlAllBtn.addEventListener('click', async () => {
  const url = getURL();
  if (!url) { setStatus('Paste a SoundCloud or YouTube playlist URL first.', 'error'); return; }
  clearStatus();
  clearTimeout(_playlistInfoTimer);
  const fmt = selectedFormat;
  _dom.dlAllBtn.disabled = true;
  let data;
  try {
    data = await loadPlaylistInfo(url);
  } catch (err) {
    setStatus(err.message, 'error');
    return;
  } finally {
    _dom.dlAllBtn.disabled = false;
  }
  if (!data) return;
  if (!data.entries.length) { setStatus('This playlist is empty.', 'error'); return; }
  enqueuePlaylist(url, fmt, data.entries);
});
