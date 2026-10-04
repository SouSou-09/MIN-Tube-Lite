/* YouTube 風 動画ページ用クライアント: コメント / 返信 / 関連動画
 * window.__WATCH = { videoId, channel, title } を事前に定義しておくこと */
(function () {
  'use strict';
  var W = window.__WATCH || {};
  var VIDEO_ID = W.videoId;

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function linkify(text) {
    var e = esc(text);
    e = e.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    // 0:00 / 1:23:45 形式のタイムスタンプ (表示のみ強調)
    e = e.replace(/(^|[\s(])(\d{1,2}:\d{2}(?::\d{2})?)(?=$|[\s).,、。])/g, '$1<span class="cm-ts">$2</span>');
    return e;
  }
  function avatarOf(c, size) {
    var t = c && c.authorThumbnails;
    if (t && t.length && t[0].url) return t[0].url;
    return 'https://ui-avatars.com/api/?name=' + encodeURIComponent((c && c.author) || 'U') + '&background=555&color=fff&size=' + (size * 2) + '&bold=true';
  }
  function fallbackAvatar(img) {
    img.onerror = null;
    img.src = 'https://ui-avatars.com/api/?name=U&background=555&color=fff&size=80';
  }
  window.__ytAvatarFallback = fallbackAvatar;

  /* ---------------- コメント ---------------- */
  var state = { sort: 'top', continuation: '', loading: false, done: false, started: false, items: {} };

  function renderComment(c, isReply) {
    var avatar = avatarOf(c, isReply ? 24 : 40);
    var id = c.commentId || '';
    state.items[id] = c;
    var h = '<div class="' + (isReply ? 'reply-item' : 'comment-item') + '" data-comment-id="' + esc(id) + '">';
    h += '<a class="cm-avatar-link" href="' + (c.authorId ? '/channel/' + encodeURIComponent(c.authorId) : '#') + '"><img class="' + (isReply ? 'reply-avatar' : 'comment-avatar') + '" src="' + esc(avatar) + '" loading="lazy" referrerpolicy="no-referrer" onerror="__ytAvatarFallback(this)"></a>';
    h += '<div class="comment-body">';
    if (c.isPinned && !isReply) {
      h += '<div class="comment-pinned"><i class="fas fa-thumbtack"></i> ' + esc(c.pinnedText || '固定されたコメント') + '</div>';
    }
    h += '<div class="comment-meta-row">';
    h += '<a class="comment-author' + (c.authorIsChannelOwner ? ' is-creator' : '') + '" href="' + (c.authorId ? '/channel/' + encodeURIComponent(c.authorId) : '#') + '">' + esc(c.author || '匿名') + '</a>';
    if (c.isVerified) h += '<i class="fas fa-check-circle cm-verified" title="認証済み"></i>';
    if (c.publishedText) h += '<span class="comment-time">' + esc(c.publishedText) + '</span>';
    h += '</div>';
    h += '<div class="comment-content">' + linkify(c.content || '') + '</div>';
    h += '<div class="comment-actions">';
    h += '<button class="comment-action-btn" onclick="toggleCommentLike(this)" title="高評価"><i class="far fa-thumbs-up"></i><span class="comment-likes">' + esc(c.likeCountText || '') + '</span></button>';
    h += '<button class="comment-action-btn" onclick="toggleCommentLike(this, true)" title="低評価"><i class="far fa-thumbs-down"></i></button>';
    if (c.creatorHeart) {
      h += '<span class="cm-heart" title="投稿者がハートを付けました">' +
        (c.creatorHeart.creatorThumbnail ? '<img src="' + esc(c.creatorHeart.creatorThumbnail) + '" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">' : '') +
        '<i class="fas fa-heart"></i></span>';
    }
    h += '</div>';
    var rc = c.replies && c.replies.replyCount;
    var rcont = c.replies && c.replies.continuation;
    if (!isReply && (rc > 0 || rcont)) {
      h += '<button class="replies-toggle" data-cont="' + esc(rcont || '') + '" onclick="toggleReplies(this)">';
      h += '<i class="fas fa-caret-down"></i><span>' + (rc ? rc + ' 件の返信' : '返信') + '</span></button>';
      h += '<div class="replies-container" data-loaded="0"></div>';
    }
    h += '</div></div>';
    return h;
  }

  function setCount(v) {
    var el = document.getElementById('commentCountLabel');
    if (el && v) el.textContent = v;
  }

  function showEmpty(msg) {
    var list = document.getElementById('commentsList');
    if (list && !list.children.length) {
      list.innerHTML = '<div class="comments-empty"><i class="far fa-comment-dots"></i>' + esc(msg) + '</div>';
    }
  }

  function setMoreBtn(show, loading) {
    var wrap = document.getElementById('commentsMore');
    if (!wrap) return;
    wrap.style.display = show ? 'block' : 'none';
    wrap.innerHTML = loading
      ? '<div class="reply-loading"><div class="mini-spinner"></div>読み込み中...</div>'
      : '<button class="comments-load-more" onclick="loadMoreComments()">さらにコメントを表示</button>';
  }

  async function fetchComments(reset) {
    if (state.loading) return;
    if (reset) {
      state.continuation = ''; state.done = false;
      var l = document.getElementById('commentsList');
      if (l) l.innerHTML = '<div class="reply-loading" style="padding:24px 0"><div class="mini-spinner"></div>コメントを読み込み中...</div>';
      setMoreBtn(false);
    }
    if (state.done) return;
    state.loading = true;
    var url = '/api/comments/' + encodeURIComponent(VIDEO_ID) + '?sort=' + state.sort +
      (state.continuation ? '&continuation=' + encodeURIComponent(state.continuation) : '');
    var attempt = 0, data = null;
    while (attempt < 2 && !data) {
      try {
        var r = await fetch(url);
        var j = await r.json();
        if (r.ok && j && Array.isArray(j.comments)) data = j;
      } catch (e) { /* retry */ }
      attempt++;
    }
    state.loading = false;
    var list = document.getElementById('commentsList');
    if (!list) return;
    if (reset) list.innerHTML = '';
    if (!data) {
      if (reset) list.innerHTML = '';
      list.insertAdjacentHTML('beforeend', '<div class="comments-empty" style="color:#ff6b6b">コメントを取得できませんでした。<button class="comments-load-more" onclick="fetchCommentsRetry()">再試行</button></div>');
      return;
    }
    if (data.commentCount) setCount(data.commentCount);
    if (data.disabled) {
      var cl = document.getElementById('commentCountLabel');
      if (cl && cl.parentElement) cl.parentElement.innerHTML = 'コメントは無効になっています';
      showEmpty('この動画ではコメントが無効になっています');
      state.done = true; setMoreBtn(false); return;
    }
    list.insertAdjacentHTML('beforeend', data.comments.map(function (c) { return renderComment(c, false); }).join(''));
    state.continuation = data.continuation || '';
    state.done = !state.continuation;
    if (!data.comments.length) showEmpty('コメントはまだありません');
    setMoreBtn(!state.done, false);
  }
  window.fetchCommentsRetry = function () { fetchComments(true); };

  window.loadMoreComments = async function () {
    if (state.loading || state.done) return;
    setMoreBtn(true, true);
    await fetchComments(false);
  };

  window.renderComments = function () {
    if (state.started) return;
    state.started = true;
    fetchComments(true);
    // 画面下端に近づいたら自動で続きを読み込む
    var sent = document.getElementById('commentsMore');
    if ('IntersectionObserver' in window && sent) {
      new IntersectionObserver(function (es) {
        if (es[0].isIntersecting && !state.loading && !state.done && state.started) window.loadMoreComments();
      }, { rootMargin: '300px' }).observe(sent);
    }
  };

  window.toggleSortMenu = function (e) {
    if (e) e.stopPropagation();
    var m = document.getElementById('sortMenu');
    if (m) m.classList.toggle('show');
  };
  document.addEventListener('click', function () {
    var m = document.getElementById('sortMenu');
    if (m) m.classList.remove('show');
  });
  window.setCommentSort = function (mode) {
    var m = document.getElementById('sortMenu');
    if (m) m.classList.remove('show');
    if (state.sort === mode) return;
    state.sort = mode;
    var label = document.getElementById('commentsSortLabel');
    if (label) label.textContent = mode === 'top' ? '高評価順' : '新しい順';
    document.querySelectorAll('#sortMenu [data-sort]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-sort') === mode);
    });
    fetchComments(true);
  };
  // 旧UI互換
  window.toggleCommentSort = function () { window.setCommentSort(state.sort === 'top' ? 'new' : 'top'); };

  window.toggleCommentLike = function (btn, isDown) {
    var icon = btn.querySelector('i');
    var active = btn.classList.toggle('active');
    if (icon) { icon.classList.toggle('fas', active); icon.classList.toggle('far', !active); }
    if (!isDown) {
      var sib = btn.parentElement.querySelector('.comment-action-btn:nth-child(2)');
      if (active && sib && sib.classList.contains('active')) { sib.classList.remove('active'); var si = sib.querySelector('i'); if (si) { si.classList.remove('fas'); si.classList.add('far'); } }
    }
  };

  /* ---------------- 返信 ---------------- */
  async function loadReplies(container, cont, btn) {
    var more = container.querySelector('.replies-more');
    if (more) more.remove();
    container.insertAdjacentHTML('beforeend', '<div class="reply-loading"><div class="mini-spinner"></div>返信を読み込み中...</div>');
    var spinner = container.lastElementChild;
    try {
      var r = await fetch('/api/comments-reply/' + encodeURIComponent(VIDEO_ID) + '?continuation=' + encodeURIComponent(cont));
      var data = await r.json();
      if (!r.ok || !Array.isArray(data.comments)) throw new Error('bad');
      spinner.remove();
      container.insertAdjacentHTML('beforeend', data.comments.map(function (c) { return renderComment(c, true); }).join(''));
      if (data.continuation) {
        container.insertAdjacentHTML('beforeend', '<button class="replies-toggle replies-more" data-cont="' + esc(data.continuation) + '"><i class="fas fa-arrow-turn-down"></i><span>さらに返信を表示</span></button>');
        container.lastElementChild.addEventListener('click', function () { loadReplies(container, data.continuation, btn); });
      } else if (!data.comments.length && !container.querySelector('.reply-item')) {
        container.innerHTML = '<div class="reply-loading">返信はありません</div>';
      }
      container.dataset.loaded = '1';
    } catch (e) {
      spinner.remove();
      container.insertAdjacentHTML('beforeend', '<div class="reply-loading" style="color:#ff6b6b">返信の取得に失敗しました <button class="replies-toggle" style="padding:2px 8px">再試行</button></div>');
      container.lastElementChild.querySelector('button').addEventListener('click', function () {
        container.innerHTML = ''; loadReplies(container, cont, btn);
      });
    }
  }
  window.toggleReplies = function (btn) {
    var container = btn.parentElement.querySelector('.replies-container');
    if (!container) return;
    var open = container.classList.toggle('open');
    btn.classList.toggle('open', open);
    var label = btn.querySelector('span');
    var icon = btn.querySelector('i');
    if (icon) icon.className = open ? 'fas fa-caret-up' : 'fas fa-caret-down';
    if (label) label.textContent = label.textContent.replace(/^(\d+) 件の返信.*$/, function (m, n) { return n + ' 件の返信'; });
    if (open && container.dataset.loaded !== '1' && !container.dataset.busy) {
      var cont = btn.getAttribute('data-cont');
      if (!cont) { container.innerHTML = '<div class="reply-loading">返信を取得できません</div>'; container.dataset.loaded = '1'; return; }
      container.dataset.busy = '1';
      loadReplies(container, cont, btn).then(function () { delete container.dataset.busy; });
    }
  };

  /* ---------------- 関連動画 ---------------- */
  function recHtml(it) {
    var meta = [];
    if (it.viewCountText) meta.push(esc(it.viewCountText));
    if (it.publishedTimeText) meta.push(esc(it.publishedTimeText));
    return '<a href="/video/' + esc(it.id) + '" class="rec-item">' +
      '<div class="rec-thumb"><img src="https://i.ytimg.com/vi/' + esc(it.id) + '/mqdefault.jpg" loading="lazy" alt="">' +
      (it.isLive ? '<span class="rec-badge live">ライブ</span>' : (it.lengthText ? '<span class="rec-badge">' + esc(it.lengthText) + '</span>' : '')) + '</div>' +
      '<div class="rec-info"><div class="rec-title">' + esc(it.title) + '</div>' +
      '<div class="rec-meta rec-ch">' + esc(it.channelTitle || '') + '</div>' +
      '<div class="rec-meta">' + meta.join(' • ') + '</div></div></a>';
  }
  function shortHtml(it) {
    return '<a href="/video/' + esc(it.id) + '" class="short-card"><div class="short-thumb"><img src="https://i.ytimg.com/vi/' + esc(it.id) + '/hq720.jpg" loading="lazy" onerror="this.src=\'https://i.ytimg.com/vi/' + esc(it.id) + '/mqdefault.jpg\'"></div>' +
      '<div class="short-info"><div class="short-title">' + esc(it.title) + '</div><div class="short-views">' + esc(it.viewCountText || '') + '</div></div></a>';
  }

  var recItems = [], recShorts = [], recFilter = 'all';
  function renderRecs() {
    var box = document.getElementById('recommendations');
    if (!box) return;
    var list = recItems;
    if (recFilter === 'channel') list = recItems.filter(function (i) { return i.channelTitle && W.channel && i.channelTitle === W.channel; });
    box.innerHTML = list.map(recHtml).join('') || '<div class="comments-empty" style="padding:16px 0">該当する動画はありません</div>';
  }
  window.setRecFilter = function (f) {
    recFilter = f;
    document.querySelectorAll('#recChips .rec-chip').forEach(function (c) { c.classList.toggle('active', c.getAttribute('data-f') === f); });
    renderRecs();
  };

  window.loadRecommendations = async function () {
    var items = [];
    try {
      var r = await fetch('/api/related/' + encodeURIComponent(VIDEO_ID));
      var j = await r.json();
      items = j.items || [];
      if (j.info) window.__watchInfo = j.info;
    } catch (e) {}
    if (!items.length) {
      try {
        var p = new URLSearchParams({ title: W.title || '', channel: W.channel || '', id: VIDEO_ID });
        var r2 = await fetch('/api/recommendations?' + p.toString());
        var j2 = await r2.json();
        items = (j2.items || []).filter(function (i) { return i && i.id && i.title; });
      } catch (e) {}
    }
    recShorts = items.filter(function (i) { return i.isShort || /#shorts?\b/i.test(i.title || ''); });
    recItems = items.filter(function (i) { return recShorts.indexOf(i) < 0 && i.id !== VIDEO_ID; });
    if (recItems.length) window.__nextVideo = recItems[0];
    renderRecs();
    if (recShorts.length) {
      var shelf = document.getElementById('shortsShelf');
      var grid = document.getElementById('shortsGrid');
      if (shelf && grid) { shelf.style.display = 'block'; grid.innerHTML = recShorts.slice(0, 6).map(shortHtml).join(''); }
    }
  };
})();
