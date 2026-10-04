'use strict';
/**
 * YouTube InnerTube (youtubei/v1) 直接クライアント
 *
 * 外部の Invidious 系 API が不安定/停止していても動作するよう、
 * 検索・コメント・返信・動画情報・関連動画・チャンネル情報を
 * YouTube の公開 InnerTube エンドポイントから直接取得する。
 */
const fetch = require('node-fetch');

const API_BASE = 'https://www.youtube.com/youtubei/v1/';
const CLIENT_VERSION = '2.20250101.00.00';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function context() {
  return { client: { clientName: 'WEB', clientVersion: CLIENT_VERSION, hl: 'ja', gl: 'JP' } };
}

async function call(endpoint, body, timeout) {
  const res = await fetch(API_BASE + endpoint + '?prettyPrint=false', {
    method: 'POST',
    timeout: timeout || 8000,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Accept-Language': 'ja,en;q=0.8',
      'Origin': 'https://www.youtube.com',
      // EU 圏の同意画面を避ける
      'Cookie': 'SOCS=CAI; CONSENT=YES+1'
    },
    body: JSON.stringify(Object.assign({ context: context() }, body))
  });
  if (!res.ok) throw new Error('InnerTube ' + endpoint + ' HTTP ' + res.status);
  return res.json();
}

// ───────── 小さな TTL キャッシュ ─────────
function makeCache(max) {
  const m = new Map();
  return {
    get(k) {
      const e = m.get(k);
      if (!e) return undefined;
      if (e.exp < Date.now()) { m.delete(k); return undefined; }
      return e.v;
    },
    set(k, v, ttl) {
      m.set(k, { v, exp: Date.now() + ttl });
      if (m.size > max) m.delete(m.keys().next().value);
    }
  };
}
const cache = makeCache(400);

// ───────── 汎用パーサ ─────────
function txt(o) {
  if (o == null) return '';
  if (typeof o === 'string') return o;
  if (o.simpleText !== undefined) return o.simpleText;
  if (Array.isArray(o.runs)) return o.runs.map(r => r.text).join('');
  if (o.content !== undefined) return o.content;
  return '';
}
function fixUrl(u) {
  if (!u) return '';
  if (u.startsWith('//')) return 'https:' + u;
  return u;
}
function lastUrl(t) {
  const a = Array.isArray(t) ? t : (t && (t.thumbnails || t.sources));
  if (!a || !a.length) return '';
  return fixUrl(a[a.length - 1].url || '');
}
function toSeconds(s) {
  if (!s) return 0;
  const p = String(s).split(':').map(n => parseInt(n, 10));
  if (p.some(isNaN)) return 0;
  return p.reduce((a, n) => a * 60 + n, 0);
}
function thumbOf(id) {
  return { thumbnails: [{ url: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg', width: 320, height: 180 }] };
}
function tokenOfContinuation(node) {
  if (!node) return '';
  return (node.continuationEndpoint && node.continuationEndpoint.continuationCommand && node.continuationEndpoint.continuationCommand.token) ||
    (node.button && node.button.buttonRenderer && node.button.buttonRenderer.command &&
      node.button.buttonRenderer.command.continuationCommand && node.button.buttonRenderer.command.continuationCommand.token) || '';
}

// ───────── 動画 / ショート / プレイリスト / チャンネル ─────────
function parseVideoRenderer(vr) {
  if (!vr || !vr.videoId) return null;
  const id = vr.videoId;
  const owner = (vr.ownerText && vr.ownerText.runs && vr.ownerText.runs[0]) ||
    (vr.shortBylineText && vr.shortBylineText.runs && vr.shortBylineText.runs[0]) ||
    (vr.longBylineText && vr.longBylineText.runs && vr.longBylineText.runs[0]) || {};
  const channelId = owner.navigationEndpoint && owner.navigationEndpoint.browseEndpoint && owner.navigationEndpoint.browseEndpoint.browseId || '';
  const ct = vr.channelThumbnailSupportedRenderers && vr.channelThumbnailSupportedRenderers.channelThumbnailWithLinkRenderer;
  const channelThumbnail = (ct && lastUrl(ct.thumbnail)) || lastUrl(vr.channelThumbnail);
  const lengthText = txt(vr.lengthText) ||
    ((vr.thumbnailOverlays || []).map(o => o.thumbnailOverlayTimeStatusRenderer && txt(o.thumbnailOverlayTimeStatusRenderer.text)).find(Boolean) || '');
  const viewCountText = txt(vr.viewCountText) || txt(vr.shortViewCountText);
  const url = vr.navigationEndpoint && vr.navigationEndpoint.commandMetadata &&
    vr.navigationEndpoint.commandMetadata.webCommandMetadata && vr.navigationEndpoint.commandMetadata.webCommandMetadata.url || '';
  const isLive = (vr.badges || []).some(b => b.metadataBadgeRenderer && /LIVE/.test(b.metadataBadgeRenderer.style || '')) ||
    (vr.thumbnailOverlays || []).some(o => o.thumbnailOverlayTimeStatusRenderer && o.thumbnailOverlayTimeStatusRenderer.style === 'LIVE');
  const snippet = vr.detailedMetadataSnippets && vr.detailedMetadataSnippets[0] && txt(vr.detailedMetadataSnippets[0].snippetText);
  return {
    id, type: 'video',
    title: txt(vr.title) || txt(vr.headline),
    channelTitle: owner.text || '',
    channelId,
    channelThumbnail,
    viewCountText,
    publishedTimeText: txt(vr.publishedTimeText),
    lengthText,
    length: { simpleText: lengthText },
    thumbnail: thumbOf(id),
    isShort: url.startsWith('/shorts/'),
    isLive: !!isLive,
    descriptionSnippet: snippet || ''
  };
}

function parseShortsLockup(sl) {
  if (!sl) return null;
  const cmd = sl.onTap && sl.onTap.innertubeCommand;
  let id = (cmd && cmd.reelWatchEndpoint && cmd.reelWatchEndpoint.videoId) ||
    (sl.entityId ? String(sl.entityId).replace('shorts-shelf-item-', '') : '');
  if (!id) return null;
  const om = sl.overlayMetadata || {};
  const title = txt(om.primaryText) || (sl.accessibilityText || '').split(',')[0];
  return {
    id, type: 'video', title,
    channelTitle: '', channelId: '',
    viewCountText: txt(om.secondaryText),
    publishedTimeText: '', lengthText: '', length: { simpleText: '' },
    thumbnail: thumbOf(id), isShort: true
  };
}

function parseReelItem(ri) {
  if (!ri || !ri.videoId) return null;
  return {
    id: ri.videoId, type: 'video', title: txt(ri.headline),
    channelTitle: '', channelId: '', viewCountText: txt(ri.viewCountText),
    publishedTimeText: '', lengthText: '', length: { simpleText: '' },
    thumbnail: thumbOf(ri.videoId), isShort: true
  };
}

function classifyMeta(rows) {
  const out = { views: '', date: '', others: [] };
  (rows || []).forEach(row => {
    (row.metadataParts || []).forEach(part => {
      const t = part.text && part.text.content;
      if (!t) return;
      const label = part.accessibilityLabel || '';
      const probe = label || t;
      if (/視聴|views?\b|watching/i.test(probe)) {
        out.views = /視聴/.test(label) && !/視聴/.test(t) ? label : t;
      } else if (/(前|ago)$|^(ライブ|配信|プレミア|公開予定)/i.test(t) || /(前|ago)$/i.test(label)) {
        out.date = t;
      } else {
        out.others.push(t);
      }
    });
  });
  return out;
}

function parseLockup(lv) {
  if (!lv || !lv.contentId) return null;
  const id = lv.contentId;
  const ct = lv.contentType || '';
  const md = lv.metadata && lv.metadata.lockupMetadataViewModel;
  if (!md) return null;
  const title = txt(md.title);
  const rows = md.metadata && md.metadata.contentMetadataViewModel && md.metadata.contentMetadataViewModel.metadataRows;
  const meta = classifyMeta(rows);
  const ci = lv.contentImage || {};
  const thumbVm = (ci.thumbnailViewModel) ||
    (ci.collectionThumbnailViewModel && ci.collectionThumbnailViewModel.primaryThumbnail && ci.collectionThumbnailViewModel.primaryThumbnail.thumbnailViewModel) || {};
  const thumbUrl = lastUrl(thumbVm.image);
  const overlays = thumbVm.overlays || [];
  let badgeText = '';
  overlays.forEach(o => {
    const badges = (o.thumbnailBottomOverlayViewModel && o.thumbnailBottomOverlayViewModel.badges) ||
      (o.thumbnailOverlayBadgeViewModel && o.thumbnailOverlayBadgeViewModel.thumbnailBadges) || [];
    badges.forEach(b => { if (!badgeText && b.thumbnailBadgeViewModel) badgeText = b.thumbnailBadgeViewModel.text || ''; });
  });
  const avatar = md.image && md.image.decoratedAvatarViewModel && md.image.decoratedAvatarViewModel.avatar &&
    md.image.decoratedAvatarViewModel.avatar.avatarViewModel && lastUrl(md.image.decoratedAvatarViewModel.avatar.avatarViewModel.image);

  if (/PLAYLIST|MIX/.test(ct)) {
    const n = parseInt((badgeText.match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, ''), 10) || 0;
    return {
      id, type: 'playlist', title,
      channelTitle: meta.others.find(s => !/プレイリスト|ミックス|再生リスト/.test(s)) || '',
      thumbnail: { thumbnails: thumbUrl ? [{ url: thumbUrl }] : [] },
      videoCount: n, length: n
    };
  }
  if (ct && !/VIDEO/.test(ct)) return null;
  return {
    id, type: 'video', title,
    channelTitle: meta.others[0] || '',
    channelId: '',
    channelThumbnail: avatar || '',
    viewCountText: meta.views,
    publishedTimeText: meta.date,
    lengthText: /^\d+(:\d+)+$/.test(badgeText) ? badgeText : '',
    length: { simpleText: /^\d+(:\d+)+$/.test(badgeText) ? badgeText : '' },
    thumbnail: thumbOf(id),
    isShort: false
  };
}

function parseChannelRenderer(cr) {
  if (!cr || !cr.channelId) return null;
  const a = txt(cr.videoCountText), b = txt(cr.subscriberCountText);
  const subText = [a, b].find(s => /登録者|subscribers?/i.test(s)) || '';
  const handle = [a, b].find(s => /^@/.test(s)) || '';
  const vc = [a, b].find(s => /本の動画|videos?/i.test(s)) || '';
  return {
    id: cr.channelId, type: 'channel',
    title: txt(cr.title), channelTitle: txt(cr.title),
    thumbnail: { thumbnails: [{ url: lastUrl(cr.thumbnail) }] },
    subCountText: subText, handle,
    videoCountText: vc,
    description: txt(cr.descriptionSnippet)
  };
}

function parsePlaylistRenderer(pr) {
  if (!pr || !pr.playlistId) return null;
  const n = parseInt(String(pr.videoCount || '0').replace(/[^\d]/g, ''), 10) || 0;
  const thumbs = (pr.thumbnails && pr.thumbnails[0] && pr.thumbnails[0].thumbnails) || (pr.thumbnail && pr.thumbnail.thumbnails) || [];
  return {
    id: pr.playlistId, type: 'playlist', title: txt(pr.title),
    channelTitle: txt(pr.longBylineText) || txt(pr.shortBylineText),
    thumbnail: { thumbnails: thumbs.map(t => ({ url: fixUrl(t.url) })) },
    videoCount: n, length: n
  };
}

/**
 * 任意のノード配下を再帰的に走査し、動画/ショート/プレイリスト/チャンネルと
 * 続きトークン(continuation)を集める。
 */
function collectItems(node, out, state) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => collectItems(n, out, state)); return; }
  let parsed = null, handled = false;
  if (node.videoRenderer) { parsed = parseVideoRenderer(node.videoRenderer); handled = true; }
  else if (node.gridVideoRenderer) { parsed = parseVideoRenderer(node.gridVideoRenderer); handled = true; }
  else if (node.compactVideoRenderer) { parsed = parseVideoRenderer(node.compactVideoRenderer); handled = true; }
  else if (node.lockupViewModel) { parsed = parseLockup(node.lockupViewModel); handled = true; }
  else if (node.shortsLockupViewModel) { parsed = parseShortsLockup(node.shortsLockupViewModel); handled = true; }
  else if (node.reelItemRenderer) { parsed = parseReelItem(node.reelItemRenderer); handled = true; }
  else if (node.channelRenderer) { parsed = parseChannelRenderer(node.channelRenderer); handled = true; }
  else if (node.gridChannelRenderer) { handled = true; }
  else if (node.playlistRenderer) { parsed = parsePlaylistRenderer(node.playlistRenderer); handled = true; }
  else if (node.gridPlaylistRenderer) { parsed = parsePlaylistRenderer(node.gridPlaylistRenderer); handled = true; }
  else if (node.continuationItemRenderer) {
    const t = tokenOfContinuation(node.continuationItemRenderer);
    if (t) state.token = t;
    return;
  }
  if (handled) {
    if (parsed && parsed.id && !state.seen.has(parsed.type + ':' + parsed.id)) {
      state.seen.add(parsed.type + ':' + parsed.id);
      out.push(parsed);
    }
    return;
  }
  for (const k of Object.keys(node)) {
    if (k === 'frameworkUpdates' || k === 'responseContext' || k === 'trackingParams') continue;
    collectItems(node[k], out, state);
  }
}

// ───────── 検索 ─────────
const searchState = makeCache(120); // key -> { pages:[], token, seen:Set }

async function fetchSearchPage(st, query, params) {
  let data;
  if (st.token) data = await call('search', { continuation: st.token });
  else data = await call('search', params ? { query, params } : { query });
  const root = data.contents ? data.contents : (data.onResponseReceivedCommands || []);
  const items = [];
  const local = { token: '', seen: st.seen };
  collectItems(root, items, local);
  st.token = local.token || '';
  st.done = !st.token;
  return items;
}

/**
 * ページ番号ベースの検索。続きトークンはクエリごとにサーバー側へ保持し、
 * 必要なページまで順番に取得する。
 * @returns {{items:Array,nextPage:number|null}}
 */
async function search(query, page, params) {
  page = Math.max(0, parseInt(page, 10) || 0);
  const key = query + '|' + (params || '');
  let st = searchState.get(key);
  if (!st) { st = { pages: [], token: '', seen: new Set(), done: false }; searchState.set(key, st, 15 * 60 * 1000); }
  while (st.pages.length <= page) {
    if (st.pages.length > 0 && st.done) break;
    if (st.pending) { await st.pending.catch(() => {}); continue; }
    st.pending = (async () => {
      const items = await fetchSearchPage(st, query, params);
      st.pages.push(items);
    })();
    try { await st.pending; } finally { st.pending = null; }
  }
  const items = st.pages[page] || [];
  const hasMore = (st.pages.length > page + 1) || !st.done;
  return { items, nextPage: hasMore ? page + 1 : null };
}

// ───────── コメント ─────────
function findCommentToken(data) {
  const results = data && data.contents && data.contents.twoColumnWatchNextResults &&
    data.contents.twoColumnWatchNextResults.results && data.contents.twoColumnWatchNextResults.results.results &&
    data.contents.twoColumnWatchNextResults.results.results.contents || [];
  let tok = '';
  for (const c of results) {
    const sec = c.itemSectionRenderer;
    if (!sec) continue;
    const isComment = sec.sectionIdentifier === 'comment-item-section';
    for (const it of (sec.contents || [])) {
      if (it.continuationItemRenderer && (isComment || !tok)) {
        const t = tokenOfContinuation(it.continuationItemRenderer);
        if (t) tok = t;
      }
    }
    if (isComment && tok) return tok;
  }
  return tok;
}

function parseCount(s) {
  if (s == null || s === '') return 0;
  const n = parseInt(String(s).replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function parseCommentsResponse(data) {
  const muts = (data.frameworkUpdates && data.frameworkUpdates.entityBatchUpdate && data.frameworkUpdates.entityBatchUpdate.mutations) || [];
  const ents = new Map(), tstate = new Map();
  muts.forEach(m => {
    const p = m.payload || {};
    if (p.commentEntityPayload) ents.set(p.commentEntityPayload.key, p.commentEntityPayload);
    if (p.engagementToolbarStateEntityPayload) tstate.set(p.engagementToolbarStateEntityPayload.key, p.engagementToolbarStateEntityPayload);
  });

  const eps = data.onResponseReceivedEndpoints || data.onResponseReceivedActions || [];
  const items = [];
  eps.forEach(ep => {
    const cmd = ep.reloadContinuationItemsCommand || ep.appendContinuationItemsAction;
    if (cmd && cmd.continuationItems) items.push(...cmd.continuationItems);
  });

  const result = { commentCount: '', comments: [], continuation: '', sorts: [] };

  const build = (vm, thread) => {
    const ent = ents.get(vm.commentKey);
    if (!ent) return null;
    const props = ent.properties || {}, author = ent.author || {}, tb = ent.toolbar || {};
    const st = tstate.get(props.toolbarStateKey);
    const c = {
      commentId: vm.commentId || props.commentId || '',
      author: author.displayName || '',
      authorId: author.channelId || '',
      authorThumbnails: author.avatarThumbnailUrl ? [{ url: fixUrl(author.avatarThumbnailUrl), width: 88, height: 88 }] : [],
      content: (props.content && props.content.content) || '',
      publishedText: props.publishedTime || '',
      likeCountText: tb.likeCountNotliked || '',
      likeCount: parseCount(tb.likeCountNotliked),
      authorIsChannelOwner: !!author.isCreator,
      isVerified: !!author.isVerified,
      isPinned: !!vm.pinnedText,
      pinnedText: vm.pinnedText || '',
      creatorHeart: (st && st.heartState === 'TOOLBAR_HEART_STATE_HEARTED')
        ? { creatorThumbnail: fixUrl(tb.creatorThumbnailUrl || ''), creatorName: '' } : null
    };
    if (thread) {
      let rc = parseCount(tb.replyCount);
      let cont = '';
      const rr = thread.replies && thread.replies.commentRepliesRenderer;
      if (rr) {
        (rr.contents || []).forEach(x => { if (x.continuationItemRenderer) cont = tokenOfContinuation(x.continuationItemRenderer) || cont; });
        if (!rc && rr.viewReplies && rr.viewReplies.buttonRenderer) rc = parseCount(txt(rr.viewReplies.buttonRenderer.text));
      }
      c.replies = { replyCount: rc, continuation: cont };
    }
    return c;
  };

  items.forEach(it => {
    if (it.commentsHeaderRenderer) {
      const h = it.commentsHeaderRenderer;
      const runs = (h.countText && h.countText.runs) || [];
      if (runs[0] && /^[\d,.]+/.test(runs[0].text)) result.commentCount = runs[0].text;
      const sm = h.sortMenu && h.sortMenu.sortFilterSubMenuRenderer;
      if (sm) {
        result.sorts = (sm.subMenuItems || []).map(s => ({
          title: s.title, selected: !!s.selected,
          token: s.serviceEndpoint && s.serviceEndpoint.continuationCommand && s.serviceEndpoint.continuationCommand.token || ''
        }));
      }
    } else if (it.commentThreadRenderer) {
      const t = it.commentThreadRenderer;
      const vm = t.commentViewModel && t.commentViewModel.commentViewModel;
      const c = vm && build(vm, t);
      if (c) result.comments.push(c);
    } else if (it.commentViewModel) {
      const vm = it.commentViewModel.commentViewModel || it.commentViewModel;
      const c = build(vm, null);
      if (c) result.comments.push(c);
    } else if (it.continuationItemRenderer) {
      result.continuation = tokenOfContinuation(it.continuationItemRenderer) || result.continuation;
    }
  });
  return result;
}

async function getCommentSectionToken(videoId) {
  const key = 'ctok:' + videoId;
  const hit = cache.get(key);
  if (hit) return hit;
  // 稀にコメント欄トークンが含まれないレスポンスが返るため、空の結果はキャッシュせず数回やり直す
  let tok = '';
  for (let i = 0; i < 3 && !tok; i++) {
    const data = await call('next', { videoId });
    tok = findCommentToken(data);
    if (!tok && i < 2) await new Promise(r => setTimeout(r, 250 * (i + 1)));
  }
  if (tok) cache.set(key, tok, 10 * 60 * 1000);
  return tok;
}

/**
 * コメント取得
 * @param {string} videoId
 * @param {{sort?:'top'|'new', continuation?:string}} opts
 */
async function getComments(videoId, opts) {
  opts = opts || {};
  const sort = opts.sort === 'new' ? 'new' : 'top';
  const ckey = 'cm:' + videoId + ':' + sort + ':' + (opts.continuation || '');
  const hit = cache.get(ckey);
  if (hit) return hit;

  let result;
  if (opts.continuation) {
    result = parseCommentsResponse(await call('next', { continuation: opts.continuation }));
  } else {
    const tok = await getCommentSectionToken(videoId);
    if (!tok) {
      result = { commentCount: '', comments: [], continuation: '', sorts: [], disabled: true };
    } else {
      result = parseCommentsResponse(await call('next', { continuation: tok }));
      if (sort === 'new') {
        const s = (result.sorts || []).find(x => !x.selected && x.token) || (result.sorts || [])[1];
        if (s && s.token) {
          const newer = parseCommentsResponse(await call('next', { continuation: s.token }));
          if (newer.comments.length) {
            newer.commentCount = newer.commentCount || result.commentCount;
            newer.sorts = result.sorts;
            result = newer;
          }
        }
      }
    }
  }
  result.sort = sort;
  cache.set(ckey, result, 2 * 60 * 1000);
  return result;
}

async function getReplies(continuation) {
  const ckey = 'rp:' + continuation;
  const hit = cache.get(ckey);
  if (hit) return hit;
  const r = parseCommentsResponse(await call('next', { continuation }));
  cache.set(ckey, r, 2 * 60 * 1000);
  return r;
}

// ───────── 動画ページ情報 / 関連動画 ─────────
function findNode(node, pred, depth) {
  depth = depth || 0;
  if (!node || typeof node !== 'object' || depth > 14) return null;
  if (pred(node)) return node;
  const keys = Array.isArray(node) ? node.keys() : Object.keys(node);
  for (const k of keys) {
    const r = findNode(node[k], pred, depth + 1);
    if (r) return r;
  }
  return null;
}

async function getWatchInfo(videoId) {
  const key = 'watch:' + videoId;
  const hit = cache.get(key);
  if (hit) return hit;
  const data = await call('next', { videoId });
  const res = data.contents && data.contents.twoColumnWatchNextResults;
  if (!res) throw new Error('watch info unavailable');
  const contents = (res.results && res.results.results && res.results.results.contents) || [];
  const primary = (contents.find(c => c.videoPrimaryInfoRenderer) || {}).videoPrimaryInfoRenderer || {};
  const secondary = (contents.find(c => c.videoSecondaryInfoRenderer) || {}).videoSecondaryInfoRenderer || {};
  const owner = (secondary.owner && secondary.owner.videoOwnerRenderer) || {};
  const ownerRun = (owner.title && owner.title.runs && owner.title.runs[0]) || {};
  const browse = (owner.navigationEndpoint && owner.navigationEndpoint.browseEndpoint) || (ownerRun.navigationEndpoint && ownerRun.navigationEndpoint.browseEndpoint) || {};
  const likeBtn = findNode(primary.videoActions || {}, n => n.buttonViewModel && n.buttonViewModel.iconName === 'LIKE');
  const lb = likeBtn && likeBtn.buttonViewModel;
  const vcr = primary.viewCount && primary.viewCount.videoViewCountRenderer;
  const attributed = secondary.attributedDescription && secondary.attributedDescription.content;

  const related = [];
  const sr = (res.secondaryResults && res.secondaryResults.secondaryResults && res.secondaryResults.secondaryResults.results) || [];
  const st = { token: '', seen: new Set([videoId]) };
  collectItems(sr, related, st);

  const info = {
    id: videoId,
    title: txt(primary.title),
    viewCountText: vcr ? txt(vcr.viewCount) : '',
    shortViewCountText: vcr && vcr.shortViewCount ? txt(vcr.shortViewCount) : '',
    dateText: txt(primary.dateText),
    relativeDateText: txt(primary.relativeDateText),
    likeCountText: lb ? (lb.title || '') : '',
    likeCountLabel: lb ? (lb.accessibilityText || '') : '',
    description: attributed || '',
    channelName: ownerRun.text || '',
    channelId: browse.browseId || '',
    channelHandle: (browse.canonicalBaseUrl || '').replace(/^\/(channel\/)?/, ''),
    channelImage: lastUrl(owner.thumbnail),
    subscriberText: txt(owner.subscriberCountText),
    verified: (owner.badges || []).length > 0,
    related: related.filter(r => r.type === 'video').slice(0, 40)
  };
  cache.set(key, info, 5 * 60 * 1000);
  return info;
}

// ───────── チャンネル ─────────
const CHANNEL_ID_RE = /^UC[\w-]{22}$/;

function normName(s) { return String(s || '').toLowerCase().replace(/\s+/g, ''); }

async function resolveChannelId(opts) {
  const id = opts.id, name = String(opts.name || '').trim();
  if (id && CHANNEL_ID_RE.test(id)) return id;
  if (CHANNEL_ID_RE.test(name)) return name;
  const key = 'chid:' + name;
  const hit = cache.get(key);
  if (hit) return hit;
  let found = '';
  if (name.startsWith('@')) {
    try {
      const r = await call('navigation/resolve_url', { url: 'https://www.youtube.com/' + name });
      found = r && r.endpoint && r.endpoint.browseEndpoint && r.endpoint.browseEndpoint.browseId || '';
    } catch (e) { /* 検索へフォールバック */ }
  }
  if (!found) {
    const data = await call('search', { query: name, params: 'EgIQAg%3D%3D' });
    const items = [];
    collectItems(data.contents || {}, items, { token: '', seen: new Set() });
    const chans = items.filter(i => i.type === 'channel');
    const exact = chans.find(c => normName(c.title) === normName(name));
    found = (exact || chans[0] || {}).id || '';
  }
  if (!found) throw new Error('channel not found');
  cache.set(key, found, 6 * 60 * 60 * 1000);
  return found;
}

function findTabParams(tabs, kind) {
  const rx = {
    videos: /^(動画|Videos)$/i,
    shorts: /^(ショート|Shorts)$/i,
    live: /^(ライブ|Live)$/i,
    playlists: /^(再生リスト|Playlists)$/i
  }[kind];
  const t = (tabs || []).find(x => rx && rx.test(x.title));
  return t ? t.params : '';
}

async function getChannel(channelId) {
  const key = 'chinfo:' + channelId;
  const hit = cache.get(key);
  if (hit) return hit;
  const data = await call('browse', { browseId: channelId });
  const hdr = data.header && data.header.pageHeaderRenderer;
  const vm = hdr && hdr.content && hdr.content.pageHeaderViewModel;
  const meta = data.metadata && data.metadata.channelMetadataRenderer || {};
  const tabsRaw = (data.contents && data.contents.twoColumnBrowseResultsRenderer && data.contents.twoColumnBrowseResultsRenderer.tabs) || [];
  const tabs = tabsRaw.map(t => t.tabRenderer).filter(Boolean).map(t => ({
    title: t.title,
    params: t.endpoint && t.endpoint.browseEndpoint && t.endpoint.browseEndpoint.params || ''
  }));

  let title = meta.title || '', handle = '', subscriberText = '', videoCountText = '', avatar = lastUrl(meta.avatar), banner = '', description = meta.description || '';
  let verified = false;
  if (vm) {
    title = (vm.title && vm.title.dynamicTextViewModel && vm.title.dynamicTextViewModel.text && vm.title.dynamicTextViewModel.text.content) || title;
    verified = /CHECK_CIRCLE|AUDIO_BADGE|VERIFIED/.test(JSON.stringify(vm.title || {}));
    const rows = (vm.metadata && vm.metadata.contentMetadataViewModel && vm.metadata.contentMetadataViewModel.metadataRows) || [];
    rows.forEach(r => (r.metadataParts || []).forEach(p => {
      const t = p.text && p.text.content;
      if (!t) return;
      if (/^@/.test(t)) handle = t;
      else if (/登録者|subscribers?/i.test(t)) subscriberText = t.replace(/^チャンネル登録者数\s*/, '');
      else if (/本の動画|videos?/i.test(t)) videoCountText = t;
    }));
    const av = vm.image && vm.image.decoratedAvatarViewModel && vm.image.decoratedAvatarViewModel.avatar &&
      vm.image.decoratedAvatarViewModel.avatar.avatarViewModel && vm.image.decoratedAvatarViewModel.avatar.avatarViewModel.image;
    const avUrl = lastUrl(av);
    if (avUrl) avatar = avUrl.replace(/=s\d+-/, '=s176-');
    banner = lastUrl(vm.banner && vm.banner.imageBannerViewModel && vm.banner.imageBannerViewModel.image);
    const d = vm.description && vm.description.descriptionPreviewViewModel && vm.description.descriptionPreviewViewModel.description;
    if (d && d.content) description = d.content;
  }
  const info = {
    id: channelId, title, handle, subscriberText, videoCountText, avatar, banner, description, verified,
    fullDescription: meta.description || description,
    keywords: meta.keywords || '',
    tabs
  };
  cache.set(key, info, 30 * 60 * 1000);
  return info;
}

/**
 * チャンネルのタブ(動画/ショート/再生リスト/ライブ)を取得
 */
async function getChannelTab(channelId, kind, continuation) {
  const info = await getChannel(channelId);
  let data;
  if (continuation) {
    data = await call('browse', { continuation });
  } else {
    const params = findTabParams(info.tabs, kind);
    if (!params) return { items: [], continuation: '', sorts: [] };
    data = await call('browse', { browseId: channelId, params });
  }
  const items = [];
  const st = { token: '', seen: new Set() };
  let sorts = [];
  if (continuation) {
    collectItems(data.onResponseReceivedActions || data.onResponseReceivedEndpoints || data.onResponseReceivedCommands || [], items, st);
  } else {
    const tabs = (data.contents && data.contents.twoColumnBrowseResultsRenderer && data.contents.twoColumnBrowseResultsRenderer.tabs) || [];
    const sel = tabs.map(t => t.tabRenderer).find(t => t && t.selected) || {};
    collectItems(sel.content || {}, items, st);
    const chips = findNode(sel.content || {}, n => n.chipBarViewModel);
    if (chips) {
      sorts = (chips.chipBarViewModel.chips || []).map(c => c.chipViewModel).filter(Boolean).map(c => ({
        title: c.text, selected: !!c.selected,
        token: c.tapCommand && c.tapCommand.innertubeCommand && c.tapCommand.innertubeCommand.continuationCommand &&
          c.tapCommand.innertubeCommand.continuationCommand.token || ''
      }));
    }
  }
  items.forEach(it => {
    if (it.type === 'video') {
      if (!it.channelTitle) it.channelTitle = info.title;
      if (!it.channelId) it.channelId = channelId;
      if (kind === 'shorts') it.isShort = true;
    }
  });
  return { items, continuation: st.token, sorts };
}

module.exports = {
  call, search, getComments, getReplies, getWatchInfo,
  resolveChannelId, getChannel, getChannelTab,
  CHANNEL_ID_RE
};
